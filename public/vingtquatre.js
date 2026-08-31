// Client du 24. La particularité par rapport aux trois autres jeux : ici
// personne n'attend son tour. Tout le monde voit les mêmes quatre cartes en
// même temps et cherche DE TÊTE — rien n'est manipulable tant qu'on n'a pas
// appuyé sur « J'ai ! ». Celui qui appuie le premier prend la main, seul, et
// dispose alors d'une courte fenêtre pour montrer sa combinaison en
// fusionnant les cartes.
//
// Pendant cette fenêtre, les fusions sont entièrement LOCALES : elles ne
// passent pas par le serveur, sinon chaque clic coûterait un aller-retour
// réseau et la manipulation serait molle. Le serveur n'entre en scène qu'au
// moment où le plateau retombe sur 24 : on lui envoie la suite des trois
// opérations, il la rejoue, et c'est lui qui tranche (voir rejouerEtapes dans
// server/vingtquatre.js).

const socket = io();

const ACTIVE_ROOM_KEY = 'vingtquatre:activeRoom';
function saveActiveRoom(code, nickname) {
  sessionStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify({ code, nickname }));
}
function loadActiveRoom() {
  try {
    return JSON.parse(sessionStorage.getItem(ACTIVE_ROOM_KEY));
  } catch {
    return null;
  }
}
function clearActiveRoom() {
  sessionStorage.removeItem(ACTIVE_ROOM_KEY);
}

const SUIT_SYMBOL = { coeur: '♥', carreau: '♦', trefle: '♣', pique: '♠' };
const NOM_COULEUR = { coeur: 'cœur', carreau: 'carreau', trefle: 'trèfle', pique: 'pique' };
const OP_SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷' };

// Les mêmes fractions exactes que côté serveur : c'est ce qui permet
// d'afficher « 8/3 » plutôt que « 2.6666666666666665 », et de reconnaître un
// vrai 24 sans marge d'erreur. Les deux implémentations doivent rester
// d'accord — le serveur revalide tout, un désaccord se verrait donc comme un
// refus inexplicable côté joueur.
function pgcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}
function frac(n, d = 1) {
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = pgcd(n, d);
  return { n: n / g, d: d / g };
}
const CALCULS = {
  '+': (x, y) => frac(x.n * y.d + y.n * x.d, x.d * y.d),
  '-': (x, y) => frac(x.n * y.d - y.n * x.d, x.d * y.d),
  '*': (x, y) => frac(x.n * y.n, x.d * y.d),
  '/': (x, y) => (y.n === 0 ? null : frac(x.n * y.d, x.d * y.n)),
};
function texteFraction(x) {
  return x.d === 1 ? String(x.n) : `${x.n}/${x.d}`;
}

// Les formules viennent du serveur avec les signes du code (* et /) : on les
// repasse en signes de mathématiques pour l'affichage.
function jolieFormule(formule) {
  return String(formule || '').replace(/[*/-]/g, (c) => OP_SYMBOL[c] || c);
}

const screens = {
  home: document.getElementById('v24-screen-home'),
  waiting: document.getElementById('v24-screen-waiting'),
  game: document.getElementById('v24-screen-game'),
  end: document.getElementById('v24-screen-end'),
};
const appEl = document.querySelector('.v24-app');

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
  // L'écran de jeu est le seul à s'étaler : la donne se lit en paysage, les
  // écrans d'accueil et de salon restent une colonne étroite (même parti pris
  // que le Rami, cf. .rami-app--game).
  appEl.classList.toggle('v24-app--game', name === 'game');
}

const toastEl = document.getElementById('v24-toast');
let toastTimer = null;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

const reconnectOverlay = document.getElementById('reconnect-overlay');

// L'hébergement gratuit met jusqu'à ~25 s à se réveiller : sans ce message la
// page a juste l'air cassée le temps que le socket se connecte.
let hasConnectedOnce = false;
if (!socket.connected) {
  reconnectOverlay.textContent = "🌙 Réveil du serveur… (jusqu'à 25s au premier chargement)";
  reconnectOverlay.classList.remove('hidden');
}
socket.on('connect', () => {
  if (hasConnectedOnce) return;
  hasConnectedOnce = true;
  reconnectOverlay.classList.add('hidden');
  reconnectOverlay.textContent = '🔌 Connexion perdue — reconnexion en cours…';
});

function showReconnectingOverlay(show) {
  reconnectOverlay.classList.toggle('hidden', !show);
}

const disconnectBanner = document.getElementById('v24-disconnect-banner');
const awayPlayers = new Map(); // id -> pseudo
function renderDisconnectBanner() {
  const away = [...awayPlayers.values()];
  if (away.length === 0) {
    disconnectBanner.classList.add('hidden');
    return;
  }
  const verbe = away.length > 1 ? 'ont perdu la connexion' : 'a perdu la connexion';
  // Contrairement aux jeux de plis, la partie n'est PAS en attente : la
  // course continue sans lui, il reprend au vol quand il revient.
  disconnectBanner.textContent = `🔌 ${away.join(', ')} ${verbe} — les manches continuent sans ${away.length > 1 ? 'eux' : 'lui'}.`;
  disconnectBanner.classList.remove('hidden');
}
function syncAwayPlayersFromState(state) {
  awayPlayers.clear();
  (state.scoreboard || []).forEach((p) => {
    if (!p.connected && p.id !== myId) awayPlayers.set(p.id, p.nickname);
  });
  renderDisconnectBanner();
}

