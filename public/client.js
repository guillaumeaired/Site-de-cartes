const socket = io();

// Partie active de CET onglet, pour pouvoir y revenir automatiquement via le
// lien, le code, ou un retour en arriere. sessionStorage (pas localStorage),
// pour la meme raison que le jeton de joueur (voir commun.js) : chaque onglet
// doit avoir sa propre session.
const ACTIVE_ROOM_KEY = 'bataille:activeRoom';
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

const screens = {
  home: document.getElementById('screen-home'),
  waiting: document.getElementById('screen-waiting'),
  game: document.getElementById('screen-game'),
  end: document.getElementById('screen-end'),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
}

const homeError = document.getElementById('home-error');
const btnCreate = document.getElementById('btn-create');
const formJoin = document.getElementById('form-join');
const inputCode = document.getElementById('input-code');
const inputNickname = document.getElementById('input-nickname');

const shareBlock = document.getElementById('share-block');
const shareLink = document.getElementById('share-link');
const shareCode = document.getElementById('share-code');
const btnCopy = document.getElementById('btn-copy');
const btnLeaveWaiting = document.getElementById('btn-leave-waiting');
const btnLeaveGame = document.getElementById('btn-leave-game');
const btnEndGame = document.getElementById('btn-end-game');
const waitingHint = document.getElementById('waiting-hint');
const lobbyPlayers = document.getElementById('lobby-players');
const lobbyList = document.getElementById('lobby-list');
const lobbyCount = document.getElementById('lobby-count');
const btnStartGame = document.getElementById('btn-start-game');

const joinModal = document.getElementById('join-modal');
const joinModalNickname = document.getElementById('join-modal-nickname');
const btnJoinModal = document.getElementById('btn-join-modal');
const joinModalError = document.getElementById('join-modal-error');

const tableEl = document.getElementById('table');
const waitingOpponentEl = document.getElementById('waiting-opponent');
const gameToast = document.getElementById('game-toast');
const battleBanner = document.getElementById('battle-banner');
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

const endTitle = document.getElementById('end-title');
const btnRematch = document.getElementById('btn-rematch');
const btnLeaveEnd = document.getElementById('btn-leave-end');

const btnRules = document.getElementById('btn-rules');
const btnCloseRules = document.getElementById('btn-close-rules');
const rulesModal = document.getElementById('rules-modal');

const winnerModal = document.getElementById('winner-modal');
const winnerModalTitle = document.getElementById('winner-modal-title');
const btnWinnerContinue = document.getElementById('btn-winner-continue');

const SUIT_SYMBOL = { coeur: '♥', carreau: '♦', trefle: '♣', pique: '♠' };

// Position (gauche %, haut %) de chaque siege autour de la table ovale,
// selon le nombre total de joueurs. Index 0 = toujours "moi", en bas.
const SEAT_POSITIONS = {
  2: [
    [50, 84],
    [50, 16],
  ],
  3: [
    [50, 82],
    [20, 26],
    [80, 26],
  ],
  4: [
    [50, 84],
    [14, 50],
    [50, 18],
    [86, 50],
  ],
};

// Visage de carte classique façon Balatro : index rang+symbole en haut a
// gauche (couleur pleine, pas de degrade - illisible en petit) + un gros
// symbole plein au centre.
function cardFaceHTML(card) {
  const symbol = SUIT_SYMBOL[card.suit];
  return `
    <span class="card-corner"><span class="card-corner-rank">${card.label}</span><span class="card-corner-suit">${symbol}</span></span>
    <span class="card-emblem">${symbol}</span>
  `;
}

