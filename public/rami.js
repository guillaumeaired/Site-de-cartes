const socket = io();

// Identite persistante de cet ONGLET (survit a une reconnexion ou un
// rechargement, contrairement a socket.id qui change a chaque fois) + partie
// active pour pouvoir revenir automatiquement via le lien, le code, ou un
// retour en arriere. sessionStorage (pas localStorage) : chaque onglet doit
// avoir sa propre identite, sinon un 2e onglet du meme navigateur "vole"
// la session du 1er au lieu de pouvoir rejoindre en tant que 2e joueur.
function getPlayerToken() {
  let token = sessionStorage.getItem('cardGamesPlayerToken');
  if (!token) {
    token = crypto.randomUUID();
    sessionStorage.setItem('cardGamesPlayerToken', token);
  }
  return token;
}
const ACTIVE_ROOM_KEY = 'rami:activeRoom';
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
const RED_SUITS = new Set(['coeur', 'carreau']);
const DISPLAY_RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R', 'A'];
const SUIT_ORDER = ['pique', 'coeur', 'trefle', 'carreau'];

const screens = {
  home: document.getElementById('rami-screen-home'),
  waiting: document.getElementById('rami-screen-waiting'),
  game: document.getElementById('rami-screen-game'),
  end: document.getElementById('rami-screen-end'),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
}

const toastEl = document.getElementById('rami-toast');
let toastTimer = null;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

const reconnectOverlay = document.getElementById('reconnect-overlay');
function showReconnectingOverlay(show) {
  reconnectOverlay.classList.toggle('hidden', !show);
}

// --- Accueil ---

const inputNickname = document.getElementById('rami-input-nickname');
const homeError = document.getElementById('rami-home-error');
const btnCreate = document.getElementById('rami-btn-create');
const formJoin = document.getElementById('rami-form-join');
const inputCode = document.getElementById('rami-input-code');
const btnRules = document.getElementById('rami-btn-rules');
const rulesModal = document.getElementById('rami-rules-modal');
const btnCloseRules = document.getElementById('rami-btn-close-rules');

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
// null (tentative silencieuse) | 'link' (montrer la popup pseudo si echec) |
// { code, nickname } (retenter un rami-join-room classique si echec).
let rejoinFallback = null;

// Le tout premier clic peut arriver avant que le socket ne soit connecte
// (chargement lent) : le bouton reste desactive jusque-la avec un texte
// explicite, plutot que de laisser un clic "ne rien faire" en apparence.
// Idem pendant l'attente de la reponse serveur, pour eviter les doubles
// clics qui creeraient 2 salons.
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
  socket.emit('rami-create-room', { nickname, token: getPlayerToken() });
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
    socket.emit('rami-rejoin-room', { code, token: getPlayerToken() });
    return;
  }
  socket.emit('rami-join-room', { code, nickname, token: getPlayerToken() });
});

btnRules.addEventListener('click', () => rulesModal.classList.remove('hidden'));
btnCloseRules.addEventListener('click', () => rulesModal.classList.add('hidden'));

// --- Salon d'attente ---

const shareBlock = document.getElementById('rami-share-block');
const shareLink = document.getElementById('rami-share-link');
const shareCode = document.getElementById('rami-share-code');
const btnCopy = document.getElementById('rami-btn-copy');
const btnLeaveWaiting = document.getElementById('rami-btn-leave-waiting');
const lobbyPlayers = document.getElementById('rami-lobby-players');
const lobbyList = document.getElementById('rami-lobby-list');
const lobbyCount = document.getElementById('rami-lobby-count');
const btnStartGame = document.getElementById('rami-btn-start-game');
const waitingHint = document.getElementById('rami-waiting-hint');

const joinModal = document.getElementById('rami-join-modal');
const joinModalNickname = document.getElementById('rami-join-modal-nickname');
const btnJoinModal = document.getElementById('rami-btn-join-modal');
const joinModalError = document.getElementById('rami-join-modal-error');

let myId = null;
let myIsHost = false;

function goHome() {
  clearActiveRoom();
  socket.emit('rami-leave-room');
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);
  currentHand = [];
  selected.clear();
  openStaging = [];
  joinModal.classList.add('hidden');
  inputNickname.value = '';
  showScreen('home');
}

btnLeaveWaiting.addEventListener('click', goHome);
document.getElementById('rami-btn-leave-game').addEventListener('click', goHome);
document.getElementById('rami-btn-leave-end').addEventListener('click', goHome);

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

socket.on('rami-room-created', ({ code }) => {
  setCreateBusy(false);
  saveActiveRoom(code, myNickname);
  const url = `${window.location.protocol}//${window.location.host}/rami.html?room=${code}`;
  shareLink.value = url;
  shareCode.textContent = code;
  shareBlock.classList.remove('hidden');
});

