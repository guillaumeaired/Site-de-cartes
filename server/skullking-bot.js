// Bots Skull King.
//
// Permet de lancer une partie même sans équipage complet. Ce module n'est que
// la plomberie : la façon de jouer vit dans server/skullking-bots/, un fichier
// par niveau (voir briefs/bots-skullking.md). Chaque bot porte son niveau et
// sa mémoire de manche.
//
// Principe : un bot est un faux socket. skullking-room.js n'utilise du socket
// que `id`, `data`, `on` et `emit` — un EventEmitter suffit donc à recevoir
// les mêmes handlers que ceux d'un vrai joueur, et les actions du bot passent
// exactement par le même chemin de validation que celles d'un humain (aucune
// règle contournée, aucun code de jeu dupliqué).

const { EventEmitter } = require('events');
const { strategie, niveauValide, NIVEAU_PAR_DEFAUT, catalogue } = require('./skullking-bots');
const { nouvelleMemoire, observer } = require('./skullking-bots/commun');

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
// Le niveau de chaque bot, et ce qu'il a retenu de la manche en cours.
const botNiveaux = new Map();
const botMemoires = new Map();

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

function addBot(io, room, registerHandlers, niveau) {
  const taken = new Set(room.players.map((p) => p.nickname));
  const nickname = BOT_NAMES.find((n) => !taken.has(n)) || `Bot ${room.players.length + 1}`;
  const socket = makeBotSocket(io, registerHandlers);
  // Le niveau avant l'entrée : l'arrivée diffuse déjà le salon, et il doit
  // y paraître avec le bon.
  botNiveaux.set(socket.id, niveauValide(niveau) || NIVEAU_PAR_DEFAUT);
  botMemoires.set(socket.id, nouvelleMemoire());
  // On passe par le vrai handler de la salle : mêmes contrôles (partie en
  // cours, salle pleine, pseudo valide) que pour un joueur humain.
  socket.emit('skullking-join-room', { code: room.code, nickname, token: socket.id });
  if (!room.players.some((p) => p.id === socket.id)) {
    removeBot(socket.id);
    return null;
  }
  return socket.id;
}

function botLevel(playerId) {
  return isBot(playerId) ? botNiveaux.get(playerId) || NIVEAU_PAR_DEFAUT : null;
}

// Change le niveau d'un bot déjà assis. Renvoie false si ce n'est pas un bot
// ou si le niveau n'existe pas : le salon ne redessine alors rien.
function setBotLevel(playerId, niveau) {
  const n = niveauValide(niveau);
  if (!isBot(playerId) || !n) return false;
  botNiveaux.set(playerId, n);
  return true;
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
    // La mémoire voit passer CHAQUE état, même quand le bot n'a rien à faire :
    // c'est comme ça qu'il retient les plis déjà joués.
    const memoire = memoireDe(player.id);
    observer(memoire, state);
    // Savoir SI le bot doit agir ne coûte rien ; savoir QUOI faire peut
    // coûter cher (le Loup de mer simule des centaines de fins de manche).
    // Le choix ne se calcule donc qu'une fois, au réveil du bot — pas à
    // chaque état diffusé, où il aurait été recalculé à chaque annonce et à
    // chaque carte des autres, en bloquant tout le serveur.
    const tache = aFaire(state);
    if (!tache) {
      clearTimeout(pending.get(player.id));
      pending.delete(player.id);
      continue;
    }
    if (pending.has(player.id)) continue; // une action est déjà programmée
    // Seule la POSE de la manche 1 prend le temps long : l'annonce, elle, se
    // fait à couvert et en même temps que celle des autres, il n'y a rien à
    // regarder tomber.
    const attente = state.roundNumber === 1 && tache === 'play'
      ? BOT_MANCHE1_MS
      : BOT_THINK_MS;
    const timer = setTimeout(() => {
      pending.delete(player.id);
      // L'état a pu changer entre-temps : on recalcule avant d'agir.
      const fresh = stateFor(room, player);
      observer(memoireDe(player.id), fresh);
      const now = decide(player.id, fresh);
      if (now) socket.emit(now[0], now[1]);
    }, attente);
    pending.set(player.id, timer);
  }
}

function memoireDe(playerId) {
  if (!botMemoires.has(playerId)) botMemoires.set(playerId, nouvelleMemoire());
  return botMemoires.get(playerId);
}

// Ce que la phase attend du bot, sans rien calculer : 'bid', 'power',
// 'play', ou null s'il n'a rien à faire.
function aFaire(state) {
  if (state.phase === 'bidding' && state.myBid === undefined) return 'bid';
  if (state.phase === 'power' && state.pendingPower && state.pendingPower.mine) return 'power';
  if (state.phase === 'playing' && state.isMyTurn) return 'play';
  return null;
}

// Ce que le bot doit faire maintenant, sous la forme [événement, payload], ou
// null. La phase dit QUAND agir ; la stratégie de son niveau dit QUOI.
function decide(playerId, state) {
  const tache = aFaire(state);
  if (!tache) return null;
  const strat = strategie(botNiveaux.get(playerId));
  const memoire = memoireDe(playerId);
  if (tache === 'bid') return ['skullking-bid', { bid: strat.bid(state, memoire) }];
  if (tache === 'power') return strat.power(state, memoire);
  const payload = strat.play(state, memoire);
  return payload ? ['skullking-play-card', payload] : null;
}

// Retire un bot précis : son minuteur de réflexion en cours et son faux
// socket. Sans ça, un bot supprimé du salon continuait de se réveiller une
// fois (le minuteur ne connaît pas la salle) et son id restait connu de
// isBot, qui sert à décider si une salle n'a plus que des bots.
function removeBot(playerId) {
  clearTimeout(pending.get(playerId));
  pending.delete(playerId);
  botNiveaux.delete(playerId);
  botMemoires.delete(playerId);
  return botSockets.delete(playerId);
}

function forgetRoom(room) {
  if (!room || !room.players) return;
  for (const p of room.players) {
    clearTimeout(pending.get(p.id));
    pending.delete(p.id);
    botSockets.delete(p.id);
    botNiveaux.delete(p.id);
    botMemoires.delete(p.id);
  }
}

module.exports = { makeBotSocket, addBot, removeBot, driveBots, isBot, forgetRoom, botLevel, setBotLevel, botCatalogue: catalogue, decide };
