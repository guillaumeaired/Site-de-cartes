const socket = io();

function getPlayerToken() {
  let token = sessionStorage.getItem('cardGamesPlayerToken');
  if (!token) {
    token = crypto.randomUUID();
    sessionStorage.setItem('cardGamesPlayerToken', token);
  }
  return token;
}
const ACTIVE_ROOM_KEY = 'skullking:activeRoom';
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

const SPECIAL_INFO = {
  pirate: { emoji: '🏴‍☠️', label: 'Pirate' },
  siren: { emoji: '🧜', label: 'Sirène' },
  skullking: { emoji: '💀', label: 'Skull King' },
  escape: { emoji: '🏳️', label: 'Fuite' },
  tigress: { emoji: '🐯', label: 'Tigresse' },
  loot: { emoji: '💰', label: 'Butin' },
  kraken: { emoji: '🐙', label: 'Kraken' },
  whale: { emoji: '🐋', label: 'Baleine' },
  // Extension
  firstmate: { emoji: '⚔️', label: 'Mat le Forban' },
  stingray: { emoji: '🦈', label: 'Raie Tachetée' },
  lastvolley: { emoji: '💣', label: 'Dernière Salve' },
  plank: { emoji: '🪵', label: 'Marcher sur la Planche' },
  davyjones: { emoji: '⚰️', label: 'Coffre de Davy Jones' },
};
// Ce que déclenche chaque pirate nommé s'IL remporte le pli avec sa propre
// carte — affiché en infobulle sur la carte, pour savoir à quoi s'attendre
// avant même de la jouer.
const PIRATE_POWER_TEXT = {
  "Rosie D'Laney": "Choisit qui entame le pli suivant (pas sur le dernier pli).",
  'Will le Bandit': 'Pioche 2 cartes non distribuées et en défausse 2 (pas sur le dernier pli).',
  'Rascal le Flambeur': "Peut miser 10 ou 20 points de plus sur sa propre annonce (pas sur le dernier pli).",
  'Juanita Jade': 'Regarde les cartes non distribuées ce tour-ci (pas sur le dernier pli).',
  'Harry le Géant': 'Modifie sa propre annonce de ±1 (même sur le dernier pli).',
  'Mary Thorne': 'Force un joueur choisi à jouer une carte aléatoire de sa main au pli suivant (pas sur le dernier pli).',
};

// Tri d'affichage de la main : par couleur (vert/jaune/violet/noir) puis
// par hauteur croissante, les cartes spéciales groupées à la fin (dans un
// ordre fixe) - purement visuel, ne change rien à la logique de jeu.
const SUIT_DISPLAY_ORDER = ['vert', 'jaune', 'violet', 'noir'];
const SPECIAL_DISPLAY_ORDER = [
  'pirate',
  'firstmate',
  'siren',
  'skullking',
  'tigress',
  'loot',
  'kraken',
  'whale',
  'stingray',
  'lastvolley',
  'plank',
  'davyjones',
  'wild15',
  'escape',
];
// Le 0/14 garde une vraie couleur dès la donne (kind:'number', value:null
// tant qu'il n'est pas déclaré) : il se trie donc avec sa famille de
// couleur comme n'importe quelle numérotée, positionné en fin de groupe
// (juste après le 14) tant que sa valeur n'est pas encore choisie.
function sortHandForDisplay(hand) {
  return [...hand].sort((a, b) => {
    const groupA = a.kind === 'number' ? SUIT_DISPLAY_ORDER.indexOf(a.suit) : 4 + SPECIAL_DISPLAY_ORDER.indexOf(a.kind);
    const groupB = b.kind === 'number' ? SUIT_DISPLAY_ORDER.indexOf(b.suit) : 4 + SPECIAL_DISPLAY_ORDER.indexOf(b.kind);
    if (groupA !== groupB) return groupA - groupB;
    if (a.kind === 'number') return (a.value ?? 14.5) - (b.value ?? 14.5);
    return 0;
  });
}

// Indice visuel de la couleur imposée (purement indicatif, le serveur reste
// seul juge à la validation) - même logique que server/skullking.js
// (ledSuitOf/mustFollowSuit/isCardPlayable), dupliquée par convention.
function ledSuitOf(trick) {
  for (const play of trick) {
    if (play.card.kind === 'number') return play.card.suit;
  }
  return null;
}
function mustFollowSuit(hand, ledSuit) {
  return ledSuit !== null && hand.some((c) => c.kind === 'number' && c.suit === ledSuit);
}
function isCardPlayable(card, hand, trick) {
  if (card.kind !== 'number') return true;
  const ledSuit = ledSuitOf(trick);
  if (ledSuit === null || card.suit === ledSuit) return true;
  return !mustFollowSuit(hand, ledSuit);
}

function cardClass(card) {
  if (card.kind === 'wild15' || card.wild15) return 'sk-card--wild15';
  if (card.kind === 'number') {
    if (card.wild14 && card.value == null) return 'sk-card--wild14';
    return `sk-card--${card.suit}`;
  }
  if (card.kind === 'pirate' || card.kind === 'firstmate') return 'sk-card--pirate';
  return 'sk-card--special';
}
function cardFaceHTML(card) {
  if (card.kind === 'wild15') {
    // Pas encore joué : sa couleur/valeur ne sont pas encore fixées.
    return `<span class="sk-special-emoji">🃏</span><span class="sk-special-label">Joker</span>`;
  }
  if (card.kind === 'number') {
    if (card.wild14 && card.value == null) {
      return `<span class="sk-special-emoji">0/14</span>`;
    }
    return `<span class="card-emblem">${card.value}</span>`;
  }
  const info = SPECIAL_INFO[card.kind];
  const label = card.kind === 'pirate' ? card.name || 'Pirate' : info.label;
  return `<span class="sk-special-emoji">${info.emoji}</span><span class="sk-special-label">${label}</span>`;
}

// Texte d'infobulle (survol) : ce qui se passe SI le joueur qui pose cette
// carte remporte le pli avec elle.
function cardPowerText(card) {
  if (card.kind === 'wild15') {
    return "Joker/Wild 15 : prend la couleur déjà imposée (vert/jaune/violet) si elle existe, sinon tu choisis (jamais noir) ; si le noir est imposé, il perd quand même face à l'atout noir.";
  }
  if (card.wild15) {
    return `Joker joué en ${card.suit} (valeur 15) : bat toute cette couleur, perd face à l'atout noir.`;
  }
  if (card.kind === 'number' && card.wild14 && card.value == null) {
    return 'Tu choisiras 0 (perd toujours) ou 14 (carte forte de sa couleur) au moment de la jouer.';
  }
  switch (card.kind) {
    case 'number':
      if (card.suit === 'noir') return 'Atout permanent : bat toutes les couleurs, quel que soit le chiffre.';
      if (card.ext && card.value === 8) return "Carte d'extension : +5 points de bonus pour qui la capture.";
      if (card.ext && card.value === 7) return "Carte d'extension : -5 points de bonus pour qui la capture.";
      return '';
    case 'escape':
      return 'Ne gagne jamais le pli.';
    case 'tigress':
      return 'Jouée comme Pirate ou comme Fuite, au choix, au moment de la pose.';
    case 'pirate':
      return `Bat les numérotées et les Sirènes. Si elle/il remporte le pli : ${card.name ? PIRATE_POWER_TEXT[card.name] : 'aucun pouvoir spécial.'}`;
    case 'siren':
      return 'Bat le Skull King, perd contre un Pirate — sauf Pirate + Skull King + Sirène réunis : la Sirène gagne alors toujours.';
    case 'skullking':
      return 'Bat les Pirates. Face à une Sirène seule, la Sirène gagne quand même.';
    case 'loot':
      return "Agit comme une Fuite. Si un autre joueur remporte le pli, vous formez une alliance : +20 points chacun si vous réussissez tous les deux votre annonce de la manche.";
    case 'kraken':
      return 'Détruit le pli : personne ne le gagne. Le pli suivant est mené par qui aurait gagné sans lui.';
    case 'whale':
      return "Annule l'effet de toutes les cartes spéciales du pli : seule la valeur numérique compte (le noir perd son statut d'atout).";
    case 'firstmate':
      return "Bat tous les Pirates classiques (Mary Thorne incluse), mais perd contre le Skull King et contre une Sirène (même seule, sans Skull King). S'il remporte le pli, hérite du/des pouvoir(s) du/des Pirate(s) capturé(s) — sans le bonus de capture normal. Capturé par le Skull King ou une Sirène : +30 points pour qui le capture.";
    case 'stingray':
      return 'Comme la Baleine blanche, mais la carte la PLUS BASSE remporte le pli.';
    case 'lastvolley':
      return 'Ne gagne jamais le pli. Le joueur qui la pose joue une carte de plus après tout le monde, puis passe son tour au pli suivant (sauf sur le tout dernier pli de la manche).';
    case 'plank':
      return 'Ne gagne jamais le pli. Retire un Pirate présent dans le pli en cours (au choix s\'il y en a plusieurs).';
    case 'davyjones':
      return "Ne gagne jamais le pli. Détruit tous les Monstres Marins présents (Kraken/Baleine/Raie), peu importe l'ordre : +20 points par Monstre détruit.";
    default:
      return '';
  }
}