// Affiche une carte avec un vrai retournement 3D : le dos (identique a la
// pile) est visible en premier, puis la carte pivote pour reveler la face.
function renderCard(el, card) {
  if (!card) {
    el.innerHTML = '';
    el.className = 'card-slot';
    return;
  }
  el.className = 'card-slot has-card';
  el.innerHTML = `
    <div class="card-flipper">
      <div class="card-face card-face-back"></div>
      <div class="card-face card-face-front ${RED_SUITS.has(card.suit) ? 'card-red' : 'card-black'}">${cardFaceHTML(card)}</div>
    </div>
  `;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const flipper = el.querySelector('.card-flipper');
      if (flipper) flipper.classList.add('is-flipped');
    });
  });
}

// Petit badge "+N" qui monte et s'estompe au-dessus de la pile du gagnant du tour.
function showGainPopup(pileGroupEl, amount) {
  if (amount <= 0) return;
  const popup = document.createElement('div');
  popup.className = 'gain-popup';
  popup.textContent = `+${amount}`;
  pileGroupEl.appendChild(popup);
  popup.addEventListener('animationend', () => popup.remove());
}

// Ajoute des dos de carte a une pile de bataille SANS effacer ce qui y est
// deja : en cas de bataille enchainee, toutes les cartes engagees doivent
// rester visibles jusqu'a la resolution finale.
// Une partie qui s'eternise peut enchainer plusieurs batailles sans jamais
// vider le war-pile entre elles (voir round-end) : sans plafond, la pile de
// dos de cartes enterrees grandit sans limite et finit par deborder sur le
// siege voisin (positionnement absolu, pas de place reservee). On affiche
// donc au plus MAX_VISIBLE_WAR_CARDS dos de carte, avec un badge "+N" pour
// le reste - la taille du siege reste bornee quelle que soit la duree de la partie.
const MAX_VISIBLE_WAR_CARDS = 4;

function appendWarPile(el, count) {
  const total = (Number(el.dataset.buriedTotal) || 0) + count;
  el.dataset.buriedTotal = total;

  const shown = el.querySelectorAll('.war-card-back').length;
  const toAdd = Math.max(0, Math.min(count, MAX_VISIBLE_WAR_CARDS - shown));
  for (let i = 0; i < toAdd; i++) {
    const back = document.createElement('div');
    back.className = 'war-card-back';
    el.appendChild(back);
  }

  const extra = total - Math.min(total, MAX_VISIBLE_WAR_CARDS);
  let badge = el.querySelector('.war-pile-extra');
  if (extra > 0) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'war-pile-extra';
      el.appendChild(badge);
    }
    badge.textContent = `+${extra}`;
  } else if (badge) {
    badge.remove();
  }
}

function clearWarPile(el) {
  el.innerHTML = '';
  delete el.dataset.buriedTotal;
}

function thicknessClass(count) {
  if (count <= 0) return 'pile--empty';
  if (count <= 8) return 'pile--thin';
  if (count <= 18) return 'pile--medium';
  return 'pile--thick';
}

function playResultTone(won) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'triangle';
    const now = ctx.currentTime;
    if (won) {
      osc.frequency.setValueAtTime(523, now);
      osc.frequency.setValueAtTime(784, now + 0.1);
    } else {
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.setValueAtTime(180, now + 0.15);
    }
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.start(now);
    osc.stop(now + 0.35);
  } catch {
    // audio non disponible, tant pis
  }
}

// Sting grave et dramatique au declenchement d'une bataille (egalite) -
// meme pattern que playResultTone (oscillateur brut, pas de fichier audio).
function playBattleTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(110, now);
    osc.frequency.setValueAtTime(80, now + 0.12);
    osc.frequency.setValueAtTime(65, now + 0.28);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc.start(now);
    osc.stop(now + 0.55);
  } catch {
    // audio non disponible, tant pis
  }
}

// Petit screen shake au moment de la bataille, pour appuyer le cote
// spectaculaire du sting audio.
function shakeScreen() {
  document.body.classList.remove('screen-shake');
  void document.body.offsetWidth; // force le redemarrage de l'animation CSS
  document.body.classList.add('screen-shake');
}