socket.on('rami-lobby-update', ({ code, players, hostId, isHost, canStart }) => {
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

  btnStartGame.classList.toggle('hidden', !isHost);
  btnStartGame.disabled = !canStart;
  if (isHost) {
    waitingHint.textContent = canStart ? 'Prêt ! Lance la partie quand tu veux.' : "En attente d'un 2e joueur…";
  } else {
    waitingHint.textContent = "En attente que l'hôte lance la partie…";
  }
});

socket.on('rami-error', (message) => {
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

socket.on('rami-player-left', ({ nickname }) => showToast(`${nickname} a quitté le salon.`));
socket.on('rami-opponent-left', ({ nickname, reason }) => {
  showToast(
    reason === 'timeout'
      ? `${nickname} n'est pas revenu à temps — la partie est terminée.`
      : `${nickname} a quitté la partie — la partie est terminée.`
  );
  setTimeout(goHome, 2500);
});

btnStartGame.addEventListener('click', () => socket.emit('rami-start-game'));

btnJoinModal.addEventListener('click', () => {
  const nickname = joinModalNickname.value.trim().slice(0, 16);
  if (!nickname) {
    joinModalError.textContent = 'Entre un pseudo avant de continuer.';
    return;
  }
  joinModalError.textContent = '';
  btnJoinModal.disabled = true;
  myNickname = nickname;
  socket.emit('rami-join-room', { code: roomFromUrl.toUpperCase(), nickname, token: getPlayerToken() });
});

// --- Partie en cours ---

const turnIndicator = document.getElementById('rami-turn-indicator');
const opponentName = document.getElementById('rami-opponent-name');
const opponentStatus = document.getElementById('rami-opponent-status');
const opponentHandEl = document.getElementById('rami-opponent-hand');
const drawPileBtn = document.getElementById('rami-draw-pile');
const drawCountEl = document.getElementById('rami-draw-count');
const discardRowEl = document.getElementById('rami-discard-row');
const tableOpponentEl = document.getElementById('rami-table-opponent');
const tableMineEl = document.getElementById('rami-table-mine');
const handEl = document.getElementById('rami-hand');
const openStagingBlock = document.getElementById('rami-open-staging');
const stagingListEl = document.getElementById('rami-staging-list');
const btnValidateOpen = document.getElementById('rami-btn-validate-open');
const resolveBanner = document.getElementById('rami-resolve-banner');
const resolveBannerText = document.getElementById('rami-resolve-text');
const btnClearStaging = document.getElementById('rami-btn-clear-staging');
const btnUndoDraw = document.getElementById('rami-btn-undo-draw');
const btnSortRank = document.getElementById('rami-btn-sort-rank');
const btnSortSuit = document.getElementById('rami-btn-sort-suit');
const btnStageGroup = document.getElementById('rami-btn-stage-group');
const btnLayMeld = document.getElementById('rami-btn-lay-meld');
const btnDiscard = document.getElementById('rami-btn-discard');
const drawPopup = document.getElementById('rami-draw-popup');
const drawPopupCardEl = document.getElementById('rami-draw-popup-card');

let currentHand = [];
let selected = new Set();
let openStaging = []; // [{ cardIds: [...] }] en attente de validation d'ouverture
let latestState = null;

// La main est petite et en bas de l'écran (surtout sur mobile) : la carte
// piochée (pioche ou défausse) s'affiche un instant en grand, pour qu'on ne
// puisse pas la manquer avant qu'elle rejoigne l'éventail.
let lastDrawnCardId = null;
let drawPopupTimer = null;

function showDrawPopup(card) {
  drawPopupCardEl.className = `rami-draw-popup-card ${cardColorClass(card)}`;
  drawPopupCardEl.innerHTML = cardFaceHTML(card);
  drawPopup.classList.remove('hidden');
  clearTimeout(drawPopupTimer);
  drawPopupTimer = setTimeout(hideDrawPopup, 1400);
}

function hideDrawPopup() {
  drawPopup.classList.add('hidden');
  clearTimeout(drawPopupTimer);
}

drawPopup.addEventListener('click', hideDrawPopup);

// Détecte un tirage qui vient vraiment d'arriver (pas un état déjà connu
// re-diffusé, ni une resynchronisation après reconnexion en plein milieu du
// tour de quelqu'un) et prévient le joueur : pop-up plein écran pour son
// propre tirage (main petite et en bas d'écran, facile à manquer), simple
// toast pour celui de l'adversaire — sinon la seule trace visible est le
// compteur de cartes de l'adversaire qui grimpe silencieusement de 1, très
// facile à ne pas remarquer en pleine partie.
function handleNewDraw(prevState, state) {
  const isNewDraw = Boolean(state.drawnCardId) && state.drawnCardId !== lastDrawnCardId;
  lastDrawnCardId = state.drawnCardId;
  if (!isNewDraw) return;

  if (state.isMyTurn) {
    const card = currentHand.find((c) => c.id === state.drawnCardId);
    if (card) showDrawPopup(card);
    return;
  }

  const opponent = state.players.find((p) => p.id !== myId);
  const name = opponent ? opponent.nickname : "L'adversaire";
  if (state.drawnFromDiscard) {
    // La carte reprise en défausse était déjà publique avant d'être prise :
    // on peut donc la nommer (elle ne l'est plus dans l'état actuel, qui ne
    // contient que ce qu'il reste dans la pile après la reprise).
    const known = prevState && prevState.discardPile.find((c) => c.id === state.drawnCardId);
    showToast(known ? `🎭 ${name} reprend ${cardLabel(known)} en défausse.` : `🎭 ${name} reprend une carte en défausse.`);
  } else {
    showToast(`🎭 ${name} pioche une carte.`);
  }
}

// Le 2 de cœur joue le rôle du Joker mais s'affiche comme une carte normale
// (design d'un 2 de cœur) — seule sa logique de jeu (isJoker) le distingue.
function cardLabel(card) {
  return `${card.rank}${SUIT_SYMBOL[card.suit]}`;
}

function cardColorClass(card) {
  return RED_SUITS.has(card.suit) ? 'card-red' : 'card-black';
}

// Visage de carte classique façon Balatro : index rang+symbole en haut a
// gauche (couleur pleine, pas de degrade - illisible en petit) + un gros
// symbole plein au centre.
function cardFaceHTML(card) {
  const symbol = SUIT_SYMBOL[card.suit];
  return `
    <span class="card-corner"><span class="card-corner-rank">${card.rank}</span><span class="card-corner-suit">${symbol}</span></span>
    <span class="card-emblem">${symbol}</span>
  `;
}

// Une fois posé dans une combinaison, le Joker montre ce qu'il remplace
// (plutôt que sa fausse identité de "2 de Cœur") pour qu'on ne le confonde
// jamais avec une carte réelle en trop - notamment dans un brelan/carré où
// il n'a pas de couleur propre (il représente la couleur manquante).
function jokerMeldFaceHTML(card, meldType) {
  const rank = (card.jokerFor && card.jokerFor.rank) || card.rank;
  const suit = meldType === 'sequence' ? card.jokerFor && card.jokerFor.suit : null;
  const symbol = suit ? SUIT_SYMBOL[suit] : '★';
  return `
    <span class="card-corner"><span class="card-corner-rank">${rank}</span><span class="card-corner-suit">${symbol}</span></span>
    <span class="card-emblem">${symbol}</span>
    <span class="rami-joker-badge">🃏</span>
  `;
}

// Indice visuel : une carte de la main peut-elle compléter une combinaison
// déjà posée sur le tapis ? Purement indicatif côté client (le serveur reste
// seul juge à la validation) — on ignore le 2 de cœur ici, le mettre en
// avant partout serait plus gênant qu'utile.
function circleStep(rank, delta) {
  const len = DISPLAY_RANK_ORDER.length;
  const idx = (DISPLAY_RANK_ORDER.indexOf(rank) + delta + len) % len;
  return DISPLAY_RANK_ORDER[idx];
}

function cardCompletesMeld(card, meld) {
  if (meld.type === 'set') {
    const rank = meld.cards.find((c) => !c.isJoker)?.rank;
    const usedSuits = new Set(meld.cards.filter((c) => !c.isJoker).map((c) => c.suit));
    return meld.cards.length < 4 && card.rank === rank && !usedSuits.has(card.suit);
  }
  const suit = meld.cards.find((c) => !c.isJoker)?.suit;
  if (card.suit !== suit) return false;
  const first = meld.cards[0];
  const last = meld.cards[meld.cards.length - 1];
  const firstRank = first.isJoker ? first.jokerFor.rank : first.rank;
  const lastRank = last.isJoker ? last.jokerFor.rank : last.rank;
  return card.rank === circleStep(firstRank, -1) || card.rank === circleStep(lastRank, 1);
}

// La carte prise précisément en défausse doit être jouée dans une
// combinaison ce tour-ci (règle stricte : impossible de la redéfausser
// directement). Si elle est encore en main, on doit toujours pouvoir la
// repérer et la libérer même si elle a été mise en attente dans une
// combinaison d'ouverture non validée — sinon impossible de la sélectionner
// pour l'inclure ailleurs ou pour tout reprendre via "Reprendre ma pioche".
function mustResolveCardId(state) {
  if (!state || !state.drawnFromDiscard || !state.isMyTurn || state.turnPhase !== 'JEU') return null;
  const id = state.drawnCardId;
  return currentHand.some((c) => c.id === id) ? id : null;
}

function playableHintIds(state) {
  if (!state || !state.hasOpened || !state.isMyTurn || state.turnPhase !== 'JEU') return new Set();
  const ids = new Set();
  for (const card of currentHand) {
    if (card.isJoker) continue;
    if (state.table.some((meld) => cardCompletesMeld(card, meld))) ids.add(card.id);
  }
  return ids;
}

// Au survol d'une carte en surbrillance (cartes jouables), met aussi en
// valeur la/les combinaison(s) du tapis qu'elle pourrait compléter — sinon
// le joueur voit "cette carte est jouable" sans savoir où la poser.
function highlightTargetMelds(card) {
  if (!latestState) return;
  for (const meld of latestState.table) {
    if (!cardCompletesMeld(card, meld)) continue;
    const rowEl = document.querySelector(`.rami-meld[data-meld-id="${meld.id}"]`);
    if (rowEl) rowEl.classList.add('rami-meld--target');
  }
}

function clearTargetMeldHighlight() {
  document.querySelectorAll('.rami-meld--target').forEach((el) => el.classList.remove('rami-meld--target'));
}

function sortByRank(cards) {
  return [...cards].sort((a, b) => {
    if (a.isJoker || b.isJoker) return (a.isJoker ? 1 : 0) - (b.isJoker ? 1 : 0);
    const ra = DISPLAY_RANK_ORDER.indexOf(a.rank);
    const rb = DISPLAY_RANK_ORDER.indexOf(b.rank);
    return ra !== rb ? ra - rb : SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit);
  });
}

function sortBySuit(cards) {
  return [...cards].sort((a, b) => {
    if (a.isJoker || b.isJoker) return (a.isJoker ? 1 : 0) - (b.isJoker ? 1 : 0);
    const sa = SUIT_ORDER.indexOf(a.suit);
    const sb = SUIT_ORDER.indexOf(b.suit);
    return sa !== sb ? sa - sb : DISPLAY_RANK_ORDER.indexOf(a.rank) - DISPLAY_RANK_ORDER.indexOf(b.rank);
  });
}

btnSortRank.addEventListener('click', () => {
  currentHand = sortByRank(currentHand);
  renderHand();
});
btnSortSuit.addEventListener('click', () => {
  currentHand = sortBySuit(currentHand);
  renderHand();
});

// Éventail façon Balatro : chaque carte est placée dans un conteneur pivoté
// (rotate + translateY, transform-origin en bas) selon sa position parmi
// les cartes visibles ; la carte elle-même garde son propre survol/scale.
function renderHand() {
  const mustResolveId = mustResolveCardId(latestState);
  const stagedIds = new Set(openStaging.flatMap((g) => g.cardIds));
  const visible = currentHand.filter((card) => !stagedIds.has(card.id) || card.id === mustResolveId);
  const hintIds = playableHintIds(latestState);
  handEl.innerHTML = '';

  const n = visible.length;
  const maxSpread = Math.min(6 * Math.max(n - 1, 0), 42);
  const step = n > 1 ? maxSpread / (n - 1) : 0;

  visible.forEach((card, i) => {
    const angle = n > 1 ? -maxSpread / 2 + i * step : 0;
    const normalized = n > 1 ? Math.abs(i - (n - 1) / 2) / ((n - 1) / 2) : 0;
    const lift = normalized * normalized * 16;

    const arc = document.createElement('div');
    arc.className = 'rami-card-arc';
    arc.style.transform = `rotate(${angle}deg) translateY(${lift}px)`;

    const el = document.createElement('div');
    el.className = `rami-card ${cardColorClass(card)}`;
    if (selected.has(card.id)) el.classList.add('rami-selected');
    if (hintIds.has(card.id)) el.classList.add('rami-hint');
    if (card.id === mustResolveId) {
      el.classList.add('rami-must-resolve');
      // Toujours visible/jouable (voir mustResolveCardId), mais si elle est
      // déjà dans un groupe d'ouverture en attente, le signaler clairement :
      // sinon on dirait qu'elle traîne encore librement dans la main alors
      // qu'elle est déjà "utilisée" côté groupe staged.
      if (stagedIds.has(card.id)) el.classList.add('rami-must-resolve--staged');
    }
    el.innerHTML = cardFaceHTML(card);
    if (hintIds.has(card.id)) {
      el.addEventListener('mouseenter', () => highlightTargetMelds(card));
      el.addEventListener('mouseleave', clearTargetMeldHighlight);
    }
    el.addEventListener('click', () => {
      if (selected.has(card.id)) selected.delete(card.id);
      else selected.add(card.id);
      renderHand();
      updateActionButtons();
    });

    arc.appendChild(el);
    handEl.appendChild(arc);
  });
}

function renderOpponent(state) {
  const opponent = state.players.find((p) => p.id !== myId);
  if (!opponent) return;
  opponentName.textContent = `🎭 ${opponent.nickname} (${opponent.count} cartes)`;
  opponentHandEl.innerHTML = '';
  for (let i = 0; i < opponent.count; i++) {
    const back = document.createElement('div');
    back.className = 'rami-back-card';
    opponentHandEl.appendChild(back);
  }
}

// Chaque mêlée appartient à qui l'a posée (ownerId) : elle s'affiche du
// côté de son propriétaire (adversaire en haut, moi en bas) pour rester
// bien visible même quand les deux joueurs en ont posé plusieurs.
function renderTable(state) {
  tableOpponentEl.innerHTML = '';
  tableMineEl.innerHTML = '';
  for (const meld of state.table) {
    const row = document.createElement('div');
    row.className = 'rami-meld';
    row.dataset.meldId = meld.id;
    row.addEventListener('click', () => {
      if (selected.size === 0) return;
      socket.emit('rami-lay-off', { meldId: meld.id, cards: [...selected] });
    });
    for (const card of meld.cards) {
      const chip = document.createElement('div');
      const jokerSuit = card.isJoker && meld.type === 'sequence' ? card.jokerFor && card.jokerFor.suit : null;
      const colorClass = card.isJoker
        ? (jokerSuit ? cardColorClass({ suit: jokerSuit }) : 'rami-mini-card--neutral')
        : cardColorClass(card);
      chip.className = `rami-mini-card ${colorClass}`;
      chip.innerHTML = card.isJoker ? jokerMeldFaceHTML(card, meld.type) : cardFaceHTML(card);
      if (card.isJoker) {
        chip.classList.add('rami-mini-card--wild');
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selected.size !== 1) return;
          const [replacementCardId] = [...selected];
          socket.emit('rami-swap-joker', { meldId: meld.id, jokerCardId: card.id, replacementCardId });
        });
      }
      row.appendChild(chip);
    }
    (meld.ownerId === myId ? tableMineEl : tableOpponentEl).appendChild(row);
  }
}