// --- Accueil ---

const inputNickname = document.getElementById('v24-input-nickname');
const homeError = document.getElementById('v24-home-error');
const btnCreate = document.getElementById('v24-btn-create');
const formJoin = document.getElementById('v24-form-join');
const inputCode = document.getElementById('v24-input-code');
const rulesModal = document.getElementById('v24-rules-modal');

let myNickname = null;
let myId = null;
let myIsHost = false;
let rejoinFallback = null;
let latestState = null;

function requireNickname() {
  const value = inputNickname.value.trim();
  if (!value) {
    homeError.textContent = 'Entre un pseudo avant de continuer.';
    inputNickname.focus();
    return null;
  }
  return value;
}

const btnCreateDefaultLabel = btnCreate.innerHTML;
function setCreateBusy(busy, label) {
  btnCreate.disabled = busy;
  btnCreate.innerHTML = busy ? label : btnCreateDefaultLabel;
}
if (!socket.connected) setCreateBusy(true, '⏳ Connexion au serveur…');
socket.on('connect', () => setCreateBusy(false));
socket.on('disconnect', () => setCreateBusy(true, '⏳ Connexion au serveur…'));

btnCreate.addEventListener('click', () => {
  const nickname = requireNickname();
  if (!nickname) return;
  homeError.textContent = '';
  myNickname = nickname;
  setCreateBusy(true, '⏳ Création…');
  socket.emit('vingtquatre-create-room', { nickname, token: getPlayerToken() });
});

formJoin.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = inputCode.value.trim().toUpperCase();
  const nickname = requireNickname();
  if (!nickname) return;
  if (!code) {
    homeError.textContent = 'Entre un code de partie.';
    return;
  }
  homeError.textContent = '';
  myNickname = nickname;

  const saved = loadActiveRoom();
  if (saved && saved.code === code) {
    rejoinFallback = { code, nickname };
    showReconnectingOverlay(true);
    socket.emit('vingtquatre-rejoin-room', { code, token: getPlayerToken() });
    return;
  }
  socket.emit('vingtquatre-join-room', { code, nickname, token: getPlayerToken() });
});

document.getElementById('v24-btn-rules').addEventListener('click', () => rulesModal.classList.remove('hidden'));
document.getElementById('v24-btn-close-rules').addEventListener('click', () => rulesModal.classList.add('hidden'));

// --- Salon d'attente ---

const shareBlock = document.getElementById('v24-share-block');
const shareLink = document.getElementById('v24-share-link');
const shareCode = document.getElementById('v24-share-code');
const btnCopy = document.getElementById('v24-btn-copy');
const lobbyPlayers = document.getElementById('v24-lobby-players');
const lobbyList = document.getElementById('v24-lobby-list');
const lobbyCount = document.getElementById('v24-lobby-count');
const btnStartGame = document.getElementById('v24-btn-start-game');
const waitingHint = document.getElementById('v24-waiting-hint');

const joinModal = document.getElementById('v24-join-modal');
const joinModalNickname = document.getElementById('v24-join-modal-nickname');
const btnJoinModal = document.getElementById('v24-btn-join-modal');
const joinModalError = document.getElementById('v24-join-modal-error');

function goHome() {
  clearActiveRoom();
  socket.emit('vingtquatre-leave-room');
  stopChrono();
  stopExplainCountdown();
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);
  joinModal.classList.add('hidden');
  hideReveal();
  inputNickname.value = '';
  showScreen('home');
}

document.getElementById('v24-btn-leave-waiting').addEventListener('click', goHome);
document.getElementById('v24-btn-leave-game').addEventListener('click', goHome);
document.getElementById('v24-btn-leave-end').addEventListener('click', goHome);

const copyDefaultLabel = btnCopy.innerHTML;
btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareLink.value);
    btnCopy.textContent = '✅ Copié !';
    setTimeout(() => (btnCopy.innerHTML = copyDefaultLabel), 1500);
  } catch {
    shareLink.select();
  }
});

socket.on('vingtquatre-room-created', ({ code }) => {
  setCreateBusy(false);
  saveActiveRoom(code, myNickname);
  shareLink.value = `${window.location.protocol}//${window.location.host}/vingtquatre.html?room=${code}`;
  shareCode.textContent = code;
  shareBlock.classList.remove('hidden');
});