// --- Fenêtre d'explication au survol des cartes à pouvoir ---
// Le title natif du navigateur est lent à apparaître et non stylable :
// on le remplace par une bulle qui suit la souris, cohérente avec le reste
// de l'habillage du jeu.
const cardTooltip = document.getElementById('sk-card-tooltip');

function positionCardTooltip(e) {
  const pad = 16;
  const rect = cardTooltip.getBoundingClientRect();
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - pad;
  cardTooltip.style.left = `${Math.max(8, x)}px`;
  cardTooltip.style.top = `${Math.max(8, y)}px`;
}

function hideCardTooltip() {
  cardTooltip.classList.add('hidden');
}

// Attache l'explication d'une carte à un élément : rien n'est fait si la
// carte n'a pas de texte particulier (numérotées hors atout/extension).
function attachPowerTooltip(el, card) {
  const text = cardPowerText(card);
  if (!text) return;
  el.addEventListener('mouseenter', (e) => {
    cardTooltip.textContent = text;
    cardTooltip.classList.remove('hidden');
    positionCardTooltip(e);
  });
  el.addEventListener('mousemove', positionCardTooltip);
  el.addEventListener('mouseleave', hideCardTooltip);
}

const screens = {
  home: document.getElementById('sk-screen-home'),
  waiting: document.getElementById('sk-screen-waiting'),
  game: document.getElementById('sk-screen-game'),
  end: document.getElementById('sk-screen-end'),
};
function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
}

const toastEl = document.getElementById('sk-toast');
let toastTimer = null;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

const reconnectOverlay = document.getElementById('reconnect-overlay');

// Le serveur (hebergement gratuit) peut mettre jusqu'a ~25s a se reveiller au
// tout premier chargement apres une periode d'inactivite : sans ca, la page
// semble juste figee/cassee le temps que le socket se connecte. On reutilise
// la banniere de reconnexion existante avec un texte different, seulement le
// temps de ce tout premier connect (jamais reaffiche ensuite).
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

// --- Accueil ---

const inputNickname = document.getElementById('sk-input-nickname');
const homeError = document.getElementById('sk-home-error');
const btnCreate = document.getElementById('sk-btn-create');
const formJoin = document.getElementById('sk-form-join');
const inputCode = document.getElementById('sk-input-code');
const btnRules = document.getElementById('sk-btn-rules');
const rulesModal = document.getElementById('sk-rules-modal');
const btnCloseRules = document.getElementById('sk-btn-close-rules');

function requireNickname() {
  const value = inputNickname.value.trim();
  if (!value) {
    homeError.textContent = 'Entre un pseudo avant de continuer.';
    inputNickname.focus();
    return null;
  }
  return value;
}

let myNickname = null;
let myId = null;
let rejoinFallback = null;

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
  socket.emit('skullking-create-room', { nickname, token: getPlayerToken() });
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
    socket.emit('skullking-rejoin-room', { code, token: getPlayerToken() });
    return;
  }
  socket.emit('skullking-join-room', { code, nickname, token: getPlayerToken() });
});

btnRules.addEventListener('click', () => rulesModal.classList.remove('hidden'));
btnCloseRules.addEventListener('click', () => rulesModal.classList.add('hidden'));

// --- Salon d'attente ---

const shareBlock = document.getElementById('sk-share-block');
const shareLink = document.getElementById('sk-share-link');
const shareCode = document.getElementById('sk-share-code');
const btnCopy = document.getElementById('sk-btn-copy');
const btnLeaveWaiting = document.getElementById('sk-btn-leave-waiting');
const lobbyPlayers = document.getElementById('sk-lobby-players');
const lobbyList = document.getElementById('sk-lobby-list');
const lobbyCount = document.getElementById('sk-lobby-count');
const lobbyRange = document.getElementById('sk-lobby-range');
const btnStartGame = document.getElementById('sk-btn-start-game');
const waitingHint = document.getElementById('sk-waiting-hint');
const btnExtension = document.getElementById('sk-btn-extension');
const extensionHint = document.getElementById('sk-extension-hint');

const joinModal = document.getElementById('sk-join-modal');
const joinModalNickname = document.getElementById('sk-join-modal-nickname');
const btnJoinModal = document.getElementById('sk-btn-join-modal');
const joinModalError = document.getElementById('sk-join-modal-error');

let myIsHost = false;

function goHome() {
  clearActiveRoom();
  socket.emit('skullking-leave-room');
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);
  joinModal.classList.add('hidden');
  inputNickname.value = '';
  showScreen('home');
}

btnLeaveWaiting.addEventListener('click', goHome);
document.getElementById('sk-btn-leave-game').addEventListener('click', goHome);
document.getElementById('sk-btn-leave-end').addEventListener('click', goHome);

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

socket.on('skullking-room-created', ({ code }) => {
  setCreateBusy(false);
  saveActiveRoom(code, myNickname);
  const url = `${window.location.protocol}//${window.location.host}/skullking.html?room=${code}`;
  shareLink.value = url;
  shareCode.textContent = code;
  shareBlock.classList.remove('hidden');
});

socket.on('skullking-lobby-update', ({ code, players, hostId, isHost, canStart, minPlayers, maxPlayers, extensionEnabled }) => {
  saveActiveRoom(code, myNickname);
  showReconnectingOverlay(false);
  myIsHost = isHost;
  showScreen('waiting');
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
  lobbyRange.textContent = `${minPlayers} à ${maxPlayers}`;

  // Switch d'extension : cliquable par l'hôte uniquement (imposé aussi côté
  // serveur), lecture seule pour les autres - tout le monde voit le même
  // état en temps réel via ce même événement de lobby.
  btnExtension.classList.toggle('sk-extension-toggle--on', extensionEnabled);
  btnExtension.setAttribute('aria-pressed', String(extensionEnabled));
  btnExtension.disabled = !isHost;
  btnExtension.classList.toggle('sk-extension-toggle--readonly', !isHost);
  extensionHint.textContent = extensionEnabled
    ? "12 numérotées, un Joker, 6 nouvelles cartes spéciales — jusqu'à 9 joueurs."
    : isHost
      ? "Active l'extension officielle pour plus de cartes et jusqu'à 9 joueurs."
      : '';

  btnStartGame.classList.toggle('hidden', !isHost);
  btnStartGame.disabled = !canStart;
  if (isHost) {
    waitingHint.textContent = canStart
      ? 'Prêt ! Lance la partie quand tu veux.'
      : `Il faut entre ${minPlayers} et ${maxPlayers} joueurs pour commencer…`;
  } else {
    waitingHint.textContent = "En attente que l'hôte lance la partie…";
  }
  // On repasse par le salon avant chaque nouvelle partie (y compris une
  // revanche) : c'est le point sûr pour réarmer la roue de tirage au sort.
  startRevealPlayed = false;
});

btnExtension.addEventListener('click', () => {
  if (!myIsHost) return;
  socket.emit('skullking-toggle-extension');
});

