// Bots Skull King.
//
// Permet de lancer une partie même sans équipage complet : les bots jouent
// volontairement de façon simple (première carte jouable, annonce au hasard).
//
// Principe : un bot est un faux socket. skullking-room.js n'utilise du socket
// que `id`, `data`, `on` et `emit` — un EventEmitter suffit donc à recevoir
// les mêmes handlers que ceux d'un vrai joueur, et les actions du bot passent
// exactement par le même chemin de validation que celles d'un humain (aucune
// règle contournée, aucun code de jeu dupliqué).

const { EventEmitter } = require('events');

// Réponse volontairement lente : on veut pouvoir SUIVRE ce qui se passe à
// l'écran pendant un test, pas voir la manche se dérouler d'un coup.
const BOT_THINK_MS = 700;

// La manche 1 a son rythme à elle, et ce n'est pas un rythme de bot : les
// cartes de tout le monde sont sur le tapis depuis l'annonce, personne n'a
// rien à décider, et chaque client pose la sienne tout seul après un temps de
// lecture (MANCHE1_LECTURE_MS, côté skullking.js). Un bot qui répondrait à
// son pas habituel jouerait trois fois plus vite que l'humain assis à côté de
// lui : la manche se déroulerait à SA cadence, et le temps de lecture réglé
// pour les joueurs ne se verrait que dans une partie entre humains — soit
// jamais pendant un test. Les deux valeurs vont donc ensemble.
const BOT_MANCHE1_MS = 1200;

const BOT_NAMES = ['Barbe-Rousse', 'Anne Bonny', 'Le Borgne', 'Calico Jack', 'Mary Read', 'Flint', 'Jack le Rouge', 'La Buse'];

// Un faux socket par bot, indexé par son id — sert à ré-émettre ses actions.
const botSockets = new Map();

function isBot(playerId) {
  return botSockets.has(playerId);
}

function makeBotSocket(io, registerHandlers) {
  const socket = new EventEmitter();
  socket.id = `bot:${Math.random().toString(36).slice(2, 10)}`;
  socket.data = {};
  // Le serveur émet vers le client via socket.emit ; pour un bot ça ne doit
  // rien faire de plus que déclencher d'éventuels listeners locaux (aucun).
  registerHandlers(io, socket);
  botSockets.set(socket.id, socket);
  return socket;
}

function addBot(io, room, registerHandlers) {
  const taken = new Set(room.players.map((p) => p.nickname));
  const nickname = BOT_NAMES.find((n) => !taken.has(n)) || `Bot ${room.players.length + 1}`;
  const socket = makeBotSocket(io, registerHandlers);
  // On passe par le vrai handler de la salle : mêmes contrôles (partie en
  // cours, salle pleine, pseudo valide) que pour un joueur humain.
  socket.emit('skullking-join-room', { code: room.code, nickname, token: socket.id });
  if (!room.players.some((p) => p.id === socket.id)) {
    botSockets.delete(socket.id);
    return null;
  }
  return socket.id;
}

// --- Décisions ---

function pickBid(state) {
  // Annonce grossièrement plausible : un peu plus souvent basse que haute.
  const max = state.cardsInRound;
  const roll = Math.random();
  if (roll < 0.35) return 0;
  return Math.min(max, 1 + Math.floor(Math.random() * Math.max(1, max)));
}

function playPayload(state) {
  const hand = state.hand || [];
  const trick = state.currentTrick || [];
  // Mary Thorne peut imposer une carte précise : elle prime sur tout le reste.
  if (state.forcedCardId) {
    const forced = hand.find((c) => c.id === state.forcedCardId);
    if (forced) return withChoices(forced, trick, state);
  }
  const led = ledSuitOf(trick);
  const mustFollow = led !== null && hand.some((c) => c.kind === 'number' && c.suit === led);
  const playable = hand.filter((c) => {
    if (c.kind !== 'number') return true;
    if (led === null || c.suit === led) return true;
    return !mustFollow;
  });
  const card = playable[Math.floor(Math.random() * playable.length)] || hand[0];
  return card ? withChoices(card, trick, state) : null;
}

function ledSuitOf(trick) {
  for (const play of trick) {
    if (play.card.kind === 'number') return play.card.suit;
  }
  return null;
}