socket.on('vingtquatre-lobby-update', ({ code, players, hostId, isHost, canStart, minPlayers, maxPlayers }) => {
  saveActiveRoom(code, myNickname);
  showReconnectingOverlay(false);
  myIsHost = isHost;
  showScreen('waiting');
  hideReveal();
  joinModal.classList.add('hidden');
  lobbyPlayers.classList.remove('hidden');
  lobbyList.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.nickname;
    if (p.id === hostId) li.classList.add('lobby-host');
    lobbyList.appendChild(li);
  });
  lobbyCount.textContent = players.length;

  btnStartGame.classList.toggle('hidden', !isHost);
  btnStartGame.disabled = !canStart;
  if (isHost) {
    waitingHint.textContent = canStart
      ? `Prêt ! Lance la partie quand tu veux (jusqu'à ${maxPlayers} joueurs).`
      : `Il faut au moins ${minPlayers} joueurs pour commencer…`;
  } else {
    waitingHint.textContent = "En attente que l'hôte lance la partie…";
  }
});

socket.on('vingtquatre-error', (message) => {
  setCreateBusy(false);
  if (!joinModal.classList.contains('hidden')) {
    joinModalError.textContent = message;
    btnJoinModal.disabled = false;
    return;
  }
  if (!screens.home.classList.contains('hidden')) {
    homeError.textContent = message;
    return;
  }
  showToast(message);
});

socket.on('vingtquatre-player-left', ({ nickname }) => showToast(`${nickname} a quitté la partie.`));

btnStartGame.addEventListener('click', () => socket.emit('vingtquatre-start-game'));

btnJoinModal.addEventListener('click', () => {
  const nickname = joinModalNickname.value.trim().slice(0, 16);
  if (!nickname) {
    joinModalError.textContent = 'Entre un pseudo avant de continuer.';
    return;
  }
  joinModalError.textContent = '';
  btnJoinModal.disabled = true;
  myNickname = nickname;
  socket.emit('vingtquatre-join-room', { code: roomFromUrl.toUpperCase(), nickname, token: getPlayerToken() });
});

// --- Le plateau : la mécanique de fusion ---------------------------------
//
// `plateau.items` est ce qui reste sur la table : au début les quatre cartes,
// puis de moins en moins à mesure qu'on les combine. Fusionner A et B, c'est
// les retirer tous les deux et poser à leur place une seule tuile qui porte
// le résultat. Trois fusions, il n'en reste qu'une : si elle vaut 24, gagné.
//
// Le plateau n'est manipulable QUE par celui qui a la main (voir le buzzer
// plus bas). Pour tous les autres, les tuiles sont là pour être regardées et
// calculées de tête, pas touchées.
//
// `plateau.etapes` est la trace envoyée au serveur. Les identifiants suivent
// la convention partagée avec lui : cartes `c0..c3`, résultats `r0`, `r1`,
// `r2` dans l'ordre des fusions (voir server/vingtquatre.js).

const boardEl = document.getElementById('v24-board');
const expressionEl = document.getElementById('v24-expression');
const feedbackEl = document.getElementById('v24-feedback');
const operatorsEl = document.getElementById('v24-operators');
const btnUndo = document.getElementById('v24-btn-undo');
const btnReset = document.getElementById('v24-btn-reset');
const btnPass = document.getElementById('v24-btn-pass');
const btnBuzz = document.getElementById('v24-btn-buzz');
const buzzZone = document.getElementById('v24-buzz-zone');
const buzzStatus = document.getElementById('v24-buzz-status');
const explainZone = document.getElementById('v24-explain-zone');
const explainTimerEl = document.getElementById('v24-explain-timer');

const CIBLE = 24;
let plateau = null;
let manchAffichee = null; // numéro de manche actuellement posé sur le plateau
let jExpliquaisAvant = false; // pour repérer le moment où je prends/rends la main

function itemDeCarte(carte) {
  return {
    id: carte.id,
    valeur: frac(carte.value),
    carte, // gardée pour l'affichage : rang + couleur
    // Le texte sert à reconstituer la formule sous le plateau ; les
    // parenthèses suivent les mêmes règles que côté serveur.
    texte: String(carte.value),
    prec: 3,
  };
}

function nouveauPlateau(cartes) {
  return {
    initial: cartes.map(itemDeCarte),
    items: cartes.map(itemDeCarte),
    etapes: [],
    historique: [],
    verrouille: true, // fermé par défaut : il faut avoir buzzé pour y toucher
    envoye: false,
  };
}

let selection = null; // id de l'item choisi en premier
let opArme = null; // opération choisie, en attente du second item

function snapshot() {
  return {
    items: plateau.items.map((i) => ({ ...i })),
    etapes: plateau.etapes.map((e) => ({ ...e })),
  };
}

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 };

// Même règle de parenthésage que le serveur : on n'en pose que là où elles
// changent le sens, pour que la formule affichée reste lisible.
function texteFusion(a, b, op) {
  const prec = PREC[op];
  const gauche = a.prec < prec ? `(${a.texte})` : a.texte;
  const droite = b.prec < prec || (b.prec === prec && (op === '-' || op === '/')) ? `(${b.texte})` : b.texte;
  return `${gauche} ${OP_SYMBOL[op]} ${droite}`;
}

