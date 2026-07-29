const socket = io();

function getPlayerToken() {
  let token = sessionStorage.getItem('cardGamesPlayerToken');
  if (!token) {
    token = crypto.randomUUID();
    sessionStorage.setItem('cardGamesPlayerToken', token);
  }
  return token;
}
const ACTIVE_ROOM_KEY = 'ascenseur:activeRoom';
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

function cardLabel(card) {
  return `${card.label}${SUIT_SYMBOL[card.suit]}`;
}
function cardColorClass(card) {
  return RED_SUITS.has(card.suit) ? 'card-red' : 'card-black';
}
function cardFaceHTML(card) {
  const symbol = SUIT_SYMBOL[card.suit];
  return `
    <span class="card-corner"><span class="card-corner-rank">${card.label}</span><span class="card-corner-suit">${symbol}</span></span>
    <span class="card-emblem">${symbol}</span>
  `;
}

const screens = {
  home: document.getElementById('asc-screen-home'),
  waiting: document.getElementById('asc-screen-waiting'),
  game: document.getElementById('asc-screen-game'),
  end: document.getElementById('asc-screen-end'),
};
function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
}

const toastEl = document.getElementById('asc-toast');
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

const inputNickname = document.getElementById('asc-input-nickname');
const homeError = document.getElementById('asc-home-error');
const btnCreate = document.getElementById('asc-btn-create');
const formJoin = document.getElementById('asc-form-join');
const inputCode = document.getElementById('asc-input-code');
const btnRules = document.getElementById('asc-btn-rules');
const rulesModal = document.getElementById('asc-rules-modal');
const btnCloseRules = document.getElementById('asc-btn-close-rules');

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
  socket.emit('ascenseur-create-room', { nickname, token: getPlayerToken() });
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
    socket.emit('ascenseur-rejoin-room', { code, token: getPlayerToken() });
    return;
  }
  socket.emit('ascenseur-join-room', { code, nickname, token: getPlayerToken() });
});

btnRules.addEventListener('click', () => rulesModal.classList.remove('hidden'));
btnCloseRules.addEventListener('click', () => rulesModal.classList.add('hidden'));

// --- Salon d'attente ---

const shareBlock = document.getElementById('asc-share-block');
const shareLink = document.getElementById('asc-share-link');
const shareCode = document.getElementById('asc-share-code');
const btnCopy = document.getElementById('asc-btn-copy');
const btnLeaveWaiting = document.getElementById('asc-btn-leave-waiting');
const lobbyPlayers = document.getElementById('asc-lobby-players');
const lobbyList = document.getElementById('asc-lobby-list');
const lobbyCount = document.getElementById('asc-lobby-count');
const btnStartGame = document.getElementById('asc-btn-start-game');
const waitingHint = document.getElementById('asc-waiting-hint');

const joinModal = document.getElementById('asc-join-modal');
const joinModalNickname = document.getElementById('asc-join-modal-nickname');
const btnJoinModal = document.getElementById('asc-btn-join-modal');
const joinModalError = document.getElementById('asc-join-modal-error');

let myIsHost = false;

function goHome() {
  clearActiveRoom();
  socket.emit('ascenseur-leave-room');
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);
  joinModal.classList.add('hidden');
  inputNickname.value = '';
  showScreen('home');
}

btnLeaveWaiting.addEventListener('click', goHome);
document.getElementById('asc-btn-leave-game').addEventListener('click', goHome);
document.getElementById('asc-btn-leave-end').addEventListener('click', goHome);

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

socket.on('ascenseur-room-created', ({ code }) => {
  setCreateBusy(false);
  saveActiveRoom(code, myNickname);
  const url = `${window.location.protocol}//${window.location.host}/ascenseur.html?room=${code}`;
  shareLink.value = url;
  shareCode.textContent = code;
  shareBlock.classList.remove('hidden');
});