function flashResult(won) {
  const ref = seatRefs.get(myId);
  if (!ref) return;
  ref.seat.classList.remove('seat--result-win', 'seat--result-lose');
  void ref.seat.offsetWidth; // force le redemarrage de l'animation CSS
  ref.seat.classList.add(won ? 'seat--result-win' : 'seat--result-lose');

  playResultTone(won);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let toastTimer = null;
function showToast(message) {
  gameToast.textContent = message;
  gameToast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => gameToast.classList.add('hidden'), 3000);
}

// Les evenements serveur peuvent arriver tres rapproches, alors que chacun a
// sa propre animation. On les rejoue donc un par un, dans l'ordre.
let animationQueue = Promise.resolve();
function enqueue(handler) {
  animationQueue = animationQueue.then(handler).catch((err) => console.error(err));
}

function goHome() {
  clearActiveRoom();
  socket.emit('leave-room');
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);
  tableEl.innerHTML = '';
  seatRefs = new Map();
  battleBanner.classList.add('hidden');
  gameToast.classList.add('hidden');
  winnerModal.classList.add('hidden');
  joinModal.classList.add('hidden');
  inputCode.value = '';
  showScreen('home');
}

// --- Pseudo (obligatoire, jamais pre-rempli) ---

let myNickname = null;
// null (tentative silencieuse) | 'link' (montrer la popup pseudo si echec) |
// { code, nickname } (retenter un join-room classique si echec).
let rejoinFallback = null;

function showReconnectingOverlay(show) {
  reconnectOverlay.classList.toggle('hidden', !show);
}

function requireNickname() {
  const value = inputNickname.value.trim();
  if (!value) {
    homeError.textContent = 'Entre un pseudo avant de continuer.';
    inputNickname.focus();
    return null;
  }
  return value;
}

// --- Creation / connexion a une partie ---

// Le tout premier clic peut arriver avant que le socket ne soit connecte
// (chargement lent) : le bouton reste desactive jusque-la avec un texte
// explicite, plutot que de laisser un clic "ne rien faire" en apparence
// (l'emit est bufferise par Socket.io, mais sans retour visuel ca semble
// casse). Idem pendant l'attente de la reponse serveur, pour eviter les
// doubles clics qui creeraient 2 salons.
const btnCreateDefaultLabel = btnCreate.innerHTML;
function setCreateBusy(busy, label) {
  btnCreate.disabled = busy;
  btnCreate.innerHTML = busy ? label : btnCreateDefaultLabel;
}
if (!socket.connected) setCreateBusy(true, '⏳ Connexion au serveur…');
socket.on('connect', () => setCreateBusy(false));

btnCreate.addEventListener('click', () => {
  const nickname = requireNickname();
  if (!nickname) return;
  homeError.textContent = '';
  myNickname = nickname;
  setCreateBusy(true, '⏳ Création…');
  socket.emit('create-room', { nickname, token: getPlayerToken() });
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
  shareBlock.classList.add('hidden');
  myNickname = nickname;

  const saved = loadActiveRoom();
  if (saved && saved.code === code) {
    rejoinFallback = { code, nickname };
    showReconnectingOverlay(true);
    socket.emit('rejoin-room', { code, token: getPlayerToken() });
    return;
  }
  socket.emit('join-room', { code, nickname, token: getPlayerToken() });
});

btnLeaveWaiting.addEventListener('click', goHome);
btnLeaveGame.addEventListener('click', goHome);
btnEndGame.addEventListener('click', () => socket.emit('end-game'));

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

socket.on('room-created', ({ code }) => {
  setCreateBusy(false);
  saveActiveRoom(code, myNickname);
  const url = `${window.location.protocol}//${window.location.host}/bataille.html?room=${code}`;
  shareLink.value = url;
  shareCode.textContent = code;
  shareBlock.classList.remove('hidden');
  showScreen('waiting');
});