function fusionner(idA, idB, op) {
  const iA = plateau.items.findIndex((i) => i.id === idA);
  const iB = plateau.items.findIndex((i) => i.id === idB);
  if (iA === -1 || iB === -1 || iA === iB) return;

  const a = plateau.items[iA];
  const b = plateau.items[iB];
  const valeur = CALCULS[op](a.valeur, b.valeur);
  if (valeur === null) {
    montrerFeedback('Division par zéro impossible — essaie autrement.', 'erreur');
    opArme = null;
    renderBoard();
    return;
  }

  plateau.historique.push(snapshot());
  const resultat = {
    id: `r${plateau.etapes.length}`,
    valeur,
    carte: null,
    texte: texteFusion(a, b, op),
    prec: PREC[op],
    neuf: true, // pour l'animation d'apparition, retirée au rendu suivant
  };
  plateau.etapes.push({ a: idA, b: idB, op });
  // Le résultat prend la place de la PREMIÈRE carte choisie : les tuiles ne
  // sautent pas d'un bout à l'autre du plateau entre deux opérations.
  plateau.items.splice(iB, 1);
  plateau.items.splice(iA > iB ? iA - 1 : iA, 1, resultat);

  selection = null;
  opArme = null;

  if (plateau.items.length === 1) conclure();
  renderBoard();
}

function conclure() {
  const final = plateau.items[0];
  if (final.valeur.d === 1 && final.valeur.n === CIBLE) {
    plateau.verrouille = true;
    plateau.envoye = true;
    montrerFeedback('🎉 24 ! Envoi…', 'succes');
    socket.emit('vingtquatre-solve', { etapes: plateau.etapes });
    return;
  }
  // Pas éliminé pour autant : dans sa fenêtre, on a le droit de se reprendre.
  // C'est l'expiration de la fenêtre qui sanctionne, côté serveur.
  montrerFeedback(`Ça fait ${texteFraction(final.valeur)}, pas 24. Reprends vite !`, 'erreur');
  boardEl.classList.remove('v24-board--shake');
  void boardEl.offsetWidth; // relance l'animation même si elle vient de jouer
  boardEl.classList.add('v24-board--shake');
}

function annuler() {
  if (plateau.verrouille || plateau.historique.length === 0) return;
  const precedent = plateau.historique.pop();
  plateau.items = precedent.items;
  plateau.etapes = precedent.etapes;
  selection = null;
  opArme = null;
  montrerFeedback('', null);
  renderBoard();
}

function toutRefaire() {
  if (plateau.verrouille) return;
  plateau.items = plateau.initial.map((i) => ({ ...i }));
  plateau.etapes = [];
  plateau.historique = [];
  selection = null;
  opArme = null;
  montrerFeedback('', null);
  renderBoard();
}

function montrerFeedback(texte, ton) {
  feedbackEl.textContent = texte;
  feedbackEl.classList.toggle('v24-feedback--erreur', ton === 'erreur');
  feedbackEl.classList.toggle('v24-feedback--succes', ton === 'succes');
}

function choisirItem(id) {
  if (plateau.verrouille) return;
  if (selection === null) {
    selection = id;
    montrerFeedback('', null);
  } else if (selection === id) {
    selection = null;
    opArme = null;
  } else if (opArme === null) {
    // Pas encore d'opération choisie : on change simplement d'avis sur la
    // première carte plutôt que de refuser le clic.
    selection = id;
  } else {
    fusionner(selection, id, opArme);
    return;
  }
  renderBoard();
}

function choisirOperation(op) {
  if (plateau.verrouille) return;
  if (selection === null) {
    montrerFeedback('Choisis d’abord une carte, puis l’opération.', null);
    return;
  }
  opArme = opArme === op ? null : op;
  renderBoard();
}