// Défausse "en ligne" : toutes les cartes restent visibles et cliquables.
// Prendre une carte récupère aussi tout ce qui a été défaussé après elle.
function renderDiscardRow(state) {
  drawCountEl.textContent = state.drawPileCount;
  discardRowEl.innerHTML = '';
  const canTake = state.isMyTurn && state.turnPhase === 'PIOCHE';
  state.discardPile.forEach((card) => {
    const chip = document.createElement('div');
    chip.className = `rami-discard-card ${cardColorClass(card)}`;
    if (!canTake) chip.classList.add('rami-discard-card--disabled');
    chip.innerHTML = cardFaceHTML(card);
    chip.addEventListener('click', () => {
      if (!canTake) return;
      socket.emit('rami-draw-discard', { cardId: card.id });
    });
    discardRowEl.appendChild(chip);
  });
}

function renderStaging() {
  openStagingBlock.classList.toggle('hidden', !(latestState && !latestState.hasOpened));
  stagingListEl.innerHTML = '';
  openStaging.forEach((group, i) => {
    const chip = document.createElement('div');
    chip.className = 'rami-staging-group';
    const label = document.createElement('span');
    label.textContent = group.cardIds
      .map((id) => currentHand.find((c) => c.id === id))
      .filter(Boolean)
      .map(cardLabel)
      .join(' ');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      openStaging.splice(i, 1);
      renderHand();
      renderStaging();
      updateActionButtons();
    });
    chip.append(label, remove);
    stagingListEl.appendChild(chip);
  });
}

