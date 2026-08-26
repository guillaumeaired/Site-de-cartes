const socket = io();

// Les pseudos ne sont que tronqués côté serveur (sanitizeNickname), jamais
// échappés : tout pseudo inséré dans un innerHTML doit passer par ici, sinon
// un pseudo contenant du HTML s'exécute chez tous les autres joueurs de la
// table.
function escapeHTML(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

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
  // Nouveau salon = nouvelle table : la préférence de pièce sera reproposée.
  piecePrefApplied = false;
  sessionStorage.removeItem(ACTIVE_ROOM_KEY);
}

// Plus d'emoji sur les cartes : dans l'éventail, chaque carte est recouverte
// par la suivante et emoji + libellé ne tenaient pas dans la bande visible
// (« Skull Kin », « Harry le Gé »). Il ne reste qu'un libellé COURT, calé
// dans cette bande - le nom complet reste dans l'infobulle au survol.
const SPECIAL_INFO = {
  pirate: { label: 'Pirate' },
  siren: { label: 'Sirène' },
  skullking: { label: 'Skull King' },
  escape: { label: 'Fuite' },
  tigress: { label: 'Tigresse' },
  loot: { label: 'Butin' },
  kraken: { label: 'Kraken' },
  whale: { label: 'Baleine' },
  // Extension
  firstmate: { label: 'Mat le Forban' },
  stingray: { label: 'Raie' },
  lastvolley: { label: 'Salve' },
  plank: { label: 'Planche' },
  davyjones: { label: 'Coffre' },
};