function renderBoard() {
  boardEl.classList.toggle('v24-board--actif', !plateau.verrouille);
  boardEl.replaceChildren();
  plateau.items.forEach((item, index) => {
    const tuile = document.createElement('button');
    tuile.type = 'button';
    tuile.className = 'v24-tile' + (item.carte ? ' v24-tile--carte' : ' v24-tile--resultat');
    if (item.carte) {
      tuile.classList.add(cardColorClass(item.carte));
    }
    if (item.id === selection) tuile.classList.add('v24-tile--choisie');
    if (item.neuf) {
      tuile.classList.add('v24-tile--neuve');
      delete item.neuf;
    }
    tuile.disabled = plateau.verrouille;
    // Nom accessible : le contenu de la tuile est un empilement de <span>
    // (valeur, couleur, rang, numéro de raccourci) qui, lu à voix haute, ne
    // veut rien dire. On énonce la carte comme on la nommerait à table.
    tuile.setAttribute(
      'aria-label',
      item.carte ? `${item.carte.label} de ${NOM_COULEUR[item.carte.suit]}` : `résultat ${texteFraction(item.valeur)}`
    );
    tuile.setAttribute('aria-pressed', String(item.id === selection));

    const valeurEl = document.createElement('span');
    valeurEl.className = 'v24-tile-valeur';
    const texte = texteFraction(item.valeur);
    valeurEl.textContent = texte;
    if (texte.length > 3) valeurEl.classList.add('v24-tile-valeur--longue');
    tuile.appendChild(valeurEl);

    if (item.carte) {
      const coin = document.createElement('span');
      coin.className = 'v24-tile-suit';
      coin.textContent = SUIT_SYMBOL[item.carte.suit];
      tuile.appendChild(coin);
      const rang = document.createElement('span');
      rang.className = 'v24-tile-rang';
      rang.textContent = item.carte.label;
      tuile.appendChild(rang);
    }

    const raccourci = document.createElement('span');
    raccourci.className = 'v24-tile-index';
    raccourci.textContent = index + 1;
    tuile.appendChild(raccourci);

    tuile.addEventListener('click', () => choisirItem(item.id));
    boardEl.appendChild(tuile);
  });

  [...operatorsEl.querySelectorAll('.v24-op')].forEach((b) => {
    b.classList.toggle('v24-op--armee', b.dataset.op === opArme);
    b.disabled = plateau.verrouille;
  });

  btnUndo.disabled = plateau.verrouille || plateau.historique.length === 0;
  btnReset.disabled = plateau.verrouille || plateau.etapes.length === 0;

  // La formule en cours, sous le plateau : c'est elle qu'on relit pour
  // comprendre où on en est, surtout après trois fusions.
  const enCours = plateau.items.filter((i) => !i.carte).map((i) => i.texte);
  expressionEl.textContent = enCours.length ? enCours.join('   ·   ') : '';
}

boardEl.addEventListener('animationend', () => boardEl.classList.remove('v24-board--shake'));

operatorsEl.addEventListener('click', (e) => {
  const bouton = e.target.closest('.v24-op');
  if (bouton) choisirOperation(bouton.dataset.op);
});
btnUndo.addEventListener('click', annuler);
btnReset.addEventListener('click', toutRefaire);
btnBuzz.addEventListener('click', () => socket.emit('vingtquatre-claim'));
btnPass.addEventListener('click', () => socket.emit('vingtquatre-give-up'));

// Au clavier, pour ceux qui jouent sur ordinateur — et le 24 se joue d'abord
// sur ordinateur : la course se gagne à la seconde, viser une tuile à la
// souris coûte cher, et le buzzer doit être à portée de pouce.
document.addEventListener('keydown', (e) => {
  if (screens.game.classList.contains('hidden')) return;
  const cible = e.target;
  if (cible && (cible.tagName === 'INPUT' || cible.tagName === 'TEXTAREA')) return;

  // La barre d'espace fait défiler la page par défaut : on la lui reprend,
  // c'est le geste principal du jeu.
  if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
    if (latestState && latestState.peutBuzzer) {
      e.preventDefault();
      socket.emit('vingtquatre-claim');
    }
    return;
  }

  if (!plateau || plateau.verrouille) return;

  if (e.key >= '1' && e.key <= '4') {
    const item = plateau.items[Number(e.key) - 1];
    if (item) choisirItem(item.id);
    return;
  }
  if (['+', '-', '*', '/'].includes(e.key)) {
    e.preventDefault();
    choisirOperation(e.key);
    return;
  }
  if (e.key === 'x' || e.key === 'X') {
    choisirOperation('*');
    return;
  }
  if (e.key === 'Backspace') {
    e.preventDefault();
    annuler();
    return;
  }
  if (e.key === 'Escape') toutRefaire();
});

// --- Chronos --------------------------------------------------------------
// Deux compteurs distincts : celui de la donne (60 s de recherche, qui se
// FIGE dès que quelqu'un a la main) et celui de l'explication (20 s). Les
// deux sont décomptés localement à partir du temps restant annoncé par le
// serveur : on ne se fie pas à l'horloge de la machine du joueur, qui peut
// être décalée de plusieurs minutes.

const chronoBar = document.getElementById('v24-chrono-bar');
const chronoText = document.getElementById('v24-chrono-text');
let chronoTimer = null;
let chronoFin = 0;
let chronoTotal = 60000;

function peindreChrono(restant) {
  chronoText.textContent = Math.ceil(restant / 1000);
  chronoBar.style.width = `${(restant / chronoTotal) * 100}%`;
  chronoBar.classList.toggle('v24-chrono-bar--urgent', restant <= 10000);
}

function startChrono(msRestant, total) {
  chronoTotal = total || msRestant;
  chronoFin = Date.now() + msRestant;
  clearInterval(chronoTimer);
  tickChrono();
  chronoTimer = setInterval(tickChrono, 100);
}