function renderResolveBanner() {
  const mustResolveId = mustResolveCardId(latestState);
  const card = mustResolveId && currentHand.find((c) => c.id === mustResolveId);
  const canUndo = Boolean(latestState && latestState.canUndoDraw);
  resolveBanner.classList.toggle('hidden', !card && !canUndo);
  // La carte a regler reste toujours visible/selectionnable dans la main
  // meme une fois mise dans un groupe d'ouverture en attente (sinon
  // impossible de la reprendre) - mais ca peut donner l'impression qu'elle
  // "n'a servi a rien" : le texte le precise explicitement dans ce cas.
  const isStaged = mustResolveId && openStaging.some((g) => g.cardIds.includes(mustResolveId));
  if (card && isStaged) {
    resolveBannerText.textContent = `${cardLabel(card)} est déjà dans ta combinaison en attente — valide l'ouverture pour la jouer, ou clique 🔓 pour la reprendre et reprendre ta pioche autrement.`;
  } else if (card) {
    // Règle stricte : impossible de la redéfausser directement, il faut soit
    // la jouer dans une combinaison, soit tout reprendre (les autres cartes
    // prises avec elle restent elles aussi bloquées tant qu'elle ne l'est pas).
    resolveBannerText.textContent = `Carte prise à la défausse à jouer : ${cardLabel(card)} — pose-la dans une combinaison, ou reprends ta pioche si tu ne peux pas.`;
  } else if (canUndo) {
    resolveBannerText.textContent = 'Tu peux encore reprendre ta pioche pour piocher autrement.';
  }
  btnClearStaging.classList.toggle('hidden', !isStaged);
  btnUndoDraw.classList.toggle('hidden', !canUndo);
}