// Les pirates nommés portent leur nom sur la carte : raccourci à un seul mot
// distinctif, sinon rien ne tient dans la bande visible de l'éventail.
const PIRATE_SHORT_NAME = {
  "Rosie D'Laney": 'Rosie',
  'Will le Bandit': 'Will',
  'Rascal le Flambeur': 'Rascal',
  'Juanita Jade': 'Juanita',
  'Harry le Géant': 'Harry',
  'Mary Thorne': 'Mary',
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

// Code couleur des cartes spéciales : rouge = famille Pirate (elle prend le
// pli), bleu = famille Fuite (elle y renonce). La Tigresse, qui est l'une ou
// l'autre au choix, est coupée en deux — et une fois son choix connu elle
// bascule dans la couleur correspondante (voir stateFor côté serveur : le
// choix n'est révélé aux autres qu'une fois le pli résolu).
function cardClass(card) {
  if (card.kind === 'hidden') return 'sk-card--hidden';
  if (card.kind === 'wild15' || card.wild15) return 'sk-card--wild15';
  if (card.kind === 'number') {
    if (card.wild14 && card.value == null) return 'sk-card--wild14';
    return `sk-card--${card.suit}`;
  }
  if (card.kind === 'pirate' || card.kind === 'firstmate') return 'sk-card--pirate';
  if (card.kind === 'escape') return 'sk-card--escape';
  if (card.kind === 'tigress') {
    if (card.chosenAs === 'pirate') return 'sk-card--tigress sk-card--tigress-pirate';
    if (card.chosenAs === 'escape') return 'sk-card--tigress sk-card--tigress-escape';
    return 'sk-card--tigress';
  }
  return 'sk-card--special';
}
function cardFaceHTML(card) {
  // Ta propre carte pendant l'annonce de la manche 1 : dos de carte marqué
  // d'un « ? » pour que ce soit lisible comme un choix de règle et pas comme
  // un bug d'affichage (le contenu n'est même pas envoyé par le serveur -
  // voir stateFor, seul l'id accompagne la carte).
  if (card.kind === 'hidden') return '<span class="sk-hidden-mark">?</span>';
  if (card.kind === 'wild15') {
    // Pas encore joué : sa couleur/valeur ne sont pas encore fixées.
    return `<span class="sk-special-label">Joker</span>`;
  }
  if (card.kind === 'number') {
    if (card.wild14 && card.value == null) {
      return `<span class="card-emblem card-emblem--wild">0/14</span>`;
    }
    return `<span class="card-emblem">${card.value}</span>`;
  }
  const info = SPECIAL_INFO[card.kind];
  let label = card.kind === 'pirate' ? PIRATE_SHORT_NAME[card.name] || 'Pirate' : info.label;
  // Une fois la décision de la Tigresse connue, la carte le dit : sans ça on
  // voyait bien qu'elle avait été jouée, jamais en quoi elle s'était changée.
  if (card.kind === 'tigress' && card.chosenAs) {
    label = card.chosenAs === 'pirate' ? 'Tigresse Pirate' : 'Tigresse Fuite';
  }
  return `<span class="sk-special-label">${label}</span>`;
}

// Texte d'infobulle (survol). Toutes les cartes en ont une, y compris celles
// dont le comportement se résume à leur place dans la hiérarchie : il en
// manquait, et ne rien afficher laissait croire à un oubli plutôt qu'à un
// choix. Une carte sans texte n'attache simplement aucune bulle (voir
// attachPowerTooltip), ce qui ne concerne plus que le dos de carte.
function cardPowerText(card) {
  switch (card.kind) {
    case 'pirate':
      return card.name && PIRATE_POWER_TEXT[card.name]
        ? `${card.name} — s'il/elle remporte le pli : ${PIRATE_POWER_TEXT[card.name]}`
        : "Pirate — bat toutes les cartes numérotées et les Sirènes. Seul le Skull King le bat.";
    case 'siren':
      return "Sirène — bat toutes les cartes numérotées, mais perd contre un Pirate. Elle bat en revanche le Skull King : c'est la seule carte à le faire.";
    case 'skullking':
      return "Skull King — bat les Pirates et toutes les cartes numérotées, et hérite du pouvoir de chaque Pirate qu'il capture. Seule une Sirène peut le battre.";
    case 'escape':
      return "Fuite — ne remporte jamais le pli et n'impose aucune couleur. À jouer quand on veut surtout ne pas gagner. Si tout le monde fuit, la première Fuite posée ramasse.";
    case 'tigress':
      return "Tigresse — au moment de la poser, tu choisis : Pirate (elle prend le pli) ou Fuite (elle y renonce). Les autres joueurs ne voient ton choix qu'une fois le pli résolu.";
    case 'loot':
      return "Butin — si un AUTRE joueur remporte le pli, vous formez une alliance : +20 points chacun si vous réussissez tous les deux votre annonce de la manche.";
    case 'kraken':
      return 'Kraken — détruit le pli : personne ne le gagne. Le pli suivant est mené par qui aurait gagné sans lui.';
    case 'whale':
      return "Baleine blanche — annule l'effet de toutes les cartes spéciales du pli : seule la valeur numérique compte, le noir perd son statut d'atout. La plus haute valeur l'emporte, et à égalité le premier à l'avoir posée.";
    case 'firstmate':
      return "Mat le Forban — se comporte comme un Pirate, et s'il remporte le pli il hérite du/des pouvoir(s) du/des Pirate(s) capturé(s).";
    case 'stingray':
      return "Raie Tachetée — comme la Baleine blanche, mais c'est la carte la PLUS BASSE qui remporte le pli (à égalité, la première posée).";
    case 'lastvolley':
      return "Dernière Salve — ne remporte jamais le pli. Le joueur qui la pose joue une carte de plus après tout le monde, puis passe son tour au pli suivant (sauf sur le tout dernier pli de la manche).";
    case 'plank':
      return "Marcher sur la Planche — ne remporte jamais le pli, mais retire un Pirate présent dans le pli en cours (au choix s'il y en a plusieurs).";
    case 'davyjones':
      return 'Coffre de Davy Jones — ne remporte jamais le pli. Détruit tous les Monstres Marins présents (Kraken, Baleine, Raie) : +20 points par Monstre détruit.';
    case 'wild15':
      return "Joker — tu choisis sa couleur au moment de la poser (sauf si une couleur est déjà imposée). Il vaut alors 15, la plus haute valeur du jeu.";
    case 'number': {
      if (card.wild14 && card.value == null) {
        return "0 ou 14 — au moment de la poser, tu décides si elle vaut 0 (elle perd toujours) ou 14 (carte forte, qui rapporte un bonus si tu remportes le pli).";
      }
      const noir = card.suit === 'noir';
      const base = noir
        ? 'Carte noire — le noir est atout : il bat les trois autres couleurs.'
        : 'Carte numérotée — la plus haute de la couleur demandée remporte le pli, sauf si du noir est joué (le noir est atout).';
      if (card.value === 14) return `${base} Un 14 remporté rapporte un bonus de ${noir ? 20 : 10} points si ton annonce est réussie.`;
      if (card.ext && card.value === 8) return `${base} Ce 8 d'extension rapporte +5 points à qui remporte le pli.`;
      if (card.ext && card.value === 7) return `${base} Ce 7 d'extension coûte 5 points à qui remporte le pli.`;
      return base;
    }
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

// --- Historique des manches ---
// Le pop-up de fin de manche s'efface au bout de quelques secondes : ce
// panneau permet d'y revenir. Les données ne sont demandées qu'à l'ouverture
// (voir skullking-request-history côté serveur), pas envoyées en continu.
const historyModal = document.getElementById('sk-history-modal');
const historyBody = document.getElementById('sk-history-body');
const btnHistory = document.getElementById('sk-btn-history');

btnHistory.addEventListener('click', () => {
  historyBody.innerHTML = '<p class="hint">Chargement…</p>';
  historyModal.classList.remove('hidden');
  socket.emit('skullking-request-history');
});
document.getElementById('sk-btn-close-history').addEventListener('click', () =>
  historyModal.classList.add('hidden')
);

socket.on('skullking-history', ({ rounds }) => {
  if (!rounds || !rounds.length) {
    historyBody.innerHTML = '<p class="hint">Aucune manche terminée pour l\'instant.</p>';
    return;
  }
  const players = rounds[0].rows;
  const head = players
    .map((r) => `<th>${r.id === myId ? 'Toi' : escapeHTML(r.nickname)}</th>`)
    .join('');
  // Une ligne par manche, une colonne par joueur : « annonce/plis » puis le
  // delta de la manche, et le cumul en petit — de quoi refaire tout le match.
  const body = rounds
    .map((r) => {
      const cells = r.rows
        .map((row) => {
          const exact = row.bid === row.made;
          const delta = row.delta >= 0 ? `+${row.delta}` : `${row.delta}`;
          return `<td class="${exact ? 'sk-hist-hit' : 'sk-hist-miss'}">
              <span class="sk-hist-bid">${row.bid}/${row.made}</span>
              <span class="sk-hist-delta">${delta}</span>
              <span class="sk-hist-total">${row.total}</span>
            </td>`;
        })
        .join('');
      return `<tr><th class="sk-hist-round">${r.round}<small>${r.cards} c.</small></th>${cells}</tr>`;
    })
    .join('');
  historyBody.innerHTML = `<table class="sk-hist-table">
      <thead><tr><th></th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="hint sk-hist-legend">annonce/plis · points de la manche · cumul</p>`;
});

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
const btnAddBot = document.getElementById('sk-btn-add-bot');

// Outils de test (bots) : uniquement en local ou avec ?dev dans l'URL, pour
// qu'un vrai joueur ne tombe jamais dessus.
const DEV_TOOLS =
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  new URLSearchParams(location.search).has('dev');

btnAddBot.addEventListener('click', () => socket.emit('skullking-add-bot'));
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

// --- Choix de sa pièce dans le salon d'attente ---
// Une pièce par joueur : celles déjà prises sont montrées barrées plutôt que
// masquées, pour qu'on voie tout de suite qui a quoi. Le dernier choix est
// gardé sur cet appareil et re-proposé à la partie suivante s'il est libre.
const PIECE_PREF_KEY = 'guimams-sk-piece';
const piecePicker = document.getElementById('sk-piece-picker');
const pieceGrid = document.getElementById('sk-piece-grid');
let piecePrefApplied = false;

function renderPiecePicker(players) {
  const me = players.find((p) => p.id === myId);
  const takenBy = new Map();
  players.forEach((p) => {
    if (p.piece) takenBy.set(p.piece, p);
  });

  // Une seule fois par salon : si la pièce gardée sur cet appareil est
  // encore libre, on la reprend sans rien demander.
  if (!piecePrefApplied && me) {
    piecePrefApplied = true;
    let pref = null;
    try {
      pref = localStorage.getItem(PIECE_PREF_KEY);
    } catch (e) {
      pref = null;
    }
    if (pref && pref !== me.piece && PIECE_BY_KEY[pref] && !takenBy.has(pref)) {
      socket.emit('skullking-set-piece', { piece: pref });
      return; // le lobby suivant redessinera avec le bon choix
    }
  }

  piecePicker.classList.remove('hidden');
  pieceGrid.innerHTML = '';
  PIECES.forEach((piece) => {
    const owner = takenBy.get(piece.key);
    const mine = owner && owner.id === myId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sk-piece-btn' + (mine ? ' sk-piece-btn--mine' : '') + (owner && !mine ? ' sk-piece-btn--taken' : '');
    btn.style.setProperty('--sk-av-color', piece.color);
    btn.disabled = Boolean(owner) && !mine;
    btn.title = owner && !mine ? `${piece.label} — pris par ${owner.nickname}` : piece.label;
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = pieceSVG(piece);
    btn.addEventListener('click', () => {
      if (btn.disabled || mine) return;
      try {
        localStorage.setItem(PIECE_PREF_KEY, piece.key);
      } catch (e) {
        /* navigation privée : le choix vaut pour cette partie, sans plus */
      }
      socket.emit('skullking-set-piece', { piece: piece.key });
    });
    pieceGrid.appendChild(btn);
  });
}

socket.on('skullking-lobby-update', ({ code, players, hostId, isHost, canStart, minPlayers, maxPlayers, extensionEnabled, myId: id }) => {
  if (id) myId = id;
  saveActiveRoom(code, myNickname);
  showReconnectingOverlay(false);
  myIsHost = isHost;
  showScreen('waiting');
  joinModal.classList.add('hidden');
  lobbyPlayers.classList.remove('hidden');
  lobbyList.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    const piece = pieceFor(p);
    const badge = document.createElement('span');
    badge.className = 'sk-lobby-piece';
    badge.style.setProperty('--sk-av-color', piece.color);
    badge.innerHTML = pieceSVG(piece);
    li.appendChild(badge);
    li.appendChild(document.createTextNode(p.nickname));
    if (p.id === hostId) li.classList.add('lobby-host');
    lobbyList.appendChild(li);
  });
  renderPiecePicker(players);
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
  // Outil de test : jamais proposé aux vrais joueurs (voir DEV_TOOLS).
  btnAddBot.classList.toggle('hidden', !(DEV_TOOLS && isHost && players.length < maxPlayers));
  btnStartGame.disabled = !canStart;
  if (isHost) {
    waitingHint.textContent = canStart
      ? 'Prêt ! Lance la partie quand tu veux.'
      : `Il faut entre ${minPlayers} et ${maxPlayers} joueurs pour commencer…`;
  } else {
    waitingHint.textContent = "En attente que l'hôte lance la partie…";
  }
  // On repasse par le salon avant chaque nouvelle partie (y compris une
  // revanche) : c'est le point sûr pour réarmer la roue de tirage au sort et
  // le repère de pli déjà animé (sinon la manche 1 / pli 1 de la partie
  // suivante porterait la même clé que celui de la partie précédente).
  startRevealPlayed = false;
  lastDevouredTrick = null;
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

// Pouvoir de Pirate : bannière plein écran, pas un toast. Le toast est une
// ligne de texte gris tout en haut de la page - personne ne comprenait ce
// qui venait de se passer, alors qu'un pouvoir change la suite de la manche
// (qui mène, quelle annonce, quelle carte imposée). Will et Juanita n'en
// envoient pas : ils ne changent rien de visible pour les autres (voir
// powerResultMessage côté serveur).
const powerAnnounceEl = document.getElementById('sk-power-announce');
const powerAnnounceTitle = document.getElementById('sk-power-announce-title');
const powerAnnounceDetail = document.getElementById('sk-power-announce-detail');
let powerAnnounceTimer = null;

socket.on('skullking-power-result', ({ title, detail }) => {
  if (!title && !detail) return;
  clearTimeout(powerAnnounceTimer);
  powerAnnounceTitle.textContent = title || '';
  powerAnnounceDetail.textContent = detail || '';
  // Retire puis remet la classe pour rejouer l'animation quand deux pouvoirs
  // s'enchaînent (Mat le Forban ou le Skull King qui en hérite plusieurs).
  powerAnnounceEl.classList.add('hidden');
  void powerAnnounceEl.offsetWidth;
  powerAnnounceEl.classList.remove('hidden');
  powerAnnounceTimer = setTimeout(() => powerAnnounceEl.classList.add('hidden'), 3600);
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

// Le bandeau du haut ne porte que la manche : le numéro du pli en cours se
// devine déjà aux cartes posées sur le tapis et à la main qui se vide.
function renderRoundIndicator(state) {
  roundIndicator.textContent = `Manche ${state.roundNumber}/${state.totalRounds}`;
}

// Vert = l'annonce est pile tenue à cet instant, rouge = déjà dépassée,
// donc irrattrapable. Neutre tant qu'on annonce (rien n'est encore joué).
function bidStateSuffix(state, p) {
  if (state.phase === 'bidding' || p.bid === undefined || p.bid === null) return '';
  if (p.tricksWon > p.bid) return '--over';
  if (p.tricksWon === p.bid) return '--hit';
  return '';
}

// --- Pièces de joueur ---
// Chacun choisit sa pièce dans le salon, comme au Monopoly. Avant, tous les
// sièges portaient le même drapeau pirate sur le même rond bordeaux : autour
// d'une table à 7 ou 9, plus rien ne distinguait les joueurs que le pseudo
// écrit en petit. Des figures dessinées plutôt que des emojis, parce qu'un
// emoji dépend de la police du système, ne se cale pas au pixel dans son
// rond, et n'a pas la même allure d'un appareil à l'autre.
//
// Tracé commun : boîte 24x24, trait de 2, bouts arrondis, couleur héritée -
// une seule silhouette lisible à 30px comme à 60px.
const PIECES = [
  {
    key: 'crane', label: 'Crâne', color: '#b91c1c',
    svg: '<circle cx="12" cy="9.5" r="6.6"/><circle cx="9.6" cy="9.2" r="1.7" fill="currentColor" stroke="none"/><circle cx="14.4" cy="9.2" r="1.7" fill="currentColor" stroke="none"/><path d="M8.2 15.6h7.6v3a1.6 1.6 0 0 1-1.6 1.6H9.8a1.6 1.6 0 0 1-1.6-1.6z"/><path d="M10.7 15.8v4.3M13.3 15.8v4.3"/>',
  },
  {
    key: 'ancre', label: 'Ancre', color: '#1d4ed8',
    svg: '<circle cx="12" cy="4.4" r="2.3"/><path d="M12 6.7V21"/><path d="M8 10h8"/><path d="M4.8 14.3c0 3.7 3.2 6.7 7.2 6.7s7.2-3 7.2-6.7"/>',
  },
  {
    key: 'voilier', label: 'Voilier', color: '#15803d',
    svg: '<path d="M12 2.8v12.6"/><path d="M13.3 4.6l5 10.8h-5z" fill="currentColor" stroke="none"/><path d="M10.7 6.8 6.2 15.4h4.5z"/><path d="M3.4 17.2h17.2l-2.7 3.9H6.1z"/>',
  },
  {
    key: 'sabre', label: 'Sabre', color: '#a16207',
    svg: '<path d="M20.2 3.8 9.7 14.3"/><path d="M6.9 12.9l4.2 4.2"/><path d="M8.3 15.7 4.9 19.1"/><circle cx="3.9" cy="20.1" r="1.5"/>',
  },
  {
    key: 'boussole', label: 'Boussole', color: '#0f766e',
    svg: '<circle cx="12" cy="12" r="8.6"/><path d="M15.4 8.6l-2 4.8-4.8 2 2-4.8z" fill="currentColor" stroke="none"/>',
  },
  {
    key: 'coffre', label: 'Coffre', color: '#c2410c',
    svg: '<path d="M3.6 10.6h16.8V19a1.6 1.6 0 0 1-1.6 1.6H5.2A1.6 1.6 0 0 1 3.6 19z"/><path d="M3.6 10.6A8.6 8.6 0 0 1 12 5.6a8.6 8.6 0 0 1 8.4 5"/><path d="M3.6 13.8h16.8"/><rect x="10.6" y="12.1" width="2.8" height="4" rx="0.7" fill="currentColor" stroke="none"/>',
  },
  {
    key: 'barre', label: 'Barre', color: '#6d28d9',
    svg: '<circle cx="12" cy="12" r="7.4"/><circle cx="12" cy="12" r="3.4"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><path d="M12 2.4v6.2M12 15.4v6.2M2.4 12h6.2M15.4 12h6.2M5.2 5.2l4.4 4.4M14.4 14.4l4.4 4.4M18.8 5.2l-4.4 4.4M9.6 14.4l-4.4 4.4"/>',
  },
  {
    key: 'bouteille', label: 'Bouteille', color: '#a21caf',
    svg: '<path d="M10.1 3h3.8v3.4c0 1 .4 1.6 1 2.3.9 1 1.5 2.1 1.5 3.5V19a2 2 0 0 1-2 2H9.6a2 2 0 0 1-2-2v-6.8c0-1.4.6-2.5 1.5-3.5.6-.7 1-1.3 1-2.3z"/><path d="M7.6 14.2h8.8"/>',
  },
  {
    key: 'crochet', label: 'Crochet', color: '#be123c',
    svg: '<path d="M9.4 3.4h5.2"/><path d="M12 3.4v6.4"/><path d="M12 9.8a5 5 0 0 1 5 5v1.1a4 4 0 0 1-8 0"/>',
  },
];

const PIECE_BY_KEY = Object.fromEntries(PIECES.map((p) => [p.key, p]));

// Repli quand un joueur n'a rien choisi (partie en cours lancée avant cette
// fonctionnalité, ou bot) : une pièce tirée du pseudo, donc stable et
// différente d'un joueur à l'autre sans qu'on ait à trancher côté serveur.
function pieceFor(player) {
  const chosen = player && player.piece && PIECE_BY_KEY[player.piece];
  if (chosen) return chosen;
  const nickname = (player && player.nickname) || '';
  let hash = 0;
  for (let i = 0; i < nickname.length; i++) hash = (hash * 31 + nickname.charCodeAt(i)) >>> 0;
  return PIECES[hash % PIECES.length];
}

// Le SVG porte la couleur de la pièce sur son trait ; le rond du siège prend
// la même teinte en fond, en plus sombre (voir --sk-av-color).
function pieceSVG(piece) {
  return `<svg class="sk-piece-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${piece.svg}</svg>`;
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
      if (p.revealedCard) {
        // Manche 1 : on voit la carte de chacun sauf la sienne (l'inverse
        // du dos de carte habituel) - l'annonce se base là-dessus.
        const el = document.createElement('div');
        el.className = `sk-card sk-seat-reveal-card ${cardClass(p.revealedCard)}`;
        el.innerHTML = cardFaceHTML(p.revealedCard);
        attachPowerTooltip(el, p.revealedCard);
        cards.appendChild(el);
      }
      // Plus de dos de cartes décoratifs : chevauchés, ils formaient une tache
      // illisible et n'apprenaient rien (le compte de cartes se lit dans le
      // panneau de droite). Le bloc ne sert plus qu'à la carte révélée de la
      // manche 1.
      if (cards.childElementCount) seat.appendChild(cards);
    }

    // Plis gagnés / annoncés, posé au-dessus du jeton : c'est l'information
    // qu'on cherche en regardant un adversaire (« il en a fait combien sur
    // ce qu'il a annoncé ? »), elle vivait jusqu'ici uniquement dans le
    // panneau de droite, loin du tapis. Rien pendant l'annonce, où les
    // annonces sont encore secrètes.
    if (landscapeTable.matches && state.phase !== 'bidding' && p.bid != null) {
      const tally = document.createElement('div');
      tally.className = 'sk-seat-tally';
      const won = p.tricksWon || 0;
      tally.textContent = `${won}/${p.bid}`;
      // Vert tant que l'annonce reste tenable, rouge dès qu'elle est dépassée.
      if (won > p.bid) tally.classList.add('sk-seat-tally--over');
      else if (won === p.bid) tally.classList.add('sk-seat-tally--exact');
      tally.title = `${won} pli(s) remporté(s) sur ${p.bid} annoncé(s)`;
      seat.appendChild(tally);
    }

    // Jeton du joueur : en paysage il porte la mise en avant du tour (halo
    // doré) et donne au siège une silhouette lisible de loin. Masqué sous
    // 1000px, où la place manque et l'étiquette seule suffit.
    const avatar = document.createElement('div');
    avatar.className = 'sk-seat-av';
    const piece = pieceFor(p);
    avatar.innerHTML = pieceSVG(piece);
    avatar.style.setProperty('--sk-av-color', piece.color);
    avatar.title = piece.label;
    seat.appendChild(avatar);

    const label = document.createElement('div');
    label.className = 'sk-seat-label';
    const name = document.createElement('span');
    name.className = 'sk-seat-name';
    name.textContent = (p.connected ? '' : '🔌 ') + p.nickname;
    label.appendChild(name);

    // Annonce et plis gagnés vivent dans le panneau de droite, pas sur le
    // tapis : en portrait l'étiquette du siège reste le seul endroit où les
    // lire, on ne les y garde donc que là.
    if (!landscapeTable.matches) {
      const bidEl = document.createElement('span');
      const bidState = bidStateSuffix(state, p);
      bidEl.className = 'sk-seat-bid' + (bidState ? ` sk-seat-bid${bidState}` : '');
      if (state.phase === 'bidding') {
        bidEl.textContent = p.hasBid ? '✓' : '…';
      } else {
        bidEl.textContent = p.bid === undefined || p.bid === null ? '?' : `${p.tricksWon}/${p.bid}`;
      }
      label.appendChild(bidEl);
    }

    if (p.id === state.dealerId) {
      const chip = document.createElement('span');
      chip.className = 'sk-seat-dealer';
      chip.textContent = 'D';
      chip.title = 'Donneur';
      label.appendChild(chip);
    }

    // Alliance Butin : une fois formée, elle reste marquée à côté de chaque
    // allié jusqu'à la fin de la manche. Un simple pictogramme sur les deux
    // (ou trois) sièges concernés se lit mieux qu'un trait tracé entre eux.
    // Posé DANS le pseudo, pas à côté : en paysage l'étiquette est une
    // colonne, un frère du pseudo tomberait sur la ligne du dessous.
    if ((state.lootAllies || []).includes(p.id)) {
      const coin = document.createElement('span');
      coin.className = 'sk-seat-loot';
      coin.textContent = '💰';
      coin.title = 'Allié par un Butin cette manche';
      name.appendChild(coin);
    }

    seat.appendChild(label);
    tableEl.appendChild(seat);
  });
}

const SUIT_DOT = { vert: '🟢', jaune: '🟡', violet: '🟣', noir: '⚫' };

// Chaque carte du pli est posée devant le siège de qui l'a jouée (interpolée
// entre le siège et le centre) : le pli dessine un cercle et on lit d'un coup
// d'œil à qui appartient chaque carte, sans avoir besoin d'étiquette de nom.
function renderTrick(state) {
  tableEl.querySelectorAll('.sk-trick-card').forEach((el) => el.remove());
  const trick = state.currentTrick || [];
  const { map } = seatLayout(state);
  // Deux tirages différents : le tapis est une ellipse bien plus large que
  // haute, donc un même pourcentage vaut beaucoup moins de pixels en vertical
  // qu'en horizontal. Avec un tirage unique, la carte du siège du haut venait
  // recouvrir son pseudo (26 px mesurés). On tire donc plus fort en vertical.
  const PULL_X = 0.44;
  const PULL_Y = 0.6;

  trick.forEach((t) => {
    const seatPos = map.get(t.playerId);
    if (!seatPos) return;
    const [seatLeft, seatTop] = seatPos;

    const slot = document.createElement('div');
    slot.className = 'sk-trick-card';
    // L'id de la carte sert à retrouver la case après coup (animation du
    // Skull King qui dévore les Pirates, voir playDevourAnimation).
    slot.dataset.cardId = t.card.id;
    slot.dataset.kind = t.card.kind;
    slot.style.left = `${seatLeft + (50 - seatLeft) * PULL_X}%`;
    slot.style.top = `${seatTop + (50 - seatTop) * PULL_Y}%`;
    if (t.playerId === state.leadingPlayerId) slot.classList.add('sk-trick-card--leading');

    const cardEl = document.createElement('div');
    cardEl.className = `sk-card ${cardClass(t.card)}`;
    cardEl.innerHTML = cardFaceHTML(t.card);
    attachPowerTooltip(cardEl, t.card);
    slot.appendChild(cardEl);

    tableEl.appendChild(slot);
  });

  // Le centre ne porte plus que les moments qui comptent : la consigne pendant
  // l'annonce, puis l'issue du pli. Qui mène se lit déjà au liseré vert de la
  // carte, la couleur demandée aux cartes grisées dans la main.
  if (state.phase === 'bidding') {
    trickCaptionEl.textContent = '🎯 Tout le monde annonce son nombre de plis…';
  } else if (state.trickPaused) {
    if (state.lastTrickResult && state.lastTrickResult.destroyed) {
      trickCaptionEl.textContent = '💥 Le pli est détruit !';
    } else {
      const winner = state.leadingPlayerId === myId ? 'Tu remportes' : `${nicknameOf(state, state.leadingPlayerId)} remporte`;
      trickCaptionEl.textContent = `🏆 ${winner} le pli !`;
    }
  } else if (state.trickWillBeDestroyed) {
    trickCaptionEl.textContent = '💀 Ce pli sera détruit…';
  } else {
    trickCaptionEl.textContent = '';
  }
}

// --- Le Skull King dévore les Pirates du pli ---
// Joué une seule fois par pli (repère lastDevouredTrick) : les cartes de
// Pirate glissent vers le Skull King en rétrécissant, pendant qu'il grossit
// d'un temps. Pilotée par l'API Web Animations plutôt qu'en CSS parce que la
// distance à parcourir dépend de la position réelle des cases sur le tapis,
// qui change à chaque pli et à chaque nombre de joueurs.
let lastDevouredTrick = null;

function playDevourAnimation(state) {
  const res = state.lastTrickResult;
  const ids = (res && res.devouredCardIds) || [];
  if (!state.trickPaused || !ids.length) return;

  // Un même pli est rediffusé à chaque broadcast pendant la pause : sans ce
  // repère, l'animation repartirait à zéro à chaque état reçu.
  const key = `${state.roundNumber}-${state.trickNumber}`;
  if (lastDevouredTrick === key) return;
  lastDevouredTrick = key;

  const king = tableEl.querySelector('.sk-trick-card[data-kind="skullking"]');
  if (!king) return;
  const kingCard = king.querySelector('.sk-card');

  // Distances prises sur offsetLeft/offsetTop, pas sur getBoundingClientRect :
  // les cases viennent d'être créées et leur animation d'apparition
  // (sk-card-drop) est encore en cours, donc leur boîte mesurée est décalée
  // et la carte n'atterrissait pas sur le roi (35 px d'écart mesurés). Les
  // offsets, eux, sont la position de mise en page, insensible aux
  // transformations en cours.
  ids.forEach((id, i) => {
    const slot = tableEl.querySelector(`.sk-trick-card[data-card-id="${CSS.escape(id)}"]`);
    if (!slot) return;
    const dx = king.offsetLeft - slot.offsetLeft;
    const dy = king.offsetTop - slot.offsetTop;
    slot.style.zIndex = '4';
    slot.animate(
      [
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
        { transform: `translate(-50%, -50%) translate(${dx * 0.25}px, ${dy * 0.25}px) scale(1.08) rotate(-6deg)`, opacity: 1, offset: 0.28 },
        { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(0.15) rotate(14deg)`, opacity: 0 },
      ],
      { duration: 850, delay: 120 + i * 90, easing: 'cubic-bezier(0.5, -0.3, 0.7, 1)', fill: 'forwards' }
    );
  });

  // Le roi encaisse : une pulsation dorée au moment où les cartes arrivent.
  if (kingCard) {
    kingCard.animate(
      [
        { transform: 'scale(1)', filter: 'brightness(1)' },
        { transform: 'scale(1.14)', filter: 'brightness(1.5)', offset: 0.55 },
        { transform: 'scale(1)', filter: 'brightness(1)' },
      ],
      { duration: 700, delay: 700 + (ids.length - 1) * 90, easing: 'ease-out' }
    );
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
      turnIndicator.textContent =
        state.roundNumber === 1
          ? '🎯 Ta carte reste cachée — base ton annonce sur celles que tu vois des autres.'
          : '🎯 Combien de plis vas-tu remporter cette manche ?';
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

// Pouvoir de Juanita Jade : les cartes sont retournées une à une par le
// joueur (survol ou tap), pas révélées d'un coup avec un minuteur fixe -
// sans ça il n'y avait pas le temps de toutes les lire. juanitaSessionKey
// identifie l'instance en cours (les ids de cartes changent à chaque
// déclenchement, jamais réutilisés) pour repartir de zéro à chaque fois.
let juanitaSessionKey = null;
let juanitaFlipped = new Set();
let juanitaDoneTimer = null;

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
  const willDrawnIds = willMode ? new Set(state.pendingPower.drawnCardIds || []) : null;
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
      // Repère les deux cartes tout juste piochées au milieu du reste de la
      // main - sans ça, rien ne les distingue une fois mêlées à l'éventail.
      if (willDrawnIds.has(card.id)) el.classList.add('sk-card--will-drawn');
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
        // y en a plusieurs dans le pli en cours. Une Tigresse compte comme
        // candidate potentielle même si on ne sait pas si elle a été jouée
        // comme Pirate ou comme Fuite : ce choix (chosenAs) reste caché aux
        // autres joueurs pour préserver son bluff (voir stateFor côté
        // serveur), donc le client ne peut pas trancher lui-même. Le serveur
        // connaît la vraie réponse et valide/complète le choix (voir
        // eligiblePlankTargets côté serveur) : s'il n'y a qu'une vraie cible
        // possible il l'impose de toute façon, quoi que le joueur ait cliqué.
        if (card.kind === 'plank') {
          const piratesInTrick = trick.filter(
            (t) => t.card.kind === 'pirate' || t.card.kind === 'tigress'
          );
          if (piratesInTrick.length > 1) {
            pendingPlankCardId = card.id;
            hideAllChoicePanels();
            plankOptionsEl.innerHTML = '';
            piratesInTrick.forEach((t) => {
              const btn = document.createElement('button');
              btn.className = 'btn';
              btn.textContent = t.card.name || (t.card.kind === 'tigress' ? 'Tigresse' : 'Pirate');
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

// « Ce qu'il te reste à faire » : la phrase qu'on se répète en jouant et qui
// n'était écrite nulle part. Réécrite à chaque pli, elle dit combien de plis
// il reste à prendre et avec combien de cartes — et surtout quand l'annonce
// est déjà perdue, ce qui change complètement la façon de jouer la fin de
// manche (on cherche alors à en donner, plus à en prendre).
const objectiveEl = document.getElementById('sk-objective');
const objectiveTextEl = document.getElementById('sk-objective-text');

function objectiveState(state) {
  const me = state.players.find((p) => p.id === myId);
  if (!me) return null;

  if (state.phase === 'bidding') {
    return me.hasBid
      ? { ton: 'ok', texte: 'Annonce envoyée. On attend les autres.' }
      : { ton: 'todo', texte: 'Annonce combien de plis tu comptes remporter.' };
  }
  if (state.phase !== 'playing' && state.phase !== 'power') return null;
  if (me.bid == null) return null;

  const reste = me.bid - (me.tricksWon || 0);
  const cartes = (state.hand || []).length;

  if (reste < 0) {
    const trop = -reste;
    return { ton: 'perdu', texte: `Annonce dépassée de ${trop} pli${trop > 1 ? 's' : ''} — la manche est perdue, limite les dégâts.` };
  }
  if (reste === 0) {
    if (cartes === 0) return { ton: 'ok', texte: 'Annonce tenue ! Manche réussie.' };
    return { ton: 'ok', texte: `N'en prends plus aucun — encore ${cartes} carte${cartes > 1 ? 's' : ''} à écouler.` };
  }
  if (reste > cartes) {
    return { ton: 'perdu', texte: `Il te faudrait ${reste} plis mais il ne te reste que ${cartes} carte${cartes > 1 ? 's' : ''} : c'est déjà manqué.` };
  }
  if (reste === cartes) {
    return { ton: 'tendu', texte: `Il faut remporter tous tes ${cartes} derniers plis. Aucune marge.` };
  }
  return { ton: 'todo', texte: `Encore ${reste} pli${reste > 1 ? 's' : ''} à prendre, avec ${cartes} carte${cartes > 1 ? 's' : ''} en main.` };
}

function renderObjective(state) {
  const o = objectiveState(state);
  if (!o) {
    objectiveEl.classList.add('hidden');
    return;
  }
  objectiveEl.classList.remove('hidden');
  objectiveEl.className = `sk-objective sk-objective--${o.ton}`;
  objectiveTextEl.textContent = o.texte;
}

function renderScoreboard(state) {
  renderObjective(state);
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

  // Rien à consulter tant qu'aucune manche n'est terminée.
  btnHistory.classList.toggle('hidden', state.roundNumber <= 1);

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
    juanitaSessionKey = null;
    juanitaFlipped.clear();
    clearTimeout(juanitaDoneTimer);
    return;
  }
  if (pending.kind !== 'juanita') {
    juanitaSessionKey = null;
    juanitaFlipped.clear();
    clearTimeout(juanitaDoneTimer);
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
    const cards = pending.revealCards || [];
    const key = cards.map((c) => c.id).join(',');
    if (juanitaSessionKey !== key) {
      juanitaSessionKey = key;
      juanitaFlipped.clear();
      clearTimeout(juanitaDoneTimer);
    }
    hint.textContent = `Cartes non distribuées ce tour-ci — survole (ou touche) chacune pour la retourner (${juanitaFlipped.size}/${cards.length}).`;
    const row = document.createElement('div');
    row.className = 'sk-hand sk-juanita-row';
    cards.forEach((card) => {
      const flip = document.createElement('div');
      flip.className = 'sk-flip-card' + (juanitaFlipped.has(card.id) ? ' sk-flip-card--flipped' : '');
      const inner = document.createElement('div');
      inner.className = 'sk-flip-card-inner';
      const back = document.createElement('div');
      back.className = 'sk-flip-card-face sk-flip-card-back';
      const front = document.createElement('div');
      front.className = `sk-flip-card-face sk-card ${cardClass(card)}`;
      front.innerHTML = cardFaceHTML(card);
      attachPowerTooltip(front, card);
      inner.appendChild(back);
      inner.appendChild(front);
      flip.appendChild(inner);
      const reveal = () => {
        if (juanitaFlipped.has(card.id)) return;
        juanitaFlipped.add(card.id);
        flip.classList.add('sk-flip-card--flipped');
        hint.textContent = `Cartes non distribuées ce tour-ci — survole (ou touche) chacune pour la retourner (${juanitaFlipped.size}/${cards.length}).`;
        if (juanitaFlipped.size === cards.length) {
          hint.textContent = 'Toutes retournées — la partie reprend dans un instant…';
          clearTimeout(juanitaDoneTimer);
          juanitaDoneTimer = setTimeout(() => socket.emit('skullking-power-juanita-done'), 2000);
        }
      };
      flip.addEventListener('mouseenter', reveal);
      flip.addEventListener('click', reveal);
      row.appendChild(flip);
    });
    powerPanel.appendChild(row);
  } else if (pending.kind === 'will') {
    hint.textContent = 'Tu piochais 2 cartes non distribuées, les voici — elles ont rejoint ta main. Choisis 2 cartes à défausser ci-dessous (parmi toute ta main, pas forcément celles-ci).';
    const drawnIds = new Set(pending.drawnCardIds || []);
    const drawnRow = document.createElement('div');
    drawnRow.className = 'sk-hand sk-will-drawn-row';
    (state.hand || [])
      .filter((card) => drawnIds.has(card.id))
      .forEach((card) => {
        const el = document.createElement('div');
        el.className = `sk-card sk-card--will-drawn ${cardClass(card)}`;
        el.innerHTML = cardFaceHTML(card);
        attachPowerTooltip(el, card);
        drawnRow.appendChild(el);
      });
    powerPanel.appendChild(drawnRow);

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

// Les annonces étaient secrètes : on les retourne, une par une, comme des
// cartes posées face cachée. Une pastille qui apparaît disait la même chose
// sans raconter le geste - c'est le retournement qui fait le petit moment.
function showBidReveal(state) {
  clearTimeout(bidRevealTimer);
  bidRevealRows.innerHTML = '';
  const STEP_MS = 260;

  state.players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'sk-bid-card';
    card.style.setProperty('--sk-bid-delay', `${i * STEP_MS}ms`);

    const inner = document.createElement('div');
    inner.className = 'sk-bid-card-inner';

    const back = document.createElement('div');
    back.className = 'sk-bid-card-face sk-bid-card-back';

    const front = document.createElement('div');
    front.className = 'sk-bid-card-face sk-bid-card-front';
    const num = document.createElement('span');
    num.className = 'sk-bid-card-num';
    num.textContent = p.bid;
    const who = document.createElement('span');
    who.className = 'sk-bid-card-who';
    who.textContent = p.id === myId ? 'Toi' : p.nickname;
    front.append(num, who);

    inner.append(back, front);
    card.appendChild(inner);
    bidRevealRows.appendChild(card);
  });

  bidRevealEl.classList.remove('hidden');

  // Le retournement est une animation CSS (animation-delay en cascade) et
  // non une transition déclenchée en JS : une transition aurait exigé de
  // peindre l'état "face cachée" avant de basculer la classe, donc un
  // double requestAnimationFrame - or rAF est gelé dans un onglet en
  // arrière-plan, et les annonces se révèlent justement pendant qu'on peut
  // avoir la tête ailleurs. L'animation, elle, part toute seule.

  const total = 1500 + state.players.length * STEP_MS;
  bidRevealTimer = setTimeout(() => bidRevealEl.classList.add('hidden'), total);
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
  // Après renderTrick : l'animation mesure la position réelle des cases du
  // pli, elles doivent donc déjà être dans le DOM.
  playDevourAnimation(state);
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

// Marque les lignes d'une alliance Butin dans le récapitulatif de fin de
// manche. Un trait tracé entre les deux lignes a été essayé puis abandonné :
// illisible dès que d'autres joueurs s'intercalaient, et redondant avec le
// pictogramme désormais affiché sur les sièges pendant toute la manche.
function markLootRows(links) {
  if (!links || !links.length) return;
  links.forEach((link) => {
    const paid = link.paid !== false;
    [link.a, link.b].forEach((id) => {
      const row = roundPopupRows.querySelector(`[data-player-id="${id}"]`);
      if (!row) return;
      row.classList.add('sk-round-popup-row--loot');
      const coin = document.createElement('span');
      coin.className = 'sk-round-popup-loot';
      // Alliance qui a payé (les deux annonces réussies) contre alliance
      // formée mais restée sans effet : la distinction vaut d'être gardée.
      coin.textContent = paid ? '💰' : '🤝';
      coin.title = paid ? 'Alliance Butin réussie (+20)' : 'Alliance Butin formée, sans bonus';
      row.appendChild(coin);
    });
  });
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
      left.innerHTML = `${escapeHTML(r.nickname)} <span class="sk-round-popup-row-detail">— annoncé ${r.bid}, fait ${r.made}</span><span class="sk-round-popup-row-breakdown">${roundBreakdownText(r)}</span>`;
      const delta = document.createElement('span');
      delta.className = `sk-round-popup-row-delta ${r.delta >= 0 ? 'sk-delta--up' : 'sk-delta--down'}`;
      delta.textContent = r.delta >= 0 ? `+${r.delta}` : r.delta;
      row.appendChild(left);
      row.appendChild(delta);
      roundPopupRows.appendChild(row);
    });

  btnNextRound.classList.toggle('hidden', !myIsHost);
  roundPopup.classList.remove('hidden');
  markLootRows(summary.lootLinks);

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

// Récap de fin : le classement seul ne racontait rien de la partie. On y
// ajoute ce que l'historique des manches permet de dire — annonces tenues,
// plis pris — puis quelques faits marquants qui font parler la table.
const endFactsEl = document.getElementById('sk-end-facts');
const MEDALS = ['🥇', '🥈', '🥉'];

function endFacts(ranking) {
  const facts = [];
  const withRounds = ranking.filter((r) => r.rounds);
  if (!withRounds.length) return facts;

  const bestRound = withRounds
    .filter((r) => r.bestRound)
    .reduce((b, r) => (b === null || r.bestRound.delta > b.bestRound.delta ? r : b), null);
  if (bestRound && bestRound.bestRound.delta > 0) {
    facts.push(`🔥 Meilleure manche : ${bestRound.nickname}, +${bestRound.bestRound.delta} points à la manche ${bestRound.bestRound.round}.`);
  }

  const worstRound = withRounds
    .filter((r) => r.worstRound)
    .reduce((b, r) => (b === null || r.worstRound.delta < b.worstRound.delta ? r : b), null);
  if (worstRound && worstRound.worstRound.delta < 0) {
    facts.push(`💀 Pire manche : ${worstRound.nickname}, ${worstRound.worstRound.delta} points à la manche ${worstRound.worstRound.round}.`);
  }

  const streak = withRounds.reduce((b, r) => (r.bestStreak > b.bestStreak ? r : b));
  if (streak.bestStreak >= 2) {
    facts.push(`🎯 Plus longue série d'annonces tenues : ${streak.nickname}, ${streak.bestStreak} manches d'affilée.`);
  }

  const zeros = withRounds.reduce((b, r) => (r.zeros > b.zeros ? r : b));
  if (zeros.zeros >= 2) {
    facts.push(`🧊 Sang-froid : ${zeros.nickname} a tenu ${zeros.zeros} annonces à zéro.`);
  }

  const tricks = withRounds.reduce((b, r) => (r.tricks > b.tricks ? r : b));
  if (tricks.tricks > 0) {
    facts.push(`🗡️ Plus gros ramasseur : ${tricks.nickname}, ${tricks.tricks} plis sur la partie.`);
  }
  return facts;
}

// Courbe des scores de la partie : une ligne par joueur, à la couleur de sa
// pièce (même repère que sur le tapis, on retrouve la sienne sans lire de
// légende). Tracée en SVG à la main plutôt qu'avec une bibliothèque : c'est
// une polyligne et deux axes, rien qui justifie une dépendance.
function renderScoreCurve(ranking) {
  const series = ranking.filter((r) => r.curve && r.curve.length);
  if (series.length < 1) return '';

  const W = 460;
  const H = 190;
  const PAD_L = 38;
  const PAD_R = 10;
  const PAD_T = 12;
  const PAD_B = 22;

  const maxRound = Math.max(...series.map((r) => r.curve.length));
  const totaux = series.flatMap((r) => r.curve.map((c) => c.total));
  let min = Math.min(0, ...totaux);
  let max = Math.max(0, ...totaux);
  if (max === min) max = min + 10; // partie à 0 partout : évite une division par zéro
  // Marge haute et basse pour que les lignes ne collent pas au cadre.
  const span = max - min;
  min -= span * 0.08;
  max += span * 0.08;

  const x = (i) => PAD_L + (maxRound === 1 ? 0 : (i / (maxRound - 1)) * (W - PAD_L - PAD_R));
  const y = (v) => PAD_T + (1 - (v - min) / (max - min)) * (H - PAD_T - PAD_B);

  // Ligne du zéro : le repère qui compte, on passe son temps à repasser
  // au-dessus et en dessous.
  const zeroY = y(0);
  let svg = `<svg class="sk-curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution des scores manche par manche">`;
  svg += `<line x1="${PAD_L}" y1="${zeroY}" x2="${W - PAD_R}" y2="${zeroY}" class="sk-curve-zero" />`;
  svg += `<text x="${PAD_L - 6}" y="${zeroY + 3}" class="sk-curve-tick">0</text>`;

  // Repères de manche en bas (1, puis tous les 3).
  for (let i = 0; i < maxRound; i++) {
    if (i !== 0 && (i + 1) % 3 !== 0 && i !== maxRound - 1) continue;
    svg += `<text x="${x(i)}" y="${H - 6}" class="sk-curve-round">${i + 1}</text>`;
  }

  series.forEach((r) => {
    const couleur = (PIECE_BY_KEY[r.piece] || pieceFor(r)).color;
    const pts = r.curve.map((c, i) => `${x(i)},${y(c.total)}`).join(' ');
    const moi = r.id === myId ? ' sk-curve-line--me' : '';
    svg += `<polyline points="${pts}" class="sk-curve-line${moi}" style="stroke:${couleur}" />`;
    const dernier = r.curve[r.curve.length - 1];
    svg += `<circle cx="${x(r.curve.length - 1)}" cy="${y(dernier.total)}" r="${r.id === myId ? 4.5 : 3.2}" style="fill:${couleur}" class="sk-curve-dot" />`;
  });
  svg += '</svg>';

  const legende = series
    .map((r) => {
      const couleur = (PIECE_BY_KEY[r.piece] || pieceFor(r)).color;
      return `<span class="sk-curve-key"><i style="background:${couleur}"></i>${escapeHTML(r.nickname)}</span>`;
    })
    .join('');

  return `<p class="sk-end-facts-title">Évolution des scores</p><div class="sk-curve-wrap">${svg}<div class="sk-curve-legend">${legende}</div></div>`;
}

function renderGameEnd(state) {
  const ranking = state.finalRanking;
  const winner = ranking[0];
  endTitle.textContent = winner.id === myId ? 'Tu remportes la partie ! 🏆' : `${winner.nickname} remporte la partie !`;
  endBody.innerHTML = ranking
    .map((r, i) => {
      const rang = MEDALS[i] || `${i + 1}ᵉ`;
      // Les parties d'avant ce récap n'ont pas ces champs : on retombe alors
      // sur un tiret plutôt que d'afficher « undefined ».
      const annonces = r.rounds ? `${r.exact}/${r.rounds}` : '—';
      const plis = r.tricks == null ? '—' : r.tricks;
      const moi = r.id === myId ? ' class="sk-end-row--me"' : '';
      return `<tr${moi}><td>${rang}</td><td>${escapeHTML(r.nickname)}</td><td>${annonces}</td><td>${plis}</td><td><b>${r.total}</b></td></tr>`;
    })
    .join('');

  const facts = endFacts(ranking);
  endFactsEl.innerHTML =
    renderScoreCurve(ranking) +
    (facts.length
      ? `<p class="sk-end-facts-title">Faits marquants</p>` +
        facts.map((f) => `<p class="sk-end-fact">${escapeHTML(f)}</p>`).join('')
      : '');
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