socket.on('join-error', (message) => {
  setCreateBusy(false);
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);

  if (!joinModal.classList.contains('hidden')) {
    // L'erreur concerne une tentative de connexion via le lien d'invitation.
    joinModalError.textContent = message;
    btnJoinModal.disabled = false;
    return;
  }

  showScreen('home');
  homeError.textContent = message;
});

btnJoinModal.addEventListener('click', () => {
  const nickname = joinModalNickname.value.trim().slice(0, 16);
  if (!nickname) {
    joinModalError.textContent = 'Entre un pseudo avant de continuer.';
    return;
  }
  inputNickname.value = nickname;
  myNickname = nickname;
  joinModalError.textContent = '';
  btnJoinModal.disabled = true;
  waitingHint.textContent = 'Connexion à la partie…';
  socket.emit('join-room', { code: roomFromUrl.toUpperCase(), nickname, token: getPlayerToken() });
});

// --- Lobby (salon d'attente) ---

socket.on('lobby-update', ({ code, players, hostId, isHost, canStart }) => {
  saveActiveRoom(code, myNickname);
  showReconnectingOverlay(false);
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

  myIsHost = isHost;
  btnStartGame.classList.toggle('hidden', !isHost);
  btnStartGame.disabled = !canStart;

  if (isHost) {
    waitingHint.textContent = canStart
      ? 'Prêt ! Lance la partie quand tu veux (2 à 4 joueurs).'
      : 'En attente d\'au moins un autre joueur…';
  } else {
    waitingHint.textContent = "En attente que l'hôte lance la partie…";
  }
});

btnStartGame.addEventListener('click', () => {
  socket.emit('start-game');
});

// --- Partie en cours ---

let myId = null;
let myIsHost = false;
let seatRefs = new Map();
// Le bouton "Terminer" n'a d'utilite que s'il y a vraiment quelqu'un a
// laisser de cote - pas affiche s'il ne ferait rien.
let disconnectedIds = new Set();
function updateEndGameButton() {
  btnEndGame.classList.toggle('hidden', !(myIsHost && disconnectedIds.size > 0));
}
// Compte au debut de la confrontation en cours, par id de joueur, pour
// calculer combien de cartes le gagnant a effectivement remportees.
let roundStartCounts = {};