btnClearStaging.addEventListener('click', () => {
  openStaging = [];
  renderHand();
  renderStaging();
  updateActionButtons();
});

btnUndoDraw.addEventListener('click', () => {
  socket.emit('rami-undo-draw');
});

function updateTurnIndicator(state) {
  if (state.isMyTurn) {
    turnIndicator.textContent = state.turnPhase === 'PIOCHE' ? '🟡 À toi de piocher' : '🟢 À toi de jouer';
  } else {
    const opponent = state.players.find((p) => p.id !== myId);
    turnIndicator.textContent = `⏳ Tour de ${opponent ? opponent.nickname : "l'adversaire"}…`;
  }
}

function updateActionButtons() {
  if (!latestState) return;
  const s = latestState;
  const canDraw = s.isMyTurn && s.turnPhase === 'PIOCHE';
  drawPileBtn.disabled = !canDraw;

  const canAct = s.isMyTurn && s.turnPhase === 'JEU';
  // Règle stricte de la carte prise à la défausse : tant qu'elle n'est pas
  // couverte (sélectionnée maintenant, ou déjà dans un groupe en attente),
  // aucune autre action (poser, défausser) n'est possible — seule "Reprendre
  // ma pioche" (bouton séparé, dans la bannière) reste disponible.
  const mustResolveId = mustResolveCardId(s);
  const stagedIds = new Set(openStaging.flatMap((g) => g.cardIds));
  const resolvingCovered = !mustResolveId || selected.has(mustResolveId) || stagedIds.has(mustResolveId);

  btnStageGroup.classList.toggle('hidden', s.hasOpened);
  btnLayMeld.classList.toggle('hidden', !s.hasOpened);
  btnStageGroup.disabled = !canAct || selected.size < 3 || !resolvingCovered;
  btnLayMeld.disabled = !canAct || selected.size < 3 || !resolvingCovered;
  // Défausser est totalement impossible tant que la carte prise à la
  // défausse n'a pas été jouée (règle stricte, aucune exception côté serveur).
  btnDiscard.disabled = !canAct || selected.size !== 1 || Boolean(mustResolveId);
  btnValidateOpen.disabled = !canAct || openStaging.length === 0 || !resolvingCovered;
}