socket.on('skullking-error', (message) => {
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

socket.on('skullking-power-result', ({ message }) => {
  if (message) showToast(message);
});

socket.on('skullking-player-left', ({ nickname, reason }) => {
  if (reason) {
    showToast(`${nickname} a quitté la partie — retour au classement actuel.`);
  } else {
    showToast(`${nickname} a quitté le salon.`);
  }
});

btnStartGame.addEventListener('click', () => socket.emit('skullking-start-game'));

btnJoinModal.addEventListener('click', () => {
  const nickname = joinModalNickname.value.trim().slice(0, 16);
  if (!nickname) {
    joinModalError.textContent = 'Entre un pseudo avant de continuer.';
    return;
  }
  joinModalError.textContent = '';
  btnJoinModal.disabled = true;
  myNickname = nickname;
  socket.emit('skullking-join-room', { code: roomFromUrl.toUpperCase(), nickname, token: getPlayerToken() });
});

// --- Partie en cours ---

const roundIndicator = document.getElementById('sk-round-indicator');
const btnEndGame = document.getElementById('sk-btn-end-game');
const tableEl = document.getElementById('sk-table');
const trickCaptionEl = document.getElementById('sk-trick-caption');
const trickRow = document.getElementById('sk-trick-row');
const turnIndicator = document.getElementById('sk-turn-indicator');
const bidChoices = document.getElementById('sk-bid-choices');
const tigressChoiceEl = document.getElementById('sk-tigress-choice');
const btnTigressPirate = document.getElementById('sk-btn-tigress-pirate');
const btnTigressEscape = document.getElementById('sk-btn-tigress-escape');
const handEl = document.getElementById('sk-hand');
const scoreboardRows = document.getElementById('sk-scoreboard-rows');
const roundTrackFill = document.getElementById('sk-round-track-fill');
const roundTrackKnob = document.getElementById('sk-round-track-knob');
const roundTrackLabel = document.getElementById('sk-round-track-label');
const sideFoot = document.getElementById('sk-side-foot');
const sideRound = document.getElementById('sk-side-round');
const roundSegments = document.getElementById('sk-round-segments');

let latestState = null;
let startRevealPlayed = false;
let pendingTigressCardId = null;

// Même principe que la table de l'Ascenseur : moi toujours en bas, les
// autres répartis dans l'ordre du tour. Le 2-joueurs (absent de l'Ascenseur)
// est juste face à face.
const SEAT_POSITIONS = {
  2: [[50, 90], [50, 10]],
  3: [[50, 90], [14, 34], [86, 34]],
  4: [[50, 90], [8, 52], [50, 10], [92, 52]],
  5: [[50, 90], [7, 60], [24, 16], [76, 16], [93, 60]],
  6: [[50, 90], [6, 64], [16, 25], [50, 9], [84, 25], [94, 64]],
  7: [[50, 90], [6, 66], [13, 32], [34, 11], [66, 11], [87, 32], [94, 66]],
  // 8 et 9 joueurs : configurations légitimes dès que l'extension officielle
  // est activée (MAX_PLAYERS_EXTENDED = 9 côté serveur). Valeurs issues de
  // computeSeatPositions() ci-dessous, figées ici pour rester lisibles.
  8: [[50, 90], [10, 66], [7, 40], [23, 19], [50, 10], [77, 19], [93, 40], [90, 66]],
  9: [[50, 90], [10, 66], [7, 44], [17, 24], [38, 12], [62, 12], [83, 24], [93, 44], [90, 66]],
};

// Répartition sur une ellipse (centre 50/50, rayons 44/40 en % de la table) :
// moi toujours en bas au centre [50, 90], les autres étalés symétriquement de
// part et d'autre en laissant un large écart en bas pour ma propre main.
// Sert de calcul de repli : renvoie toujours exactement `count` positions,
// donc aucun siège ne peut se retrouver sans position, quel que soit l'effectif.
const SEAT_ELLIPSE = { cx: 50, cy: 50, rx: 44, ry: 40, startDeg: 66 };

// En paysage le tapis devient beaucoup plus large que haut : les tables figées
// ci-dessus, réglées pour un tapis presque rond de 340px, y collaient les
// sièges des extrémités au liseré (c'était la réserve laissée lors du
// correctif 8/9 joueurs). On y répartit donc les joueurs régulièrement sur
// toute l'ellipse, en partant du bas — la méthode retenue sur la maquette,
// qui tient aussi bien à 3 joueurs qu'à 9.
const SEAT_ELLIPSE_LANDSCAPE = { cx: 50, cy: 50, rx: 41, ry: 33 };
const landscapeTable = window.matchMedia('(min-width: 1000px)');

function computeSeatPositionsEven(count, ellipse) {
  const { cx, cy, rx, ry } = ellipse;
  const n = Math.max(1, count);
  return Array.from({ length: n }, (_, i) => {
    // i = 0 → angle droit vers le bas : moi, toujours au centre en bas.
    const angle = Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [Math.round(cx + rx * Math.cos(angle)), Math.round(cy + ry * Math.sin(angle))];
  });
}

function computeSeatPositions(count) {
  const { cx, cy, rx, ry, startDeg } = SEAT_ELLIPSE;
  const n = Math.max(1, count);
  const positions = [[cx, cy + ry]]; // moi, en bas au centre
  const others = n - 1;
  if (others > 0) {
    // On balaie l'arc startDeg → (360 - startDeg) dans le sens anti-horaire
    // (donc le voisin suivant apparaît à ma gauche, comme dans les tables ci-dessus).
    const span = 360 - 2 * startDeg;
    const step = others > 1 ? span / (others - 1) : 0;
    for (let i = 0; i < others; i++) {
      const angle = ((others > 1 ? startDeg + i * step : 180) * Math.PI) / 180;
      positions.push([
        Math.round(cx - rx * Math.sin(angle)),
        Math.round(cy + ry * Math.cos(angle)),
      ]);
    }
  }
  return positions;
}

function seatOrder(players) {
  const myIndex = players.findIndex((p) => p.id === myId);
  if (myIndex === -1) return players;
  return [...players.slice(myIndex), ...players.slice(0, myIndex)];
}

function nicknameOf(state, id) {
  const p = state.players.find((pp) => pp.id === id);
  return p ? p.nickname : '?';
}

function seatLayout(state) {
  const ordered = seatOrder(state.players);
  let positions;
  if (landscapeTable.matches) {
    positions = computeSeatPositionsEven(ordered.length, SEAT_ELLIPSE_LANDSCAPE);
  } else {
    // On ne garde la table figée que si elle couvre vraiment tout le monde ;
    // sinon on calcule, jamais de repli partiel (source du TypeError à 8/9 joueurs).
    const tuned = SEAT_POSITIONS[ordered.length];
    positions =
      tuned && tuned.length === ordered.length ? tuned : computeSeatPositions(ordered.length);
  }
  const map = new Map();
  ordered.forEach((p, i) => map.set(p.id, positions[i]));
  return { ordered, map };
}

const MAX_VISIBLE_BACKS = 4;

// La pilule du bandeau du haut annonce la manche ET où l'on en est dedans
// (annonces, ou numéro du pli en cours) : en paysage c'est le seul repère
// permanent de l'avancement de la manche.
function renderRoundIndicator(state) {
  let step = '';
  if (state.phase === 'bidding') step = 'Annonces';
  else if (state.trickNumber) step = `Pli ${state.trickNumber}/${state.cardsInRound}`;
  // L'étape n'est affichée qu'en paysage : sur mobile la ligne passerait sur
  // deux lignes et ferait grossir l'en-tête, on garde la mention seule.
  roundIndicator.innerHTML =
    `Manche ${state.roundNumber}/${state.totalRounds}` +
    (step ? ` <span class="sk-round-step"><span class="sk-pill-sep">·</span> ${step}</span>` : '');
}

// Vert = l'annonce est pile tenue à cet instant, rouge = déjà dépassée,
// donc irrattrapable. Neutre tant qu'on annonce (rien n'est encore joué).
function bidStateSuffix(state, p) {
  if (state.phase === 'bidding' || p.bid === undefined || p.bid === null) return '';
  if (p.tricksWon > p.bid) return '--over';
  if (p.tricksWon === p.bid) return '--hit';
  return '';
}

function renderSeats(state) {
  const { ordered, map } = seatLayout(state);
  tableEl.querySelectorAll('.sk-seat').forEach((el) => el.remove());

  ordered.forEach((p) => {
    const [left, top] = map.get(p.id);
    const seat = document.createElement('div');
    seat.className = 'sk-seat' + (p.id === myId ? ' sk-seat--me' : '');
    seat.style.left = left + '%';
    seat.style.top = top + '%';
    if (!p.connected) seat.classList.add('sk-seat--disconnected');
    // Pendant l'annonce (simultanée, pas de "tour" à proprement parler), on
    // met déjà en avant qui mènera le pli - sinon rien n'indique "qui
    // commence" avant que la phase de jeu ne soit entamée.
    const activeId = state.phase === 'playing' ? state.turnPlayerId : state.leaderPlayerId;
    if (activeId && p.id === activeId) seat.classList.add('sk-seat--turn');

    if (p.id !== myId) {
      const cards = document.createElement('div');
      cards.className = 'sk-seat-cards';
      const shown = Math.min(p.handCount, MAX_VISIBLE_BACKS);
      for (let c = 0; c < shown; c++) {
        const back = document.createElement('div');
        back.className = 'sk-back-card';
        cards.appendChild(back);
      }
      if (p.handCount > 0) {
        const count = document.createElement('span');
        count.className = 'sk-seat-count';
        count.textContent = p.handCount;
        cards.appendChild(count);
      }
      seat.appendChild(cards);
    }

    // Jeton du joueur : en paysage il porte la mise en avant du tour (halo
    // doré) et donne au siège une silhouette lisible de loin. Masqué sous
    // 1000px, où la place manque et l'étiquette seule suffit.
    const avatar = document.createElement('div');
    avatar.className = 'sk-seat-av';
    avatar.textContent = p.id === myId ? '🫵' : '🏴‍☠️';
    seat.appendChild(avatar);

    const label = document.createElement('div');
    label.className = 'sk-seat-label';
    const name = document.createElement('span');
    name.className = 'sk-seat-name';
    name.textContent = (p.connected ? '' : '🔌 ') + p.nickname;
    label.appendChild(name);

    const bidEl = document.createElement('span');
    const bidState = bidStateSuffix(state, p);
    bidEl.className = 'sk-seat-bid' + (bidState ? ` sk-seat-bid${bidState}` : '');
    if (state.phase === 'bidding') {
      // En paysage l'étiquette est sur sa propre ligne : on peut écrire le mot.
      bidEl.textContent = p.hasBid ? (landscapeTable.matches ? '✓ prêt' : '✓') : '…';
    } else {
      bidEl.textContent = p.bid === undefined || p.bid === null ? '?' : `${p.tricksWon}/${p.bid}`;
    }
    label.appendChild(bidEl);

    if (p.id === state.dealerId) {
      const chip = document.createElement('span');
      chip.className = 'sk-seat-dealer';
      chip.textContent = 'D';
      chip.title = 'Donneur';
      label.appendChild(chip);
    }

    seat.appendChild(label);
    tableEl.appendChild(seat);
  });
}

// Paysage : le pli est regroupé au centre, une carte par joueur avec son nom
// au-dessus (couronne verte sur celui qui mène) — la lecture retenue sur la
// maquette. En portrait on garde les cartes posées devant chaque siège, seule
// disposition tenable sur une table étroite.
function renderTrickRow(state, trick) {
  trick.forEach((t) => {
    const slot = document.createElement('div');
    const leading = t.playerId === state.leadingPlayerId;
    slot.className = 'sk-trick-slot' + (leading ? ' sk-trick-slot--leading' : '');

    const who = document.createElement('span');
    who.className = 'sk-trick-who';
    who.textContent =
      (t.playerId === myId ? 'Toi' : nicknameOf(state, t.playerId)) + (leading ? ' 👑' : '');

    const cardEl = document.createElement('div');
    cardEl.className = `sk-card ${cardClass(t.card)}`;
    cardEl.innerHTML = cardFaceHTML(t.card);
    attachPowerTooltip(cardEl, t.card);

    slot.appendChild(who);
    slot.appendChild(cardEl);
    trickRow.appendChild(slot);
  });
}

function renderTrickSeats(state, trick) {
  const { map } = seatLayout(state);
  const PULL = 0.46;

  trick.forEach((t) => {
    const seatPos = map.get(t.playerId);
    if (!seatPos) return;
    const [seatLeft, seatTop] = seatPos;

    const slot = document.createElement('div');
    slot.className = 'sk-trick-card';
    slot.style.left = `${seatLeft + (50 - seatLeft) * PULL}%`;
    slot.style.top = `${seatTop + (50 - seatTop) * PULL}%`;
    if (t.playerId === state.leadingPlayerId) slot.classList.add('sk-trick-card--leading');

    const cardEl = document.createElement('div');
    cardEl.className = `sk-card ${cardClass(t.card)}`;
    cardEl.innerHTML = cardFaceHTML(t.card);
    attachPowerTooltip(cardEl, t.card);
    slot.appendChild(cardEl);

    tableEl.appendChild(slot);
  });
}

const SUIT_DOT = { vert: '🟢', jaune: '🟡', violet: '🟣', noir: '⚫' };

function renderTrick(state) {
  tableEl.querySelectorAll('.sk-trick-card').forEach((el) => el.remove());
  trickRow.innerHTML = '';
  const trick = state.currentTrick || [];

  if (landscapeTable.matches) renderTrickRow(state, trick);
  else renderTrickSeats(state, trick);

  if (state.phase === 'bidding') {
    // Le centre du tapis reste vide pendant les annonces : on y met la consigne
    // plutôt que de laisser un grand trou au milieu de la table.
    trickCaptionEl.textContent = '🎯 Tout le monde annonce son nombre de plis…';
  } else if (trick.length === 0) {
    trickCaptionEl.textContent = '';
  } else if (state.trickPaused) {
    if (state.lastTrickResult && state.lastTrickResult.destroyed) {
      trickCaptionEl.textContent = '💥 Le pli est détruit !';
    } else {
      const winner = state.leadingPlayerId === myId ? 'Tu remportes' : `${nicknameOf(state, state.leadingPlayerId)} remporte`;
      trickCaptionEl.textContent = `🏆 ${winner} le pli !`;
    }
  } else if (state.trickWillBeDestroyed) {
    trickCaptionEl.textContent = '💀 Ce pli sera détruit…';
  } else if (landscapeTable.matches) {
    // Le nom couronné dit déjà qui mène : la légende sert donc à rappeler la
    // couleur demandée et l'avancement du pli, comme sur la maquette.
    const led = ledSuitOf(trick);
    const progress = `${trick.length}/${state.players.length} cartes jouées`;
    trickCaptionEl.textContent = led
      ? `Couleur demandée : ${SUIT_DOT[led]} ${led} — ${progress}`
      : `Aucune couleur demandée — ${progress}`;
  } else {
    const leader = state.leadingPlayerId === myId ? 'Tu mènes' : `${nicknameOf(state, state.leadingPlayerId)} mène`;
    trickCaptionEl.textContent = `${leader} le pli`;
  }
}

function renderBidChoices(state) {
  bidChoices.innerHTML = '';
  bidChoices.classList.toggle('hidden', state.phase !== 'bidding');
  if (state.phase !== 'bidding') return;
  // L'annonce reste modifiable tant que tout le monde n'a pas encore
  // annoncé (le choix actuel reste affiché en surbrillance, cliquer sur un
  // autre chiffre la remplace) - une fois tout le monde prêt, la phase
  // change et ces boutons disparaissent d'eux-mêmes.
  for (let n = 0; n <= state.cardsInRound; n++) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (state.myBid === n ? ' btn-primary' : '');
    btn.textContent = n;
    btn.addEventListener('click', () => socket.emit('skullking-bid', { bid: n }));
    bidChoices.appendChild(btn);
  }

  // Rappel discret à droite des chiffres, dans la barre d'actions elle-même.
  const hint = document.createElement('span');
  hint.className = 'sk-bar-hint';
  hint.textContent =
    state.myBid === undefined ? 'Choisis un nombre' : 'Annonce enregistrée — modifiable';
  bidChoices.appendChild(hint);
}

function renderTurnIndicator(state) {
  if (state.phase === 'power') {
    turnIndicator.textContent = ''; // le bandeau de pouvoir porte déjà le message
    return;
  }
  if (state.phase === 'bidding') {
    if (state.myBid === undefined) {
      turnIndicator.textContent = '🎯 Combien de plis vas-tu remporter cette manche ?';
    } else {
      const waiting = state.players.filter((p) => !p.hasBid).map((p) => p.nickname);
      turnIndicator.textContent = waiting.length
        ? `Annonce envoyée (${state.myBid}) — tu peux encore changer d'avis tant que tout le monde n'a pas annoncé. En attente de : ${waiting.join(', ')}…`
        : 'Tout le monde a annoncé, révélation…';
    }
    return;
  }
  if (state.trickPaused) {
    turnIndicator.textContent = 'Le pli se ramasse…';
    return;
  }
  if (state.sittingOutThisTrick) {
    turnIndicator.textContent = '💣 Tu as joué la Dernière Salve : tu passes ton tour sur ce pli.';
    return;
  }
  if (!state.isMyTurn) {
    turnIndicator.textContent = `${nicknameOf(state, state.turnPlayerId)} joue…`;
    return;
  }
  // En paysage on a la place de rappeler la couleur demandée dans la consigne,
  // comme sur la maquette : c'est l'info qui manque le plus au moment de jouer.
  const led = landscapeTable.matches ? ledSuitOf(state.currentTrick || []) : null;
  if (!led) {
    turnIndicator.textContent = 'À toi de jouer !';
  } else if (mustFollowSuit(state.hand || [], led)) {
    turnIndicator.textContent = `${SUIT_DOT[led]} À toi de jouer — tu dois suivre le ${led}`;
  } else {
    turnIndicator.textContent = `${SUIT_DOT[led]} À toi de jouer — tu n'as pas de ${led}, joue ce que tu veux`;
  }
}

function hideAllChoicePanels() {
  tigressChoiceEl.classList.add('hidden');
  jokerChoiceEl.classList.add('hidden');
  declareChoiceEl.classList.add('hidden');
  plankChoiceEl.classList.add('hidden');
}

function playCard(cardId, extra) {
  const payload = { cardId, ...(extra || {}) };
  socket.emit('skullking-play-card', payload);
  pendingTigressCardId = null;
  pendingJokerCardId = null;
  pendingDeclareCardId = null;
  pendingPlankCardId = null;
  hideAllChoicePanels();
}

btnTigressPirate.addEventListener('click', () => {
  if (pendingTigressCardId) playCard(pendingTigressCardId, { chosenAs: 'pirate' });
});
btnTigressEscape.addEventListener('click', () => {
  if (pendingTigressCardId) playCard(pendingTigressCardId, { chosenAs: 'escape' });
});

// --- Extension : choix au moment de la pose (Joker, 0/14, Marcher sur la Planche) ---

const jokerChoiceEl = document.getElementById('sk-joker-choice');
const declareChoiceEl = document.getElementById('sk-declare-choice');
const plankChoiceEl = document.getElementById('sk-plank-choice');
const plankOptionsEl = document.getElementById('sk-plank-options');
let pendingJokerCardId = null;
let pendingDeclareCardId = null;
let pendingPlankCardId = null;

document.querySelectorAll('.sk-btn-joker-color').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (pendingJokerCardId) playCard(pendingJokerCardId, { chosenSuit: btn.dataset.suit });
  });
});
document.getElementById('sk-btn-declare-0').addEventListener('click', () => {
  if (pendingDeclareCardId) playCard(pendingDeclareCardId, { declaredValue: 0 });
});
document.getElementById('sk-btn-declare-14').addEventListener('click', () => {
  if (pendingDeclareCardId) playCard(pendingDeclareCardId, { declaredValue: 14 });
});