// Chrono figé : quelqu'un explique, le temps de recherche ne s'écoule plus.
// On laisse la barre exactement où elle en est plutôt que de la faire courir
// sur un temps qui ne bouge pas.
function freezeChrono(msRestant, total) {
  clearInterval(chronoTimer);
  chronoTimer = null;
  chronoTotal = total || msRestant || 1;
  peindreChrono(msRestant);
  chronoBar.classList.add('v24-chrono-bar--fige');
}

function stopChrono() {
  clearInterval(chronoTimer);
  chronoTimer = null;
}

function tickChrono() {
  chronoBar.classList.remove('v24-chrono-bar--fige');
  const restant = Math.max(0, chronoFin - Date.now());
  peindreChrono(restant);
  if (restant <= 0) stopChrono();
}

// Compte à rebours de l'explication : le même pour celui qui explique (« il
// te reste 12 s ») et pour les autres (« Marie explique — 12 s »), pour que
// l'attente soit lisible des deux côtés.
let explainTimer = null;
let explainFin = 0;

function startExplainCountdown(msRestant, rendre) {
  explainFin = Date.now() + msRestant;
  clearInterval(explainTimer);
  const tick = () => {
    const restant = Math.max(0, explainFin - Date.now());
    rendre(Math.ceil(restant / 1000));
    if (restant <= 0) {
      clearInterval(explainTimer);
      explainTimer = null;
    }
  };
  tick();
  explainTimer = setInterval(tick, 200);
}

function stopExplainCountdown() {
  clearInterval(explainTimer);
  explainTimer = null;
}

// --- Tableau des scores ---------------------------------------------------

const scoreboardEl = document.getElementById('v24-scoreboard');

function renderScoreboard(state) {
  scoreboardEl.replaceChildren();
  state.scoreboard.forEach((p) => {
    const ligne = document.createElement('div');
    ligne.className = 'v24-score-row' + (p.id === myId ? ' v24-score-row--moi' : '');
    if (!p.connected) ligne.classList.add('v24-score-row--absent');
    if (p.claime) ligne.classList.add('v24-score-row--claime');
    if (p.elimine || p.passe) ligne.classList.add('v24-score-row--hors-jeu');

    const nom = document.createElement('span');
    nom.className = 'v24-score-nom';
    // textContent : le pseudo vient d'un autre joueur (voir escapeHTML dans
    // commun.js — deux failles XSS ont déjà été trouvées par ce chemin).
    nom.textContent = p.id === myId ? `${p.nickname} (toi)` : p.nickname;
    ligne.appendChild(nom);

    const etat = document.createElement('span');
    etat.className = 'v24-score-etat';
    etat.textContent = !p.connected ? '🔌' : p.claime ? '⚡' : p.elimine ? '❌' : p.passe ? '🏳️' : '';
    etat.title = !p.connected
      ? 'Déconnecté'
      : p.claime
        ? 'A la main, explique sa combinaison'
        : p.elimine
          ? 'Écarté de cette donne'
          : p.passe
            ? 'A passé cette donne'
            : '';
    ligne.appendChild(etat);

    const score = document.createElement('span');
    score.className = 'v24-score-points';
    score.textContent = p.score;
    ligne.appendChild(score);

    scoreboardEl.appendChild(ligne);
  });
}

// --- Écran de jeu ---------------------------------------------------------

const roundIndicator = document.getElementById('v24-round-indicator');
const btnEndGame = document.getElementById('v24-btn-end-game');

const ETOILES = { facile: '★☆☆', moyen: '★★☆', difficile: '★★★' };

// La zone d'action a trois visages, jamais deux à la fois : le buzzer (on
// cherche), l'attente (quelqu'un d'autre explique), les opérations (c'est moi
// qui explique).
function renderZoneAction(state) {
  const jExplique = Boolean(state.jeExplique);
  buzzZone.classList.toggle('hidden', jExplique);
  explainZone.classList.toggle('hidden', !jExplique);

  if (jExplique) {
    startExplainCountdown(state.msExplication, (s) => {
      explainTimerEl.textContent = `Montre ta combinaison — ${s} s`;
      explainTimerEl.classList.toggle('v24-explain-timer--urgent', s <= 5);
    });
    return;
  }

  stopExplainCountdown();
  btnBuzz.disabled = !state.peutBuzzer;
  btnBuzz.classList.toggle('v24-buzzer--pret', Boolean(state.peutBuzzer));

  if (state.claimerId) {
    buzzStatus.className = 'v24-buzz-status v24-buzz-status--attente';
    startExplainCountdown(state.msExplication, (s) => {
      buzzStatus.textContent = `⚡ ${state.claimerNickname} a buzzé — explication en cours… ${s} s`;
    });
    return;
  }
  if (state.jeSuisElimine) {
    buzzStatus.className = 'v24-buzz-status v24-buzz-status--hors-jeu';
    buzzStatus.textContent = '❌ Buzz raté : tu reprends à la prochaine donne.';
    return;
  }
  if (state.jAiPasse) {
    buzzStatus.className = 'v24-buzz-status v24-buzz-status--hors-jeu';
    buzzStatus.textContent = '🏳️ Tu as passé cette donne.';
    return;
  }
  buzzStatus.className = 'v24-buzz-status';
  buzzStatus.textContent = 'Cherche de tête, puis appuie dès que tu vois la solution.';
}