// Certaines cartes exigent un choix au moment de la pose : le serveur refuse
// la pose sans ce choix, le bot doit donc le fournir comme un joueur humain.
function withChoices(card, trick, state) {
  const payload = { cardId: card.id };
  if (card.kind === 'tigress') payload.chosenAs = Math.random() < 0.7 ? 'pirate' : 'escape';
  if (card.kind === 'number' && card.wild14 && card.value == null) payload.declaredValue = 14;
  if (card.kind === 'wild15' && ledSuitOf(trick) === null) payload.chosenSuit = 'vert';
  return payload;
}

// Renvoie [event, payload] pour le pouvoir en attente, ou null.
function powerAction(state) {
  const pending = state.pendingPower;
  if (!pending || !pending.mine) return null;
  switch (pending.kind) {
    case 'rosie':
      return ['skullking-power-rosie', { leaderId: state.myId }];
    case 'marythorne': {
      const targets = (pending.options || []).filter((o) => o.handCount > 0);
      const pick = targets[Math.floor(Math.random() * targets.length)] || pending.options[0];
      return pick ? ['skullking-power-marythorne', { targetId: pick.id }] : null;
    }
    case 'will': {
      const ids = (state.hand || []).slice(0, 2).map((c) => c.id);
      return ids.length === 2 ? ['skullking-power-will', { discardIds: ids }] : null;
    }
    case 'rascal':
      return ['skullking-power-rascal', { stake: 0 }];
    case 'harry':
      return ['skullking-power-harry', { delta: 0 }];
    case 'juanita':
      return ['skullking-power-juanita-done', undefined];
    // Marcher sur la Planche : la cible se désigne une fois le pli complet,
    // pas à la pose - le bot répond donc ici, comme pour un pouvoir.
    case 'plank': {
      const ids = pending.plankTargetIds || [];
      return ids.length ? ['skullking-power-plank', { removesId: ids[0] }] : null;
    }
    default:
      return null;
  }
}

// --- Pilotage ---
// Appelé après chaque broadcast d'état : si un bot a quelque chose à faire, on
// le programme. Le timer est porté par le bot lui-même pour ne jamais empiler
// deux actions sur un même état.
const pending = new Map();

function driveBots(io, room, stateFor) {
  if (!room || !room.players) return;
  for (const player of room.players) {
    const socket = botSockets.get(player.id);
    if (!socket) continue;
    const state = stateFor(room, player);
    const action = decide(state);
    if (!action) {
      clearTimeout(pending.get(player.id));
      pending.delete(player.id);
      continue;
    }
    if (pending.has(player.id)) continue; // une action est déjà programmée
    // Seule la POSE de la manche 1 prend le temps long : l'annonce, elle, se
    // fait à couvert et en même temps que celle des autres, il n'y a rien à
    // regarder tomber.
    const attente = state.roundNumber === 1 && action[0] === 'skullking-play-card'
      ? BOT_MANCHE1_MS
      : BOT_THINK_MS;
    const timer = setTimeout(() => {
      pending.delete(player.id);
      // L'état a pu changer entre-temps : on recalcule avant d'agir.
      const fresh = stateFor(room, player);
      const now = decide(fresh);
      if (now) socket.emit(now[0], now[1]);
    }, attente);
    pending.set(player.id, timer);
  }
}

function decide(state) {
  if (state.phase === 'bidding' && state.myBid === undefined) {
    return ['skullking-bid', { bid: pickBid(state) }];
  }
  if (state.phase === 'power') return powerAction(state);
  if (state.phase === 'playing' && state.isMyTurn) {
    const payload = playPayload(state);
    return payload ? ['skullking-play-card', payload] : null;
  }
  return null;
}

// Retire un bot précis : son minuteur de réflexion en cours et son faux
// socket. Sans ça, un bot supprimé du salon continuait de se réveiller une
// fois (le minuteur ne connaît pas la salle) et son id restait connu de
// isBot, qui sert à décider si une salle n'a plus que des bots.
function removeBot(playerId) {
  clearTimeout(pending.get(playerId));
  pending.delete(playerId);
  return botSockets.delete(playerId);
}

function forgetRoom(room) {
  if (!room || !room.players) return;
  for (const p of room.players) {
    clearTimeout(pending.get(p.id));
    pending.delete(p.id);
    botSockets.delete(p.id);
  }
}

module.exports = { addBot, removeBot, driveBots, isBot, forgetRoom };