// Mode spécial du pouvoir de Will le Bandit : au lieu de jouer une carte, on
// clique pour choisir 2 cartes à défausser dans sa main (les 2 piochées y
// sont déjà mêlées).
let willDiscardSelection = new Set();
let willConfirmBtn = null;

function updateWillConfirmButton() {
  if (!willConfirmBtn) return;
  willConfirmBtn.textContent = `Défausser (${willDiscardSelection.size}/2 choisies)`;
  willConfirmBtn.disabled = willDiscardSelection.size !== 2;
}

function renderHand(state) {
  handEl.innerHTML = '';
  const hand = sortHandForDisplay(state.hand || []);
  const canPlay = state.phase === 'playing' && state.isMyTurn;
  const willMode = state.phase === 'power' && state.pendingPower && state.pendingPower.kind === 'will' && state.pendingPower.mine;
  const trick = state.currentTrick || [];

  const n = hand.length;
  const maxSpread = Math.min(6 * Math.max(n - 1, 0), 40);
  const step = n > 1 ? maxSpread / (n - 1) : 0;

  hand.forEach((card, i) => {
    const angle = n > 1 ? -maxSpread / 2 + i * step : 0;
    const normalized = n > 1 ? Math.abs(i - (n - 1) / 2) / ((n - 1) / 2) : 0;
    const lift = normalized * normalized * 14;

    const arc = document.createElement('div');
    arc.className = 'sk-card-arc';
    arc.style.transform = `rotate(${angle}deg) translateY(${lift}px)`;

    const el = document.createElement('div');
    el.className = `sk-card ${cardClass(card)}`;
    el.innerHTML = cardFaceHTML(card);
    attachPowerTooltip(el, card);
    // Pouvoir de Mary Thorne : une seule carte précise reste jouable, peu
    // importe la couleur imposée ou tout autre effet.
    const playable = !canPlay || (state.forcedCardId ? card.id === state.forcedCardId : isCardPlayable(card, hand, trick));
    if (canPlay && !playable) {
      el.classList.add('sk-card--unplayable');
      el.title = state.forcedCardId
        ? 'Le pouvoir de Mary Thorne t\'oblige à jouer une autre carte précise ce pli-ci.'
        : 'Tu dois suivre la couleur demandée : cette carte est bloquée tant que tu en as une en main.';
    }
    if (willMode) {
      if (willDiscardSelection.has(card.id)) el.classList.add('sk-card--selected');
      el.addEventListener('click', () => {
        if (willDiscardSelection.has(card.id)) willDiscardSelection.delete(card.id);
        else if (willDiscardSelection.size < 2) willDiscardSelection.add(card.id);
        renderHand(state);
        updateWillConfirmButton();
      });
    } else if (canPlay && !playable) {
      el.addEventListener('click', () =>
        showToast(state.forcedCardId ? '🚫 Mary Thorne t\'oblige à jouer une autre carte.' : '🚫 Tu dois suivre la couleur demandée.')
      );
    } else if (canPlay) {
      el.addEventListener('click', () => {
        if (card.kind === 'tigress') {
          pendingTigressCardId = card.id;
          hideAllChoicePanels();
          tigressChoiceEl.classList.remove('hidden');
          bidChoices.classList.add('hidden');
          return;
        }
        // 0/14 : la valeur n'est jamais fixée avant la pose.
        if (card.kind === 'number' && card.wild14 && card.value == null) {
          pendingDeclareCardId = card.id;
          hideAllChoicePanels();
          declareChoiceEl.classList.remove('hidden');
          bidChoices.classList.add('hidden');
          return;
        }
        // Joker : choix de couleur seulement si rien n'est encore imposé
        // (sinon le serveur prend directement la couleur déjà imposée, ou
        // le laisse sans couleur si c'est le noir).
        if (card.kind === 'wild15') {
          const led = ledSuitOf(trick);
          if (led === null) {
            pendingJokerCardId = card.id;
            hideAllChoicePanels();
            jokerChoiceEl.classList.remove('hidden');
            bidChoices.classList.add('hidden');
            return;
          }
          playCard(card.id);
          return;
        }
        // Marcher sur la Planche : choix du Pirate à retirer seulement s'il
        // y en a plusieurs dans le pli en cours.
        if (card.kind === 'plank') {
          const piratesInTrick = trick.filter((t) => t.card.kind === 'pirate');
          if (piratesInTrick.length > 1) {
            pendingPlankCardId = card.id;
            hideAllChoicePanels();
            plankOptionsEl.innerHTML = '';
            piratesInTrick.forEach((t) => {
              const btn = document.createElement('button');
              btn.className = 'btn';
              btn.textContent = t.card.name || 'Pirate';
              btn.addEventListener('click', () => {
                if (pendingPlankCardId) playCard(pendingPlankCardId, { removesId: t.card.id });
              });
              plankOptionsEl.appendChild(btn);
            });
            plankChoiceEl.classList.remove('hidden');
            bidChoices.classList.add('hidden');
            return;
          }
          playCard(card.id);
          return;
        }
        playCard(card.id);
      });
    }

    arc.appendChild(el);
    handEl.appendChild(arc);
  });
}