btnStageGroup.addEventListener('click', () => {
  if (selected.size < 3) return;
  openStaging.push({ cardIds: [...selected] });
  selected.clear();
  renderHand();
  renderStaging();
  updateActionButtons();
});

btnValidateOpen.addEventListener('click', () => {
  if (openStaging.length === 0) return;
  socket.emit('rami-open', { melds: openStaging.map((g) => g.cardIds) });
});

btnLayMeld.addEventListener('click', () => {
  if (selected.size < 3) return;
  socket.emit('rami-lay-meld', { cards: [...selected] });
});

btnDiscard.addEventListener('click', () => {
  if (selected.size !== 1) return;
  const [cardId] = [...selected];
  socket.emit('rami-discard', { cardId });
});

drawPileBtn.addEventListener('click', () => {
  if (drawPileBtn.disabled) return;
  socket.emit('rami-draw-stock');
});

function renderAll() {
  renderHand();
  renderStaging();
  renderResolveBanner();
  if (latestState) {
    renderOpponent(latestState);
    renderTable(latestState);
    renderDiscardRow(latestState);
    updateTurnIndicator(latestState);
  }
  updateActionButtons();
}

function mergeHandOrder(newHand) {
  const byId = new Map(newHand.map((c) => [c.id, c]));
  const kept = currentHand.filter((c) => byId.has(c.id)).map((c) => byId.get(c.id));
  const keptIds = new Set(kept.map((c) => c.id));
  const added = newHand.filter((c) => !keptIds.has(c.id));
  return [...kept, ...added];
}