function renderGame(state) {
  // On ne reconstruit le plateau qu'au changement de manche ou de main : le
  // serveur rediffuse l'état à chaque « je passe » et à chaque déconnexion,
  // et reconstruire à ce moment-là effacerait le travail de celui qui est en
  // train d'expliquer.
  const nouvelleManche = state.roundNumber !== manchAffichee;
  const jExplique = state.phase === 'playing' && Boolean(state.jeExplique);
  const changementDeMain = state.phase === 'playing' && jExplique !== jExpliquaisAvant;

  if (nouvelleManche || changementDeMain) {
    manchAffichee = state.roundNumber;
    jExpliquaisAvant = jExplique;
    plateau = nouveauPlateau(state.cartes);
    selection = null;
    opArme = null;
    montrerFeedback('', null);
  }
  // Le plateau ne s'ouvre que pour celui qui a la main, et se referme dès
  // qu'il a envoyé sa réponse.
  plateau.verrouille = !jExplique || plateau.envoye;
  renderBoard();

  roundIndicator.textContent = `Manche ${state.roundNumber} · ${ETOILES[state.difficulte] || ''}`;
  roundIndicator.title = `Difficulté : ${state.difficulte}`;
  btnEndGame.classList.toggle('hidden', !state.isHost);

  if (state.phase === 'playing') {
    if (state.chronoFige) freezeChrono(state.msRestant, state.roundMs);
    else startChrono(state.msRestant, state.roundMs);
    renderZoneAction(state);
  } else {
    stopChrono();
    stopExplainCountdown();
  }

  // « Je passe » devient « je rends la main » pour celui qui explique : c'est
  // le même geste côté serveur (il perd la donne), mais pas la même intention
  // — autant le dire dans les mots du joueur.
  btnPass.textContent = jExplique ? '🏳️ Je rends la main' : '🏳️ Je passe';
  btnPass.disabled =
    state.phase !== 'playing' || (!jExplique && (Boolean(state.jAiPasse) || Boolean(state.jeSuisElimine)));

  renderScoreboard(state);
  syncAwayPlayersFromState(state);
}

btnEndGame.addEventListener('click', () => socket.emit('vingtquatre-end-game'));

// Un buzz qui n'a rien donné : tout le monde le voit, la donne repart.
socket.on('vingtquatre-claim-rate', ({ id, nickname, raison }) => {
  if (id === myId) {
    showToast(raison === 'abandon' ? '🏳️ Tu as rendu la main.' : '❌ Trop tard ! Tu es écarté de cette donne.');
    return;
  }
  showToast(`❌ ${nickname} n'a pas trouvé — la donne repart !`);
});

// Le serveur a refusé la suite envoyée : en pratique, seulement si le client
// et lui ont divergé. On rend la main au joueur plutôt que de le laisser
// devant un plateau figé — sa fenêtre d'explication court toujours.
socket.on('vingtquatre-solve-refuse', ({ erreur }) => {
  if (plateau) {
    plateau.envoye = false;
    plateau.verrouille = false;
    renderBoard();
  }
  montrerFeedback(erreur || 'Combinaison refusée.', 'erreur');
});

// --- Révélation de fin de manche -----------------------------------------

const revealEl = document.getElementById('v24-reveal');
const revealEmoji = document.getElementById('v24-reveal-emoji');
const revealTitle = document.getElementById('v24-reveal-title');
const revealFormula = document.getElementById('v24-reveal-formula');
const revealNote = document.getElementById('v24-reveal-note');
const revealBar = document.getElementById('v24-reveal-bar');

function hideReveal() {
  revealEl.classList.add('hidden');
}

function showReveal(state) {
  const r = state.reveal;
  if (r.trouve) {
    const moi = r.winnerId === myId;
    revealEmoji.textContent = moi ? '🎉' : '⚡';
    revealTitle.textContent = moi ? 'Tu as trouvé le premier !' : `${r.winnerNickname} a trouvé !`;
    revealFormula.textContent = `${jolieFormule(r.formule)} = 24`;
    const secondes = (r.tempsMs / 1000).toFixed(1).replace('.', ',');
    revealNote.textContent = `en ${secondes} s · ${r.nbSolutions} solution${r.nbSolutions > 1 ? 's' : ''} possible${r.nbSolutions > 1 ? 's' : ''} sur cette donne`;
  } else {
    revealEmoji.textContent = r.raison === 'abandon' ? '🏳️' : '⏱️';
    revealTitle.textContent = r.raison === 'abandon' ? 'Tout le monde a passé' : 'Temps écoulé !';
    revealFormula.textContent = `${jolieFormule(r.solution)} = 24`;
    revealNote.textContent =
      r.nbSolutions > 1 ? `Une solution parmi ${r.nbSolutions}.` : 'C’était la seule solution.';
  }

  revealEl.classList.remove('hidden');
  // Barre de progression : on voit combien de temps il reste pour lire avant
  // que la manche suivante démarre.
  revealBar.style.transition = 'none';
  revealBar.style.width = '100%';
  void revealBar.offsetWidth;
  revealBar.style.transition = `width ${state.revealMs}ms linear`;
  revealBar.style.width = '0%';
}