socket.on('ascenseur-lobby-update', ({ code, players, hostId, isHost, canStart, minPlayers, maxPlayers }) => {
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
    waitingHint.textContent = canStart
      ? 'Prêt ! Lance la partie quand tu veux.'
      : `Il faut au moins ${minPlayers} joueurs pour commencer…`;
  } else {
    waitingHint.textContent = "En attente que l'hôte lance la partie…";
  }
});

socket.on('ascenseur-error', (message) => {
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

socket.on('ascenseur-player-left', ({ nickname, reason }) => {
  if (reason) {
    showToast(`${nickname} a quitté la partie — retour au classement actuel.`);
  } else {
    showToast(`${nickname} a quitté le salon.`);
  }
});

btnStartGame.addEventListener('click', () => socket.emit('ascenseur-start-game'));

btnJoinModal.addEventListener('click', () => {
  const nickname = joinModalNickname.value.trim().slice(0, 16);
  if (!nickname) {
    joinModalError.textContent = 'Entre un pseudo avant de continuer.';
    return;
  }
  joinModalError.textContent = '';
  btnJoinModal.disabled = true;
  myNickname = nickname;
  socket.emit('ascenseur-join-room', { code: roomFromUrl.toUpperCase(), nickname, token: getPlayerToken() });
});


// --- Partie en cours ---

const roundIndicator = document.getElementById('asc-round-indicator');
const btnEndGame = document.getElementById('asc-btn-end-game');
const tableEl = document.getElementById('asc-table');
const trumpCardEl = document.getElementById('asc-trump-card');
const trumpLabelEl = document.getElementById('asc-trump-label');
const trickCardsEl = document.getElementById('asc-trick-cards');
const trickCaptionEl = document.getElementById('asc-trick-caption');
const turnIndicator = document.getElementById('asc-turn-indicator');
const bidChoices = document.getElementById('asc-bid-choices');
const handEl = document.getElementById('asc-hand');
const scoreboardRows = document.getElementById('asc-scoreboard-rows');
const elevatorFill = document.getElementById('asc-elevator-fill');
const elevatorKnob = document.getElementById('asc-elevator-knob');
const elevatorLabel = document.getElementById('asc-elevator-label');

let latestState = null;

// Position de chaque siège autour de la table ovale, en % de sa largeur et
// de sa hauteur. Index 0 = moi, toujours en bas au centre ; les autres se
// répartissent de gauche à droite dans l'ordre du tour, ce qui fait tourner
// le jeu dans le sens des aiguilles d'une montre à l'écran. Même principe
// que SEAT_POSITIONS côté Bataille.
const SEAT_POSITIONS = {
  3: [[50, 92], [14, 34], [86, 34]],
  4: [[50, 92], [8, 52], [50, 10], [92, 52]],
  5: [[50, 92], [7, 60], [24, 16], [76, 16], [93, 60]],
  6: [[50, 92], [6, 64], [16, 25], [50, 9], [84, 25], [94, 64]],
  7: [[50, 92], [6, 66], [13, 32], [34, 11], [66, 11], [87, 32], [94, 66]],
};

// Réordonne les joueurs pour que "moi" soit toujours en premier (donc en bas
// de l'écran), les autres suivant dans l'ordre du tour à partir de moi.
function seatOrder(players) {
  const myIndex = players.findIndex((p) => p.id === myId);
  if (myIndex === -1) return players;
  return [...players.slice(myIndex), ...players.slice(0, myIndex)];
}

function nicknameOf(state, id) {
  const p = state.players.find((pp) => pp.id === id);
  return p ? p.nickname : '?';
}

function renderSeats(state) {
  const ordered = seatOrder(state.players);
  const positions = SEAT_POSITIONS[ordered.length] || SEAT_POSITIONS[4];
  tableEl.querySelectorAll('.asc-seat').forEach((el) => el.remove());

  ordered.forEach((p, i) => {
    const [left, top] = positions[i];
    const seat = document.createElement('div');
    seat.className = 'asc-seat' + (p.id === myId ? ' asc-seat--me' : '');
    seat.style.left = left + '%';
    seat.style.top = top + '%';
    if (!p.connected) seat.classList.add('asc-seat--disconnected');

    const activeId = state.phase === 'bidding' ? state.bidTurnPlayerId : state.turnPlayerId;
    if (p.id === activeId) seat.classList.add('asc-seat--turn');

    // Dos de cartes seulement pour les autres : ma propre main est déjà
    // affichée en éventail sous la table.
    if (p.id !== myId) {
      const cards = document.createElement('div');
      cards.className = 'asc-seat-cards';
      for (let c = 0; c < p.handCount; c++) {
        const back = document.createElement('div');
        back.className = 'asc-back-card';
        cards.appendChild(back);
      }
      seat.appendChild(cards);
    }

    const label = document.createElement('div');
    label.className = 'asc-seat-label';
    const name = document.createElement('span');
    name.className = 'asc-seat-name';
    name.textContent = (p.connected ? '' : '🔌 ') + p.nickname;
    label.appendChild(name);

    // "plis réalisés / annonce" — le cœur de l'info dans ce jeu.
    const bidEl = document.createElement('span');
    bidEl.className = 'asc-seat-bid';
    bidEl.textContent = p.bid === undefined || p.bid === null ? '?' : `${p.tricksWon}/${p.bid}`;
    label.appendChild(bidEl);

    if (p.id === state.dealerId) {
      const chip = document.createElement('span');
      chip.className = 'asc-seat-dealer';
      chip.textContent = 'D';
      chip.title = 'Donneur';
      label.appendChild(chip);
    }

    seat.appendChild(label);
    tableEl.appendChild(seat);
  });
}

function renderTrump(state) {
  if (state.trumpCard) {
    trumpCardEl.className = `asc-trump-card ${cardColorClass(state.trumpCard)}`;
    trumpCardEl.innerHTML = cardFaceHTML(state.trumpCard);
    trumpCardEl.classList.remove('hidden');
    trumpLabelEl.textContent = `Atout ${SUIT_SYMBOL[state.trumpSuit]}`;
  } else {
    trumpCardEl.classList.add('hidden');
    trumpLabelEl.textContent = 'Sans atout';
  }
}

// Le pli au centre : les cartes se chevauchent comme une vraie levée posée
// sur la table, et celle qui l'emporte pour l'instant est soulevée et
// entourée de vert.
function renderTrick(state) {
  trickCardsEl.innerHTML = '';
  const trick = state.currentTrick || [];

  trick.forEach((t) => {
    const slot = document.createElement('div');
    slot.className = 'asc-trick-slot';
    if (t.playerId === state.leadingPlayerId) slot.classList.add('asc-trick-slot--leading');

    const cardEl = document.createElement('div');
    cardEl.className = `asc-card ${cardColorClass(t.card)}`;
    cardEl.innerHTML = cardFaceHTML(t.card);
    slot.appendChild(cardEl);

    const name = document.createElement('span');
    name.className = 'asc-trick-name';
    name.textContent = nicknameOf(state, t.playerId);
    slot.appendChild(name);

    trickCardsEl.appendChild(slot);
  });

  if (trick.length === 0) {
    trickCaptionEl.textContent = '';
  } else if (state.trickPaused) {
    const winner = state.leadingPlayerId === myId ? 'Tu remportes' : `${nicknameOf(state, state.leadingPlayerId)} remporte`;
    trickCaptionEl.textContent = `🏆 ${winner} le pli !`;
  } else {
    const leader = state.leadingPlayerId === myId ? 'Tu mènes' : `${nicknameOf(state, state.leadingPlayerId)} mène`;
    trickCaptionEl.textContent = `${leader} le pli`;
  }
}

function renderBidChoices(state) {
  bidChoices.innerHTML = '';
  if (state.phase !== 'bidding' || !state.isMyBidTurn) return;
  for (let n = 0; n <= state.cardsInRound; n++) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = n;
    btn.addEventListener('click', () => socket.emit('ascenseur-bid', { bid: n }));
    bidChoices.appendChild(btn);
  }
}

function renderTurnIndicator(state) {
  if (state.phase === 'bidding') {
    turnIndicator.textContent = state.isMyBidTurn
      ? 'Combien de plis vas-tu faire ?'
      : `${nicknameOf(state, state.bidTurnPlayerId)} annonce…`;
    return;
  }
  if (state.trickPaused) {
    turnIndicator.textContent = 'Le pli se ramasse…';
    return;
  }
  turnIndicator.textContent = state.isMyTurn ? 'À toi de jouer !' : `${nicknameOf(state, state.turnPlayerId)} joue…`;
}

// Main en éventail, même technique qu'au Rami : un wrapper porte la rotation
// de l'arc, la carte garde sa propre transformation (survol) pour que les
// deux se composent au lieu de s'écraser.
function renderHand(state) {
  handEl.innerHTML = '';
  const hand = state.hand || [];
  const canPlay = state.phase === 'playing' && state.isMyTurn;
  const hasLeadSuit = state.leadSuit && hand.some((c) => c.suit === state.leadSuit);

  const n = hand.length;
  const maxSpread = Math.min(6 * Math.max(n - 1, 0), 40);
  const step = n > 1 ? maxSpread / (n - 1) : 0;

  hand.forEach((card, i) => {
    const angle = n > 1 ? -maxSpread / 2 + i * step : 0;
    const normalized = n > 1 ? Math.abs(i - (n - 1) / 2) / ((n - 1) / 2) : 0;
    const lift = normalized * normalized * 14;

    const arc = document.createElement('div');
    arc.className = 'asc-card-arc';
    arc.style.transform = `rotate(${angle}deg) translateY(${lift}px)`;

    const illegal = canPlay && hasLeadSuit && card.suit !== state.leadSuit;
    const el = document.createElement('div');
    el.className = `asc-card ${cardColorClass(card)}${illegal ? ' asc-card--disabled' : ''}`;
    el.innerHTML = cardFaceHTML(card);
    if (illegal) el.title = `Tu dois fournir ${SUIT_SYMBOL[state.leadSuit]}`;
    if (canPlay && !illegal) {
      el.addEventListener('click', () => socket.emit('ascenseur-play-card', { cardId: card.id }));
    }

    arc.appendChild(el);
    handEl.appendChild(arc);
  });
}

// Tableau volontairement réduit aux totaux : le détail manche par manche
// passe par le pop-up de fin de manche, et la progression dans la
// montée-descente est portée par la barre "ascenseur" au-dessus.
function renderScoreboard(state) {
  scoreboardRows.innerHTML = '';
  [...state.scoreboard]
    .sort((a, b) => b.total - a.total)
    .forEach((s) => {
      const row = document.createElement('div');
      row.className = 'asc-score-row' + (s.id === myId ? ' asc-score-row--me' : '');
      const name = document.createElement('span');
      name.className = 'asc-score-row-name';
      name.textContent = s.nickname;
      const total = document.createElement('span');
      total.className = 'asc-score-row-total';
      total.textContent = s.total;
      row.appendChild(name);
      row.appendChild(total);
      scoreboardRows.appendChild(row);
    });

  const progress = state.totalRounds > 1 ? (state.roundNumber - 1) / (state.totalRounds - 1) : 0;
  elevatorFill.style.width = `${progress * 100}%`;
  elevatorKnob.style.left = `${progress * 100}%`;
  elevatorKnob.textContent = state.cardsInRound;
  elevatorLabel.textContent = `${state.cardsInRound} carte${state.cardsInRound > 1 ? 's' : ''} par joueur`;
}

function renderGame(state) {
  latestState = state;
  roundIndicator.textContent = `Manche ${state.roundNumber}`;
  btnEndGame.classList.toggle('hidden', !myIsHost);
  renderSeats(state);
  renderTrump(state);
  renderTrick(state);
  renderBidChoices(state);
  renderTurnIndicator(state);
  renderHand(state);
  renderScoreboard(state);
}

btnEndGame.addEventListener('click', () => socket.emit('ascenseur-end-game'));

// --- Pop-up de fin de manche ---

const roundPopup = document.getElementById('asc-round-popup');
const roundPopupTitle = document.getElementById('asc-round-popup-title');
const roundPopupRows = document.getElementById('asc-round-popup-rows');
const roundPopupBar = document.getElementById('asc-round-popup-bar');
const btnNextRound = document.getElementById('asc-btn-next-round');

btnNextRound.addEventListener('click', () => socket.emit('ascenseur-next-round'));

// Les scores s'affichent le temps que tout le monde les lise, puis le
// serveur enchaîne tout seul sur la manche suivante — la barre du bas montre
// combien de temps il reste.
function showRoundPopup(state) {
  const summary = state.roundSummary;
  roundPopupTitle.textContent = `Manche ${summary.round} terminée`;
  roundPopupRows.innerHTML = '';

  [...summary.results]
    .sort((a, b) => b.delta - a.delta)
    .forEach((r) => {
      const row = document.createElement('div');
      row.className = 'asc-round-popup-row';
      const left = document.createElement('span');
      left.innerHTML = `${r.nickname} <span class="asc-round-popup-row-detail">— annoncé ${r.bid}, fait ${r.made}</span>`;
      const delta = document.createElement('span');
      delta.className = `asc-round-popup-row-delta ${r.delta >= 0 ? 'asc-delta--up' : 'asc-delta--down'}`;
      delta.textContent = r.delta >= 0 ? `+${r.delta}` : r.delta;
      row.appendChild(left);
      row.appendChild(delta);
      roundPopupRows.appendChild(row);
    });

  btnNextRound.classList.toggle('hidden', !myIsHost);
  roundPopup.classList.remove('hidden');

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

const endTitle = document.getElementById('asc-end-title');
const endBody = document.getElementById('asc-end-body');

function renderGameEnd(state) {
  const ranking = state.finalRanking;
  const winner = ranking[0];
  endTitle.textContent = winner.id === myId ? 'Tu remportes la partie ! 🏆' : `${winner.nickname} remporte la partie !`;
  endBody.innerHTML = ranking.map((r) => `<tr><td>${r.nickname}</td><td>${r.total}</td></tr>`).join('');
}

document.getElementById('asc-btn-rematch').addEventListener('click', () => socket.emit('ascenseur-rematch'));

// --- Dispatch d'état ---

// La manche suivante est déjà distribuée quand le pop-up de fin de manche se
// ferme : l'écran de jeu reste donc affiché en dessous en permanence, seul
// le pop-up apparaît et disparaît par-dessus.
function applyState(state) {
  myId = state.myId;
  myIsHost = state.isHost;
  showReconnectingOverlay(false);
  joinModal.classList.add('hidden');

  if (state.phase === 'bidding' || state.phase === 'playing') {
    hideRoundPopup();
    showScreen('game');
    renderGame(state);
    return;
  }
  if (state.phase === 'round-end') {
    showScreen('game');
    // Les totaux se mettent à jour derrière le pop-up : on voit les points
    // de la manche atterrir dans le tableau pendant qu'on lit le détail.
    renderScoreboard(state);
    showRoundPopup(state);
    return;
  }
  if (state.phase === 'game-end') {
    hideRoundPopup();
    showScreen('end');
    renderGameEnd(state);
  }
}

socket.on('ascenseur-state', applyState);
socket.on('ascenseur-rejoin-ok', applyState);

socket.on('ascenseur-player-disconnected', ({ nickname, graceMs }) => {
  showToast(`🔌 ${nickname} a une connexion instable — ${Math.round(graceMs / 1000)}s pour revenir…`);
});

socket.on('ascenseur-player-reconnected', ({ nickname }) => {
  showToast(`✅ ${nickname} est de retour !`);
});

socket.on('ascenseur-rejoin-failed', () => {
  clearActiveRoom();
  showReconnectingOverlay(false);
  const fallback = rejoinFallback;
  rejoinFallback = null;
  if (fallback && fallback !== 'link') {
    myNickname = fallback.nickname;
    socket.emit('ascenseur-join-room', { code: fallback.code, nickname: fallback.nickname, token: getPlayerToken() });
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
  socket.emit('ascenseur-rejoin-room', { code, token: getPlayerToken() });
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