function renderScoreboard(state) {
  scoreboardRows.innerHTML = '';
  const byId = new Map(state.players.map((p) => [p.id, p]));
  [...state.scoreboard]
    .sort((a, b) => b.total - a.total)
    .forEach((s) => {
      const row = document.createElement('div');
      row.className = 'sk-score-row' + (s.id === myId ? ' sk-score-row--me' : '');
      const name = document.createElement('span');
      name.className = 'sk-score-row-name';
      name.textContent = s.nickname;
      const total = document.createElement('span');
      total.className = 'sk-score-row-total';
      total.textContent = s.total;
      row.appendChild(name);

      // Colonne plis/annonce : en paysage le tableau devient le vrai poste de
      // pilotage, on y lit d'un coup qui tient son contrat et qui l'a déjà raté.
      const p = byId.get(s.id);
      if (p) {
        const bidState = bidStateSuffix(state, p);
        const bidEl = document.createElement('span');
        bidEl.className = 'sk-score-row-bid' + (bidState ? ` sk-score-row-bid${bidState}` : '');
        if (state.phase === 'bidding') bidEl.textContent = p.hasBid ? '✓' : '…';
        else bidEl.textContent = p.bid === undefined || p.bid === null ? '–' : `${p.tricksWon}/${p.bid}`;
        row.appendChild(bidEl);
      }

      row.appendChild(total);
      scoreboardRows.appendChild(row);
    });

  sideFoot.textContent =
    state.phase === 'bidding'
      ? 'Annonce tenue = 20 pts par pli. Ratée = −10 pts par pli d’écart.'
      : 'Vert = annonce tenue à cet instant · rouge = déjà dépassée.';

  // Piste de manches en segments (paysage) : on voit d'un coup d'œil combien
  // de manches sont derrière soi et laquelle est en cours.
  sideRound.textContent =
    `Manche ${state.roundNumber} / ${state.totalRounds}` +
    ` — ${state.cardsInRound} carte${state.cardsInRound > 1 ? 's' : ''}`;
  roundSegments.innerHTML = '';
  for (let i = 1; i <= state.totalRounds; i++) {
    const seg = document.createElement('i');
    if (i < state.roundNumber) seg.className = 'sk-round-seg--done';
    else if (i === state.roundNumber) seg.className = 'sk-round-seg--now';
    roundSegments.appendChild(seg);
  }

  const progress = state.totalRounds > 1 ? (state.roundNumber - 1) / (state.totalRounds - 1) : 0;
  roundTrackFill.style.width = `${progress * 100}%`;
  roundTrackKnob.style.left = `${progress * 100}%`;
  roundTrackKnob.textContent = state.roundNumber;
  roundTrackLabel.textContent = `${state.cardsInRound} carte${state.cardsInRound > 1 ? 's' : ''} par joueur`;
}