// --- Fin de partie --------------------------------------------------------

const endTitle = document.getElementById('v24-end-title');
const endSubtitle = document.getElementById('v24-end-subtitle');
const endBody = document.getElementById('v24-end-body');

function renderGameEnd(state) {
  const classement = state.finalRanking;
  const meilleur = classement[0];
  const exAequo = classement.filter((r) => r.score === meilleur.score).length > 1;

  if (exAequo) {
    endTitle.textContent = 'Égalité parfaite ! 🤝';
  } else if (meilleur.id === myId) {
    endTitle.textContent = 'Tu remportes la partie ! 🏆';
  } else {
    endTitle.textContent = `${meilleur.nickname} remporte la partie !`;
  }
  endSubtitle.textContent = `${state.manchesJouees} manche${state.manchesJouees > 1 ? 's' : ''} jouée${state.manchesJouees > 1 ? 's' : ''}.`;

  endBody.replaceChildren();
  classement.forEach((r) => {
    const tr = document.createElement('tr');
    const nom = document.createElement('td');
    nom.textContent = r.id === myId ? `${r.nickname} (toi)` : r.nickname;
    const points = document.createElement('td');
    points.textContent = r.score;
    tr.append(nom, points);
    endBody.appendChild(tr);
  });
}

document.getElementById('v24-btn-rematch').addEventListener('click', () => socket.emit('vingtquatre-rematch'));

// --- Dispatch d'état ------------------------------------------------------

function applyState(state) {
  latestState = state;
  myId = state.myId;
  myIsHost = state.isHost;
  showReconnectingOverlay(false);
  joinModal.classList.add('hidden');

  if (state.phase === 'playing') {
    hideReveal();
    showScreen('game');
    renderGame(state);
    return;
  }
  if (state.phase === 'reveal') {
    showScreen('game');
    // Le plateau reste visible derrière, verrouillé : on voit encore ses
    // propres cartes pendant qu'on lit la solution.
    renderGame(state);
    if (plateau) {
      plateau.verrouille = true;
      renderBoard();
    }
    showReveal(state);
    return;
  }
  if (state.phase === 'game-end') {
    hideReveal();
    stopChrono();
    stopExplainCountdown();
    manchAffichee = null;
    jExpliquaisAvant = false;
    showScreen('end');
    renderGameEnd(state);
  }
}

socket.on('vingtquatre-state', applyState);
socket.on('vingtquatre-rejoin-ok', applyState);

socket.on('vingtquatre-player-disconnected', ({ id, nickname }) => {
  showToast(`🔌 ${nickname} a une connexion instable…`);
  awayPlayers.set(id, nickname);
  renderDisconnectBanner();
});

socket.on('vingtquatre-player-reconnected', ({ id, nickname }) => {
  showToast(`✅ ${nickname} est de retour !`);
  awayPlayers.delete(id);
  renderDisconnectBanner();
});

socket.on('vingtquatre-rejoin-failed', (payload) => {
  clearActiveRoom();
  showReconnectingOverlay(false);
  if (payload && payload.reason === 'server-restarted') {
    showToast('😴 Le serveur a redémarré entre-temps — cette partie a été perdue, il faut en relancer une.');
  }
  const fallback = rejoinFallback;
  rejoinFallback = null;
  if (fallback && fallback !== 'link') {
    myNickname = fallback.nickname;
    socket.emit('vingtquatre-join-room', { code: fallback.code, nickname: fallback.nickname, token: getPlayerToken() });
    return;
  }
  if (fallback === 'link') {
    joinModalError.textContent = '';
    btnJoinModal.disabled = false;
    joinModal.classList.remove('hidden');
    joinModalNickname.focus();
  }
});

socket.on('disconnect', () => {
  showReconnectingOverlay(true);
  stopChrono();
});

socket.on('connect', () => {
  attemptAutoRejoin(roomFromUrl ? 'link' : null);
});

// --- Accueil ou arrivée par un lien d'invitation --------------------------

const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('room');

function attemptAutoRejoin(fallback) {
  const saved = loadActiveRoom();
  const code = (roomFromUrl && roomFromUrl.toUpperCase()) || (saved && saved.code);
  if (!code || !saved || saved.code !== code) return false;
  rejoinFallback = fallback || null;
  showReconnectingOverlay(true);
  socket.emit('vingtquatre-rejoin-room', { code, token: getPlayerToken() });
  return true;
}

if (roomFromUrl) {
  showScreen(null);
  joinModalError.textContent = '';
  btnJoinModal.disabled = false;
  joinModal.classList.remove('hidden');
  joinModalNickname.focus();
} else {
  showScreen('home');
}