// animateDeal : true uniquement au tout premier lancement d'une partie (pas
// lors d'une reconnexion en cours de partie, ou la table doit reapparaitre
// instantanement telle qu'elle etait, sans rejouer la distribution).
function buildTable(players, animateDeal) {
  tableEl.innerHTML = '';
  seatRefs = new Map();
  const positions = SEAT_POSITIONS[players.length] || SEAT_POSITIONS[2];

  players.forEach((player, i) => {
    const isMe = player.id === myId;
    const seat = document.createElement('div');
    seat.className = 'seat ' + (isMe ? 'seat--me' : 'seat--other');
    const [left, top] = positions[i];
    seat.style.left = left + '%';
    seat.style.top = top + '%';
    if (animateDeal) {
      seat.classList.add('seat--dealing');
      seat.style.animationDelay = `${i * 0.12}s`;
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'seat-name';
    nameEl.textContent = (isMe ? '🙂 ' : '🎭 ') + player.nickname;

    const row = document.createElement('div');
    row.className = 'seat-row';

    const pileGroup = document.createElement('div');
    pileGroup.className = 'pile-group';

    const pileEl = document.createElement(isMe ? 'button' : 'div');
    pileEl.className = 'pile' + (isMe ? ' pile--mine' : '');
    if (isMe) {
      pileEl.type = 'button';
      pileEl.setAttribute('aria-label', 'Retourner ma carte');
      pileEl.addEventListener('click', onFlipClick);
    }

    const countEl = document.createElement('span');
    countEl.className = 'pile-count';
    countEl.textContent = player.count;

    pileGroup.append(pileEl, countEl);

    const cardSlot = document.createElement('div');
    cardSlot.className = 'card-slot';

    row.append(pileGroup, cardSlot);

    const warPile = document.createElement('div');
    warPile.className = 'war-pile';

    seat.append(nameEl, row, warPile);
    tableEl.appendChild(seat);

    seatRefs.set(player.id, { seat, pileGroup, pileEl, cardSlot, warPile, countEl });
  });
}

function applyCounts(counts) {
  for (const c of counts) {
    const ref = seatRefs.get(c.id);
    if (!ref) continue;
    ref.countEl.textContent = c.count;
    ref.pileEl.classList.remove('pile--empty', 'pile--thin', 'pile--medium', 'pile--thick');
    ref.pileEl.classList.add(thicknessClass(c.count));
    ref.seat.classList.toggle('seat--eliminated', c.count <= 0);
  }
}

function updateMyPileState(spectating) {
  const ref = seatRefs.get(myId);
  if (!ref) return;
  const eliminated = Number(ref.countEl.textContent) <= 0;
  ref.pileEl.disabled = eliminated || spectating;

  if (eliminated) {
    waitingOpponentEl.textContent = 'Tu es éliminé, la partie continue…';
    waitingOpponentEl.classList.remove('hidden');
  } else if (spectating) {
    waitingOpponentEl.textContent = "Bataille entre d'autres joueurs, tu patientes…";
    waitingOpponentEl.classList.remove('hidden');
  } else {
    waitingOpponentEl.classList.add('hidden');
  }
}

socket.on('game-start', (data) => {
  myId = data.myId;
  myIsHost = data.hostId === myId;
  disconnectedIds = new Set();
  updateEndGameButton();
  const me = data.players.find((p) => p.id === myId);
  const others = data.players.filter((p) => p.id !== myId);
  const seatOrder = [me, ...others];

  buildTable(seatOrder, true);
  applyCounts(data.players);
  battleBanner.classList.add('hidden');
  gameToast.classList.add('hidden');
  winnerModal.classList.add('hidden');
  roundStartCounts = Object.fromEntries(data.players.map((p) => [p.id, p.count]));
  btnRematch.disabled = false;
  updateMyPileState(false);
  showScreen('game');
});

function showGameOverScreen(iWon, winnerNickname) {
  endTitle.textContent = iWon ? 'Tu as gagné ! 🎉' : `${winnerNickname || 'Un autre joueur'} a gagné.`;
  showScreen('end');
  winnerModalTitle.textContent = iWon
    ? 'Tu remportes la partie !'
    : `${winnerNickname || 'Un autre joueur'} remporte la partie !`;
  winnerModal.classList.remove('hidden');
}

// Reconstruit l'ecran de jeu a partir d'un etat complet renvoye par le
// serveur lors d'une reconnexion en pleine partie (pas d'evenements
// intermediaires suivis, donc pas d'animation ici, juste l'etat final).
function renderResyncedGame(payload) {
  myId = payload.myId;
  myIsHost = payload.hostId === myId;
  const me = payload.players.find((p) => p.id === myId);
  const others = payload.players.filter((p) => p.id !== myId);

  buildTable([me, ...others]);
  applyCounts(payload.counts);
  roundStartCounts = Object.fromEntries(payload.players.map((p) => [p.id, p.count]));
  battleBanner.classList.add('hidden');
  gameToast.classList.add('hidden');
  winnerModal.classList.add('hidden');
  btnRematch.disabled = false;

  for (const id of payload.contenders) {
    const ref = seatRefs.get(id);
    const card = payload.revealed[id];
    if (ref && card) renderCard(ref.cardSlot, card);
  }
  disconnectedIds = new Set();
  for (const p of payload.players) {
    if (p.connected === false) {
      const ref = seatRefs.get(p.id);
      if (ref) ref.seat.classList.add('seat--disconnected');
      disconnectedIds.add(p.id);
    }
  }
  updateEndGameButton();

  if (payload.gameOver) {
    const winner = payload.players.find((p) => p.count > 0);
    showGameOverScreen(Boolean(winner && winner.id === myId), winner && winner.nickname);
    return;
  }

  const spectating = !payload.contenders.includes(myId);
  updateMyPileState(spectating);
  if (payload.revealed[myId]) {
    const ref = seatRefs.get(myId);
    if (ref) ref.pileEl.disabled = true;
    waitingOpponentEl.textContent = 'En attente des autres joueurs…';
    waitingOpponentEl.classList.remove('hidden');
  }
  showScreen('game');
}

function onFlipClick() {
  const ref = seatRefs.get(myId);
  if (!ref || ref.pileEl.disabled) return;
  ref.pileEl.disabled = true;
  waitingOpponentEl.textContent = 'En attente des autres joueurs…';
  waitingOpponentEl.classList.remove('hidden');
  socket.emit('flip-card');
}

// Une carte est revelee des qu'un joueur clique, sans attendre les autres.
socket.on('card-revealed', (data) => {
  enqueue(() => {
    const ref = seatRefs.get(data.by);
    if (ref) renderCard(ref.cardSlot, data.card);
    applyCounts(data.counts);
  });
});

// Egalite entre plusieurs joueurs : leurs cartes a egalite restent affichees
// un instant, puis un gros message "BATAILLE" apparait, puis les cartes
// misees par chacun des ex-aequo se posent sur le cote. Les autres joueurs
// (pas concernes) patientent.
socket.on('battle-start', (data) => {
  enqueue(async () => {
    await sleep(1000);

    battleBanner.classList.remove('hidden');
    shakeScreen();
    playBattleTone();
    await sleep(1200);
    battleBanner.classList.add('hidden');

    for (const id of data.contenders) {
      const ref = seatRefs.get(id);
      if (!ref) continue;
      renderCard(ref.cardSlot, null);
      appendWarPile(ref.warPile, data.buriedCounts[id] || 0);
    }
    applyCounts(data.counts);
    updateMyPileState(!data.contenders.includes(myId));
  });
});

socket.on('round-end', (data) => {
  enqueue(async () => {
    const winnerId = data.winnerId;
    let delta = 0;
    if (winnerId) {
      const winnerCount = data.counts.find((c) => c.id === winnerId);
      delta = (winnerCount ? winnerCount.count : 0) - (roundStartCounts[winnerId] || 0);
    }
    roundStartCounts = Object.fromEntries(data.counts.map((c) => [c.id, c.count]));

    applyCounts(data.counts);
    if (winnerId) flashResult(winnerId === myId);
    if (winnerId) {
      const ref = seatRefs.get(winnerId);
      if (ref) showGainPopup(ref.pileGroup, delta);
    }

    if (data.gameOver) {
      // Le tout dernier pli merite un peu plus de temps avant l'annonce.
      await sleep(1800);
      showGameOverScreen(winnerId === myId, data.winnerNickname);
      return;
    }

    await sleep(900);
    for (const ref of seatRefs.values()) {
      renderCard(ref.cardSlot, null);
      clearWarPile(ref.warPile);
    }
    updateMyPileState(false);
  });
});

socket.on('player-left', ({ id, nickname }) => {
  const ref = seatRefs.get(id);
  if (ref) {
    ref.seat.remove();
    seatRefs.delete(id);
  }
  disconnectedIds.delete(id);
  updateEndGameButton();
  showToast(`${nickname} a quitté la partie — ça continue sans lui.`);
});

socket.on('player-disconnected', ({ id, nickname, graceMs }) => {
  // graceMs est null en pleine partie (pause indefinie, pas de decompte) -
  // seulement fourni en salon d'attente.
  showToast(
    graceMs != null
      ? `🔌 ${nickname} a une connexion instable — ${Math.round(graceMs / 1000)}s pour revenir…`
      : `🔌 ${nickname} s'est déconnecté — la partie est en pause en attendant son retour.`
  );
  const ref = seatRefs.get(id);
  if (ref) ref.seat.classList.add('seat--disconnected');
  disconnectedIds.add(id);
  updateEndGameButton();
});

socket.on('player-reconnected', ({ id, oldId, nickname }) => {
  showToast(`✅ ${nickname} est de retour !`);
  // Le joueur reconnecte a un nouveau socket.id : on re-indexe seatRefs
  // (garde le meme siege DOM) pour que les prochains card-revealed/counts,
  // deja adresses au nouvel id par le serveur, retrouvent bien ce siege.
  if (oldId && oldId !== id && seatRefs.has(oldId)) {
    const ref = seatRefs.get(oldId);
    seatRefs.delete(oldId);
    seatRefs.set(id, ref);
  }
  const ref = seatRefs.get(id);
  if (ref) ref.seat.classList.remove('seat--disconnected');
  disconnectedIds.delete(oldId);
  disconnectedIds.delete(id);
  updateEndGameButton();
});

// Reconnexion en pleine partie : le serveur a retrouve le joueur via son
// jeton et renvoie un etat complet pour reprendre exactement ou il en etait.
socket.on('rejoin-ok', (payload) => {
  showReconnectingOverlay(false);
  joinModal.classList.add('hidden');
  renderResyncedGame(payload);
});

socket.on('rejoin-failed', (payload) => {
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
    socket.emit('join-room', { code: fallback.code, nickname: fallback.nickname, token: getPlayerToken() });
    return;
  }
  if (fallback === 'link') {
    showJoinModalForLink();
  }
  // sinon (tentative silencieuse au chargement/a la reconnexion) : on ne
  // bouscule pas l'ecran actuel, juste la partie active locale a ete effacee.
});