// --- Pouvoirs des pirates nommés ---

const powerBanner = document.getElementById('sk-power-banner');
const powerPanel = document.getElementById('sk-power-panel');
const POWER_LABEL = {
  rosie: "Rosie D'Laney",
  will: 'Will le Bandit',
  rascal: 'Rascal le Flambeur',
  juanita: 'Juanita Jade',
  harry: 'Harry le Géant',
  marythorne: 'Mary Thorne',
};

function renderPower(state) {
  powerBanner.classList.add('hidden');
  powerPanel.classList.add('hidden');
  powerPanel.innerHTML = '';
  willConfirmBtn = null;

  const pending = state.pendingPower;
  if (state.phase !== 'power' || !pending) {
    willDiscardSelection.clear();
    return;
  }

  powerBanner.textContent = `🏴‍☠️ ${nicknameOf(state, pending.playerId)} déclenche le pouvoir de ${POWER_LABEL[pending.kind]} !`;
  powerBanner.classList.remove('hidden');

  if (!pending.mine) {
    willDiscardSelection.clear();
    return;
  }
  powerPanel.classList.remove('hidden');

  const hint = document.createElement('p');
  hint.className = 'hint';
  powerPanel.appendChild(hint);

  if (pending.kind === 'rosie') {
    hint.textContent = 'Qui entame le pli suivant ?';
    pending.options.forEach((o) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = o.id === myId ? `${o.nickname} (toi)` : o.nickname;
      btn.addEventListener('click', () => socket.emit('skullking-power-rosie', { leaderId: o.id }));
      powerPanel.appendChild(btn);
    });
  } else if (pending.kind === 'marythorne') {
    hint.textContent = "Dans la main de qui tirer une carte au hasard (à jouer obligatoirement au pli suivant) ?";
    pending.options.forEach((o) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.disabled = o.handCount === 0;
      btn.textContent = `${o.id === myId ? `${o.nickname} (toi)` : o.nickname} — ${o.handCount} carte${o.handCount > 1 ? 's' : ''}`;
      btn.addEventListener('click', () => socket.emit('skullking-power-marythorne', { targetId: o.id }));
      powerPanel.appendChild(btn);
    });
  } else if (pending.kind === 'rascal') {
    hint.textContent = 'Mise secondaire sur ta propre annonce de cette manche :';
    [0, 10, 20].forEach((stake) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = stake === 0 ? 'Ne pas miser' : `Miser ${stake}`;
      btn.addEventListener('click', () => socket.emit('skullking-power-rascal', { stake }));
      powerPanel.appendChild(btn);
    });
  } else if (pending.kind === 'harry') {
    hint.textContent = `Ton annonce actuelle : ${pending.currentBid}. La modifier ?`;
    [-1, 0, 1].forEach((delta) => {
      const newBid = pending.currentBid + delta;
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = delta === 0 ? 'Ne pas changer' : `${delta > 0 ? '+1' : '-1'} (→ ${newBid})`;
      btn.disabled = newBid < 0 || newBid > state.cardsInRound;
      btn.addEventListener('click', () => socket.emit('skullking-power-harry', { delta }));
      powerPanel.appendChild(btn);
    });
  } else if (pending.kind === 'juanita') {
    hint.textContent = 'Cartes non distribuées ce tour-ci :';
    const row = document.createElement('div');
    row.className = 'sk-hand';
    (pending.revealCards || []).forEach((card) => {
      const el = document.createElement('div');
      el.className = `sk-card ${cardClass(card)}`;
      el.innerHTML = cardFaceHTML(card);
      attachPowerTooltip(el, card);
      row.appendChild(el);
    });
    powerPanel.appendChild(row);
  } else if (pending.kind === 'will') {
    hint.textContent = 'Les 2 cartes piochées sont dans ta main : choisis 2 cartes à défausser ci-dessous.';
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn';
    confirmBtn.disabled = true;
    confirmBtn.addEventListener('click', () => {
      if (willDiscardSelection.size === 2) {
        socket.emit('skullking-power-will', { discardIds: [...willDiscardSelection] });
        willDiscardSelection.clear();
      }
    });
    powerPanel.appendChild(confirmBtn);
    willConfirmBtn = confirmBtn;
    updateWillConfirmButton();
  }
}

// Petite pile au centre de la table qui distribue une carte à chacun, dans
// l'ordre des sièges, au tout début de chaque manche — purement décoratif
// (le serveur a déjà distribué les vraies mains). Plafonné à quelques tours
// de distribution : à 7 joueurs sur la manche 10, animer les 70 cartes une
// par une traînerait inutilement en longueur.
let lastDealAnimatedRound = null;
const DEAL_MAX_WAVES = 5;
const DEAL_WAVE_MS = 190;
const DEAL_FLIGHT_MS = 620;