socket.on('rami-game-start', ({ myId: id, hand, players, drawPileCount, turnPlayerId }) => {
  myId = id;
  currentHand = hand;
  selected = new Set();
  openStaging = [];
  latestState = {
    hand,
    players,
    table: [],
    discardPile: [],
    drawPileCount,
    turnPlayerId,
    turnPhase: 'PIOCHE',
    hasOpened: false,
    isMyTurn: turnPlayerId === myId,
    drawnCardId: null,
    drawnFromDiscard: false,
  };
  lastDrawnCardId = null;
  showScreen('game');
  renderAll();
});

// Petit carillon montant a la pose d'une combinaison (ouverture, nouvelle
// mêlée, ou ajout sur une mêlée existante) - meme pattern que les sons de la
// Bataille (oscillateur brut, pas de fichier audio).
function playMeldTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'triangle';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.setValueAtTime(660, now + 0.08);
    osc.frequency.setValueAtTime(880, now + 0.16);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    osc.start(now);
    osc.stop(now + 0.4);
  } catch {
    // audio non disponible, tant pis
  }
}

function tableCardCount(table) {
  return table.reduce((sum, meld) => sum + meld.cards.length, 0);
}

// Petit badge "+N" qui monte et s'estompe au-dessus du tapis du joueur qui
// vient de marquer - meme pattern que le gain-popup de la Bataille. Le score
// en direct n'est plus affiche en permanence (choix explicite), mais ce
// popup transitoire reste le bon retour immediat sans reintroduire un badge fixe.
function showMeldScorePopup(playerId, amount) {
  if (amount <= 0) return;
  const container = playerId === myId ? tableMineEl : tableOpponentEl;
  const popup = document.createElement('div');
  popup.className = 'gain-popup';
  popup.textContent = `+${amount}`;
  container.appendChild(popup);
  popup.addEventListener('animationend', () => popup.remove());
}

socket.on('rami-state', (state) => {
  if (latestState) {
    if (tableCardCount(state.table) > tableCardCount(latestState.table)) {
      playMeldTone();
    }
    for (const p of state.players) {
      const before = latestState.players.find((pp) => pp.id === p.id);
      if (before && p.score > before.score) showMeldScorePopup(p.id, p.score - before.score);
    }
  }
  currentHand = mergeHandOrder(state.hand);
  selected = new Set([...selected].filter((id) => currentHand.some((c) => c.id === id)));
  // Une reprise de pioche (rami-undo-draw) peut faire disparaitre de la main
  // des cartes deja mises en attente d'ouverture : ces groupes ne sont plus
  // valides, on les enleve plutot que de laisser des references mortes.
  openStaging = openStaging.filter((g) => g.cardIds.every((id) => currentHand.some((c) => c.id === id)));
  if (state.hasOpened) openStaging = [];
  handleNewDraw(latestState, state);
  latestState = state;
  renderAll();
});

function makeScoreRow(cellsText) {
  const tr = document.createElement('tr');
  for (const text of cellsText) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
  }
  return tr;
}