// Socket.io tente de se reconnecter tout seul par defaut ; on affiche juste
// un petit indicateur pendant ce temps, et on retente de rejoindre la
// partie des que la connexion revient (retour d'un onglet mis en arriere-
// plan, reseau qui coupe puis reprend, etc.).
socket.on('disconnect', () => {
  showReconnectingOverlay(true);
  setCreateBusy(true, '⏳ Connexion au serveur…');
});

socket.on('connect', () => {
  attemptAutoRejoin(roomFromUrl ? 'link' : null);
});

btnRules.addEventListener('click', () => rulesModal.classList.remove('hidden'));
btnCloseRules.addEventListener('click', () => rulesModal.classList.add('hidden'));
btnWinnerContinue.addEventListener('click', () => winnerModal.classList.add('hidden'));

// La revanche renvoie tout le monde dans le salon d'attente (avec la meme
// liste de joueurs) : c'est ensuite a l'hote de relancer la partie, comme
// pour un premier lancement.
btnRematch.addEventListener('click', () => {
  btnRematch.disabled = true;
  socket.emit('request-rematch');
});

btnLeaveEnd.addEventListener('click', goHome);

// --- Choix du jeu (accueil) ---

const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('room');

// Va directement a la popup pseudo, sans montrer le salon d'attente (flux
// normal du lien d'invitation, quand aucune reconnexion n'est possible).
function showJoinModalForLink() {
  shareBlock.classList.add('hidden');
  waitingHint.textContent = '';
  showScreen(null);
  joinModalNickname.value = '';
  joinModalError.textContent = '';
  btnJoinModal.disabled = false;
  joinModal.classList.remove('hidden');
  joinModalNickname.focus();
}

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
  socket.emit('rejoin-room', { code, token: getPlayerToken() });
  return true;
}

// La tentative de reconnexion elle-meme se fait dans socket.on('connect', ...)
// plus haut : io() se connecte tout seul des le chargement, donc ce meme
// evenement couvre a la fois le tout premier chargement de la page et une
// reconnexion plus tard apres une coupure reseau - pas besoin d'un appel
// separe ici. Le flux habituel ci-dessous s'affiche par defaut ; l'ecran de
// jeu prendra le relais automatiquement si la reconnexion aboutit.
if (roomFromUrl) {
  showJoinModalForLink();
} else {
  showScreen('home');
}