const roundStartBanner = document.getElementById('sk-round-start-banner');
const roundStartText = document.getElementById('sk-round-start-text');
let roundStartTimer = null;

// Bannière éphémère "Manche N", en plus du compteur permanent en haut de
// l'écran — juste pour marquer le coup au changement de manche.
function showRoundStartBanner(roundNumber) {
  clearTimeout(roundStartTimer);
  roundStartText.textContent = `Manche ${roundNumber}`;
  roundStartBanner.classList.remove('hidden');
  // Relance l'animation CSS même si la bannière était déjà affichée.
  const span = roundStartText;
  span.style.animation = 'none';
  void span.offsetWidth;
  span.style.animation = '';
  roundStartTimer = setTimeout(() => roundStartBanner.classList.add('hidden'), 1800);
}

// --- Révélation des annonces ---
// La phase serveur passe de 'bidding' à 'playing' en un seul saut dès la
// dernière annonce reçue (voir skullking-room.js) : sans ce petit temps fort
// après coup, les chiffres apparaissaient tous en même temps dans le tableau
// des scores, sans qu'on ait eu le temps de les lire.
const bidRevealEl = document.getElementById('sk-bid-reveal');
const bidRevealRows = document.getElementById('sk-bid-reveal-rows');
let bidRevealTimer = null;
let lastPhase = null;

function showBidReveal(state) {
  clearTimeout(bidRevealTimer);
  bidRevealRows.innerHTML = '';
  state.players.forEach((p, i) => {
    const row = document.createElement('span');
    row.className = 'sk-bid-reveal-row';
    row.style.setProperty('--sk-bid-delay', `${i * 0.12}s`);
    row.innerHTML = `${p.id === myId ? 'Toi' : p.nickname} <b>${p.bid}</b>`;
    bidRevealRows.appendChild(row);
  });
  bidRevealEl.classList.remove('hidden');
  bidRevealTimer = setTimeout(() => bidRevealEl.classList.add('hidden'), 1900 + state.players.length * 120);
}

function maybeAnimateDeal(state) {
  if (state.phase !== 'bidding' || state.roundNumber === lastDealAnimatedRound) return;
  lastDealAnimatedRound = state.roundNumber;
  showRoundStartBanner(state.roundNumber);

  const { ordered, map } = seatLayout(state);
  const waves = Math.min(state.cardsInRound, DEAL_MAX_WAVES);

  const pile = document.createElement('div');
  pile.className = 'sk-deck-pile';
  tableEl.appendChild(pile);

  let i = 0;
  for (let w = 0; w < waves; w++) {
    ordered.forEach((p) => {
      const [left, top] = map.get(p.id);
      const card = document.createElement('div');
      card.className = 'sk-flying-card';
      tableEl.appendChild(card);
      const anim = card.animate(
        [
          { left: '50%', top: '50%', transform: 'translate(-50%, -50%) scale(0.8)', opacity: 0 },
          { left: '50%', top: '50%', transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.15 },
          { left: `${left}%`, top: `${top}%`, transform: 'translate(-50%, -50%) scale(0.8)', opacity: 1 },
        ],
        { duration: DEAL_FLIGHT_MS, delay: i * DEAL_WAVE_MS, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' }
      );
      anim.onfinish = () => card.remove();
      i += 1;
    });
  }
  setTimeout(() => pile.remove(), i * DEAL_WAVE_MS + DEAL_FLIGHT_MS + 150);
}

function renderGame(state) {
  latestState = state;
  // Un re-rendu retire les cartes du DOM sans forcément déclencher mouseleave
  // (ex: une carte jouée disparaît sous le curseur) : la bulle resterait
  // affichée sur rien sans ce reset.
  hideCardTooltip();
  renderRoundIndicator(state);
  btnEndGame.classList.toggle('hidden', !state.isHost);
  maybeAnimateDeal(state);
  renderSeats(state);
  renderTrick(state);
  renderBidChoices(state);
  renderPower(state);
  renderTurnIndicator(state);
  renderHand(state);
  renderScoreboard(state);
}

// Basculer entre portrait et paysage change la géométrie du tapis : on
// redessine pour que les sièges suivent au lieu de rester sur l'ancienne table.
landscapeTable.addEventListener('change', () => {
  if (latestState) renderGame(latestState);
});

btnEndGame.addEventListener('click', () => socket.emit('skullking-end-game'));

// --- Pop-up de fin de manche ---

const roundPopup = document.getElementById('sk-round-popup');
const roundPopupTitle = document.getElementById('sk-round-popup-title');
const roundPopupRows = document.getElementById('sk-round-popup-rows');
const roundPopupBar = document.getElementById('sk-round-popup-bar');
const btnNextRound = document.getElementById('sk-btn-next-round');

btnNextRound.addEventListener('click', () => socket.emit('skullking-next-round'));

// Détail du calcul (contrat + bonus + mise Rascal + alliance Butin) : sans
// ça le delta total n'explique rien, surtout quand un bonus de capture
// (14/Pirates/Skull King) ou un pouvoir a modifié le résultat.
function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}
function roundBreakdownText(r) {
  const parts = [`${signed(r.base)} contrat`];
  if (r.bonus) parts.push(`${signed(r.bonus)} bonus`);
  if (r.rascalDelta) parts.push(`${signed(r.rascalDelta)} mise Rascal`);
  if (r.lootBonus) parts.push(`${signed(r.lootBonus)} alliance Butin`);
  return parts.join(' · ');
}

const LOOT_LINK_COLORS = ['#facc15', '#4ade80', '#38bdf8'];

// Trace un lien entre les deux lignes d'une alliance Butin, même si d'autres
// joueurs s'intercalent entre elles dans le classement - un simple badge de
// couleur assorti sur chaque ligne ne suffirait pas à dire QUI est lié à qui.
function drawLootLinks(links) {
  if (!links || !links.length) return;
  const container = roundPopupRows;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sk-loot-links');
  const containerRect = container.getBoundingClientRect();

  links.forEach((link, i) => {
    const rowA = container.querySelector(`[data-player-id="${link.a}"]`);
    const rowB = container.querySelector(`[data-player-id="${link.b}"]`);
    if (!rowA || !rowB) return;
    const color = LOOT_LINK_COLORS[i % LOOT_LINK_COLORS.length];
    rowA.classList.add('sk-round-popup-row--loot');
    rowB.classList.add('sk-round-popup-row--loot');
    rowA.style.setProperty('--sk-loot-color', color);
    rowB.style.setProperty('--sk-loot-color', color);

    const rectA = rowA.getBoundingClientRect();
    const rectB = rowB.getBoundingClientRect();
    const yA = rectA.top - containerRect.top + rectA.height / 2;
    const yB = rectB.top - containerRect.top + rectB.height / 2;
    const x = -4 - i * 6; // décale les liens successifs pour ne jamais se superposer
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'sk-loot-link-path');
    path.setAttribute('stroke', color);
    path.setAttribute('d', `M -1 ${yA} C ${x} ${yA}, ${x} ${yB}, -1 ${yB}`);
    svg.appendChild(path);

    const coin = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    coin.setAttribute('class', 'sk-loot-link-coin');
    coin.setAttribute('x', x - 2);
    coin.setAttribute('y', (yA + yB) / 2 + 3);
    coin.setAttribute('text-anchor', 'middle');
    coin.textContent = '💰';
    svg.appendChild(coin);
  });

  container.prepend(svg);
}