function animateCount(el, from, to, duration) {
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = Math.round(from + (to - from) * t);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function showRevealPopup(text) {
  const el = document.getElementById('rami-end-reveal-popup');
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

// Revele le classement un joueur a la fois, du dernier au premier (suspense),
// chaque ligne inseree en haut du tableau pour que l'ordre final affiche bien
// le meilleur score en premier - avec le total qui compte en direct plutot
// que d'afficher instantanement le tableau complet.
function revealScoresSequentially(sortedDesc) {
  const body = document.getElementById('rami-end-body');
  body.innerHTML = '';
  const revealOrder = [...sortedDesc].reverse();
  const best = sortedDesc[0];
  let i = 0;
  function revealNext() {
    if (i >= revealOrder.length) {
      setTimeout(() => document.getElementById('rami-end-reveal-popup').classList.add('hidden'), 900);
      return;
    }
    const s = revealOrder[i];
    i++;
    const tr = makeScoreRow([s.nickname, s.meldScore, `-${s.handPenalty}`, '0']);
    tr.classList.add('rami-score-row');
    if (s.id === best.id) tr.classList.add('rami-score-row--winner');
    body.prepend(tr);
    void tr.offsetWidth;
    tr.classList.add('rami-score-row--in');
    animateCount(tr.children[3], 0, s.total, 700);
    showRevealPopup(`${s.nickname} : ${s.meldScore} − ${s.handPenalty} = ${s.total}`);
    setTimeout(revealNext, 900);
  }
  revealNext();
}

socket.on('rami-player-disconnected', ({ nickname, graceMs }) => {
  showToast(`🔌 ${nickname} a une connexion instable — ${Math.round(graceMs / 1000)}s pour revenir…`);
  if (opponentStatus) {
    opponentStatus.textContent = '🔌 déconnecté…';
    opponentStatus.classList.remove('hidden');
  }
});

socket.on('rami-player-reconnected', ({ nickname }) => {
  showToast(`✅ ${nickname} est de retour !`);
  if (opponentStatus) opponentStatus.classList.add('hidden');
});

// Reconnexion en pleine partie : le serveur a retrouve le joueur via son
// jeton et renvoie un etat complet (identique a rami-state) pour reprendre
// exactement ou il en etait.
socket.on('rami-rejoin-ok', ({ myId: id, ...state }) => {
  showReconnectingOverlay(false);
  joinModal.classList.add('hidden');
  myId = id;
  currentHand = state.hand;
  selected = new Set();
  openStaging = [];
  lastDrawnCardId = state.drawnCardId; // resynchro : pas un nouveau tirage, pas de pop-up
  latestState = state;
  if (opponentStatus) opponentStatus.classList.add('hidden');
  showScreen('game');
  renderAll();
});

socket.on('rami-rejoin-failed', () => {
  clearActiveRoom();
  showReconnectingOverlay(false);
  const fallback = rejoinFallback;
  rejoinFallback = null;
  if (fallback && fallback !== 'link') {
    myNickname = fallback.nickname;
    socket.emit('rami-join-room', { code: fallback.code, nickname: fallback.nickname, token: getPlayerToken() });
    return;
  }
  if (fallback === 'link') {
    joinModalError.textContent = '';
    btnJoinModal.disabled = false;
    joinModal.classList.remove('hidden');
    joinModalNickname.focus();
    return;
  }
  // sinon (tentative silencieuse au chargement/a la reconnexion) : on ne
  // bouscule pas l'ecran actuel, juste la partie active locale a ete effacee.
});

socket.on('disconnect', () => {
  showReconnectingOverlay(true);
});

socket.on('connect', () => {
  attemptAutoRejoin(roomFromUrl ? 'link' : null);
});

socket.on('rami-game-end', ({ summary, gameWinnerId, myId: id }) => {
  if (id) myId = id;
  showReconnectingOverlay(false);
  joinModal.classList.add('hidden');
  const gameWinner = summary.find((s) => s.id === gameWinnerId);
  document.getElementById('rami-end-title').textContent =
    gameWinnerId === myId ? 'Tu remportes la partie ! 🏆' : `${gameWinner ? gameWinner.nickname : 'Un joueur'} remporte la partie !`;
  showScreen('end');
  revealScoresSequentially([...summary].sort((a, b) => b.total - a.total));
});

document.getElementById('rami-btn-rematch').addEventListener('click', () => socket.emit('rami-rematch'));

// --- Choix accueil / rejoindre via lien ---

const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('room');

// Point d'entree commun aux 3 facons de "revenir" : cliquer le lien partage
// (roomFromUrl), retaper le code, ou simplement rouvrir l'onglet / revenir
// en arriere (aucun ?room= dans l'URL, mais une partie active sauvegardee).
// Ne fait rien si rien ne correspond a une partie deja rejointe sur ce
// navigateur - le flux normal (creer/rejoindre) prend alors le relais.
function attemptAutoRejoin(fallback) {
  const saved = loadActiveRoom();
  const code = (roomFromUrl && roomFromUrl.toUpperCase()) || (saved && saved.code);
  if (!code || !saved || saved.code !== code) return false;
  rejoinFallback = fallback || null;
  showReconnectingOverlay(true);
  socket.emit('rami-rejoin-room', { code, token: getPlayerToken() });
  return true;
}

// La tentative de reconnexion elle-meme se fait dans socket.on('connect', ...)
// plus haut : io() se connecte tout seul des le chargement, donc ce meme
// evenement couvre a la fois le tout premier chargement de la page et une
// reconnexion plus tard apres une coupure reseau - pas besoin d'un appel
// separe ici. Le flux habituel ci-dessous s'affiche par defaut ; l'ecran de
// jeu prendra le relais automatiquement si la reconnexion aboutit.
if (roomFromUrl) {
  showScreen(null);
  joinModalError.textContent = '';
  btnJoinModal.disabled = false;
  joinModal.classList.remove('hidden');
  joinModalNickname.focus();
} else {
  showScreen('home');
}