function showRoundPopup(state) {
  const summary = state.roundSummary;
  roundPopupTitle.textContent = `Manche ${summary.round} terminée`;
  roundPopupRows.innerHTML = '';

  [...summary.results]
    .sort((a, b) => b.delta - a.delta)
    .forEach((r) => {
      const row = document.createElement('div');
      row.className = 'sk-round-popup-row';
      row.dataset.playerId = r.id;
      const left = document.createElement('div');
      left.className = 'sk-round-popup-row-left';
      left.innerHTML = `${r.nickname} <span class="sk-round-popup-row-detail">— annoncé ${r.bid}, fait ${r.made}</span><span class="sk-round-popup-row-breakdown">${roundBreakdownText(r)}</span>`;
      const delta = document.createElement('span');
      delta.className = `sk-round-popup-row-delta ${r.delta >= 0 ? 'sk-delta--up' : 'sk-delta--down'}`;
      delta.textContent = r.delta >= 0 ? `+${r.delta}` : r.delta;
      row.appendChild(left);
      row.appendChild(delta);
      roundPopupRows.appendChild(row);
    });

  btnNextRound.classList.toggle('hidden', !myIsHost);
  roundPopup.classList.remove('hidden');
  // Doit passer APRES l'affichage de la popup : tant qu'elle est display:none,
  // les lignes du tableau n'ont pas de vraie position (getBoundingClientRect
  // ne renverrait que des zéros).
  drawLootLinks(summary.lootLinks);

  const ms = state.roundEndMs || 7000;
  roundPopupBar.style.transition = 'none';
  roundPopupBar.style.transform = 'scaleX(1)';
  requestAnimationFrame(() => {
    roundPopupBar.style.transition = `transform ${ms}ms linear`;
    roundPopupBar.style.transform = 'scaleX(0)';
  });
}

function hideRoundPopup() {
  roundPopup.classList.add('hidden');
}

// --- Fin de partie ---

const endTitle = document.getElementById('sk-end-title');
const endBody = document.getElementById('sk-end-body');

function renderGameEnd(state) {
  const ranking = state.finalRanking;
  const winner = ranking[0];
  endTitle.textContent = winner.id === myId ? 'Tu remportes la partie ! 🏆' : `${winner.nickname} remporte la partie !`;
  endBody.innerHTML = ranking.map((r) => `<tr><td>${r.nickname}</td><td>${r.total}</td></tr>`).join('');
}

document.getElementById('sk-btn-rematch').addEventListener('click', () => socket.emit('skullking-rematch'));

// --- Roue de tirage au sort : qui mène le tout premier pli ---
// Même principe que le Rami (les secteurs sont fixes, seule la flèche
// tourne), généralisé à N joueurs : un secteur par joueur, étiquette posée à
// l'extérieur de la roue. Ne joue qu'une fois par partie, sur la toute
// première annonce de la manche 1 (voir applyState) - startRevealPlayed est
// réarmé à chaque retour au salon (nouvelle partie ou revanche).
const START_WHEEL_COLORS = [
  '#4ade80', '#facc15', '#c084fc', '#38bdf8', '#f87171', '#fb923c', '#a3e635', '#f472b6', '#94a3b8',
];

function playStartReveal(players, starterId) {
  const overlay = document.getElementById('sk-start-reveal');
  const wheel = document.getElementById('sk-wheel');
  const needle = document.getElementById('sk-wheel-needle');
  const labelsEl = document.getElementById('sk-wheel-labels');
  const text = document.getElementById('sk-start-reveal-text');
  if (!overlay || !players.length) return;

  const n = players.length;
  const step = 360 / n;
  const winnerIndex = Math.max(0, players.findIndex((p) => p.id === starterId));
  const starter = players[winnerIndex];

  const stops = players
    .map((_, i) => `${START_WHEEL_COLORS[i % START_WHEEL_COLORS.length]} ${(i * step).toFixed(2)}deg ${((i + 1) * step).toFixed(2)}deg`)
    .join(', ');
  wheel.style.background = `conic-gradient(${stops})`;

  // Étiquettes à l'extérieur de la roue, à l'angle du centre de leur secteur
  // (0° = en haut, sens horaire) - même convention que la rotation de la
  // flèche ci-dessous, pour que l'aiguille s'arrête pile devant le bon nom.
  labelsEl.innerHTML = '';
  const cx = 130;
  const cy = 130;
  const R = 108;
  players.forEach((p, i) => {
    const center = (i + 0.5) * step;
    const rad = (center * Math.PI) / 180;
    const tag = document.createElement('span');
    tag.className = 'sk-wheel-tag';
    tag.textContent = p.nickname;
    tag.style.left = `${cx + R * Math.sin(rad)}px`;
    tag.style.top = `${cy - R * Math.cos(rad)}px`;
    labelsEl.appendChild(tag);
  });

  text.textContent = '';
  text.classList.remove('sk-visible');
  overlay.classList.remove('hidden');

  const target = 5 * 360 + (winnerIndex + 0.5) * step;

  needle.style.transition = 'none';
  needle.style.transform = 'rotate(0deg)';

  // Double rAF : garantit que l'état de repos (0°) est bien peint avant de
  // lancer la transition, sinon le tout premier chargement peut "sauter"
  // directement à l'état final (bug déjà rencontré sur la roue du Rami).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      needle.style.transition = '';
      needle.style.transform = `rotate(${target}deg)`;
    });
  });

  setTimeout(() => {
    const tags = labelsEl.querySelectorAll('.sk-wheel-tag');
    if (tags[winnerIndex]) tags[winnerIndex].classList.add('sk-wheel-tag--winner');
    text.textContent = `🎯 ${starter ? starter.nickname : '???'} mène le premier pli !`;
    text.classList.add('sk-visible');
  }, 2150);
  setTimeout(() => overlay.classList.add('hidden'), 3400);
}

// --- Dispatch d'état ---

function applyState(state) {
  const previousPhase = lastPhase;
  lastPhase = state.phase;
  myId = state.myId;
  myIsHost = state.isHost;
  showReconnectingOverlay(false);
  joinModal.classList.add('hidden');
  hideAllChoicePanels();
  pendingTigressCardId = null;
  pendingJokerCardId = null;
  pendingDeclareCardId = null;
  pendingPlankCardId = null;

  if (state.phase === 'bidding' || state.phase === 'playing' || state.phase === 'power') {
    hideRoundPopup();
    showScreen('game');
    renderGame(state);
    if (state.roundNumber === 1 && !startRevealPlayed) {
      startRevealPlayed = true;
      playStartReveal(state.players, state.leaderPlayerId);
    }
    // La toute première annonce venant de tomber (transition bidding → tout
    // le reste) : c'est le seul instant où toutes les annonces sont neuves
    // pour tout le monde en même temps.
    if (state.phase !== 'bidding' && previousPhase === 'bidding') {
      showBidReveal(state);
    }
    return;
  }
  if (state.phase === 'round-end') {
    showScreen('game');
    showRoundPopup(state);
    return;
  }
  if (state.phase === 'game-end') {
    hideRoundPopup();
    showScreen('end');
    renderGameEnd(state);
  }
}

socket.on('skullking-state', applyState);
socket.on('skullking-rejoin-ok', applyState);

socket.on('skullking-player-disconnected', ({ nickname }) => {
  showToast(`🔌 ${nickname} a une connexion instable…`);
});

socket.on('skullking-player-reconnected', ({ nickname }) => {
  showToast(`✅ ${nickname} est de retour !`);
});

socket.on('skullking-rejoin-failed', (payload) => {
  clearActiveRoom();
  showReconnectingOverlay(false);
  // Distingue "ce salon n'a jamais existe" (code invalide) de "le serveur a
  // redemarre et a perdu son etat" (hebergement gratuit qui se met en veille) -
  // sinon un joueur revenant apres une pause pense avoir tape le mauvais code.
  if (payload && payload.reason === 'server-restarted') {
    showToast("😴 Le serveur a redémarré entre-temps — cette partie a été perdue, il faut en relancer une.");
  }
  const fallback = rejoinFallback;
  rejoinFallback = null;
  if (fallback && fallback !== 'link') {
    myNickname = fallback.nickname;
    socket.emit('skullking-join-room', { code: fallback.code, nickname: fallback.nickname, token: getPlayerToken() });
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
});

socket.on('connect', () => {
  attemptAutoRejoin(roomFromUrl ? 'link' : null);
});

// --- Choix accueil / rejoindre via lien ---

const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('room');

function attemptAutoRejoin(fallback) {
  const saved = loadActiveRoom();
  const code = (roomFromUrl && roomFromUrl.toUpperCase()) || (saved && saved.code);
  if (!code || !saved || saved.code !== code) return false;
  rejoinFallback = fallback || null;
  showReconnectingOverlay(true);
  socket.emit('skullking-rejoin-room', { code, token: getPlayerToken() });
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
