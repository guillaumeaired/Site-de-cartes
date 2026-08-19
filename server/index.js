const path = require('path');
const os = require('os');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { dealHands, shuffle, buryUpToN } = require('./game');
const { SERVER_STARTED_AT, likelyServerRestart } = require('./server-start');
const { recordGameStarted, getPlayCounts } = require('./play-counts');
const { registerRamiHandlers, getStats: getRamiStats } = require('./rami-room');
const { registerAscenseurHandlers, getStats: getAscenseurStats } = require('./ascenseur-room');
const {
  registerSkullKingHandlers,
  setBotAdapter: setSkullKingBotAdapter,
  getStats: getSkullKingStats,
} = require('./skullking-room');
// Bots de test uniquement (voir skullking-bot.js) : branchés ici pour que le
// module de salle n'en dépende pas.
setSkullKingBotAdapter(require('./skullking-bot'));

// Plus une partie s'eternise, plus une bataille enterre de cartes : le
// nombre de cartes cachees monte de 1 toutes les 3 minutes ecoulees depuis
// le debut de la partie. Ca accelere naturellement les parties qui trainent
// sans changer les regles habituelles au debut.
const BATTLE_ESCALATION_INTERVAL_MS = 3 * 60 * 1000;
const MAX_PLAYERS = 4;

// Une deconnexion (swipe accidentel, reseau qui coupe) ne retire plus le
// joueur tout de suite en pleine partie : on lui laisse ce delai pour
// revenir (lien, code, ou retour en arriere) avant de le considerer parti.
const DISCONNECT_GRACE_MS = 45_000;

function currentBurialSize(room) {
  const elapsed = Date.now() - room.startedAt;
  return 3 + Math.floor(elapsed / BATTLE_ESCALATION_INTERVAL_MS);
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Retire l'en-tete qui annonce la stack technique (Express), et ajoute les
// protections HTTP standards (aucune n'a de cout fonctionnel ici : pas
// d'iframe, pas d'upload de fichiers a sniffer).
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

// Adresse IP locale de la machine sur le reseau Wi-Fi, pour que le lien
// partage fonctionne meme si l'hote a ouvert la page via "localhost".
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const LAN_IP = getLanIp();

// rooms : code -> {
//   code, phase: 'lobby'|'playing', hostId,
//   players: [{ id, nickname, hand }],   // ordre = ordre d'arrivee
//   pile, revealed: { [id]: card }, contenders: [id],
//   gameOver, startedAt
// }
const rooms = new Map();

// Health check applicatif (pas juste TCP) : a declarer comme healthCheckPath
// cote dashboard Render. Repond tant que la boucle d'evenements tourne.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000) });
});

// Observabilite minimale : combien de salons/parties tournent par jeu, sans
// avoir a depouiller les logs Render. Pas d'auth ici (aucune donnee
// personnelle exposee, juste des compteurs), a revisiter si le trafic
// justifie de le proteger.
app.get('/stats', (req, res) => {
  const batailleList = [...rooms.values()];
  res.json({
    uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    bataille: { total: batailleList.length, playing: batailleList.filter((r) => r.phase === 'playing').length },
    rami: getRamiStats(),
    ascenseur: getAscenseurStats(),
    skullking: getSkullKingStats(),
  });
});

// Nombre de parties lancees par jeu (persiste entre reveils, pas entre
// redeploiements) - consomme par le hub pour trier les jeux du plus au
// moins joue.
app.get('/play-counts', (req, res) => {
  res.json(getPlayCounts());
});

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Defense en profondeur : on retire les chevrons, seul vecteur d'injection
// HTML dans les pseudos (les clients les affichent en contexte texte, jamais
// dans un attribut). On les *supprime* au lieu de les echapper : les clients
// echappent deja a l'insertion, un pseudo pre-echappe ici s'afficherait
// double-echappe. Le reste (& " ') est laisse tel quel, ces caracteres etant
// legitimes dans un pseudo et sans danger une fois echappes cote client.
// Cette couche ne dispense donc PAS d'echapper cote client.
function sanitizeNickname(nickname) {
  if (typeof nickname !== 'string') return null;
  const trimmed = nickname.replace(/[<>]/g, '').trim().slice(0, 16);
  return trimmed || null;
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

// Le token survit a une reconnexion (contrairement a socket.id, qui change
// a chaque fois) : c'est lui qui permet de retrouver "le meme joueur".
function findPlayerByToken(room, token) {
  if (!token) return null;
  return room.players.find((p) => p.token === token);
}

// Quand un joueur revient avec un nouveau socket.id, toute structure qui
// indexait l'ancien id doit pointer vers le nouveau.
function rekeyPlayerId(room, oldId, newId) {
  if (room.revealed && oldId in room.revealed) {
    room.revealed[newId] = room.revealed[oldId];
    delete room.revealed[oldId];
  }
  const idx = room.contenders.indexOf(oldId);
  if (idx !== -1) room.contenders[idx] = newId;
  if (room.hostId === oldId) room.hostId = newId;
}

function countsPayload(room) {
  return room.players.map((p) => ({ id: p.id, nickname: p.nickname, count: p.hand.length }));
}

// Etat complet renvoye a un joueur qui se reconnecte en pleine partie, pour
// qu'il reconstruise la table sans avoir suivi les evenements intermediaires.
// NB : ne recree pas l'empilement visuel des cartes de bataille enterrees
// (aucun etat serveur durable pour ca) - il reapparaitra a la bataille suivante.
function buildResyncPayload(room, player) {
  return {
    phase: room.phase,
    myId: player.id,
    hostId: room.hostId,
    players: room.players.map((pp) => ({
      id: pp.id,
      nickname: pp.nickname,
      count: pp.hand.length,
      connected: pp.connected !== false,
    })),
    counts: countsPayload(room),
    contenders: room.contenders,
    revealed: room.revealed,
    gameOver: room.gameOver,
  };
}

function broadcastToRoom(room, event, data) {
  for (const p of room.players) io.to(p.id).emit(event, data);
}

function broadcastLobby(room) {
  for (const p of room.players) {
    io.to(p.id).emit('lobby-update', {
      code: room.code,
      players: room.players.map((pp) => ({ id: pp.id, nickname: pp.nickname })),
      hostId: room.hostId,
      isHost: p.id === room.hostId,
      canStart: room.players.length >= 2,
    });
  }
}

function startNewGame(room) {
  const hands = dealHands(room.players.length);
  room.players.forEach((p, i) => {
    p.hand = hands[i];
  });
  room.pile = [];
  room.revealed = {};
  room.contenders = room.players.map((p) => p.id);
  room.gameOver = false;
  room.startedAt = Date.now();
  room.phase = 'playing';

  for (const p of room.players) {
    io.to(p.id).emit('game-start', {
      myId: p.id,
      hostId: room.hostId,
      players: room.players.map((pp) => ({ id: pp.id, nickname: pp.nickname, count: pp.hand.length })),
    });
  }
}

// Cloture la confrontation en cours : winnerId recupere le pli (melange),
// on recalcule qui est encore actif (main non vide) et si la partie est finie.
// winnerId peut etre null dans le cas rarissime d'egalite totale (pli abandonne).
function resolveRoundEnd(room, winnerId) {
  if (winnerId) {
    const winner = findPlayer(room, winnerId);
    if (winner) winner.hand.push(...shuffle(room.pile));
  }
  room.pile = [];

  const active = room.players.filter((p) => p.hand.length > 0);
  room.gameOver = active.length <= 1;
  room.contenders = active.map((p) => p.id);

  broadcastToRoom(room, 'round-end', {
    winnerId: winnerId || null,
    gameOver: room.gameOver,
    winnerNickname: room.gameOver && active[0] ? active[0].nickname : null,
    counts: countsPayload(room),
  });
}

// Si tous les contenders ont revele, compare leurs cartes : un seul plus
// fort remporte tout ; en cas d'egalite entre plusieurs, seuls les ex-aequo
// enterrent des cartes et repartent pour un nouveau tirage (bataille).
function tryResolveConfrontation(room) {
  const stillWaiting = room.contenders.filter((id) => !room.revealed[id]);
  if (stillWaiting.length > 0 || room.contenders.length === 0) return;

  const max = Math.max(...room.contenders.map((id) => room.revealed[id].value));
  const winners = room.contenders.filter((id) => room.revealed[id].value === max);
  for (const id of room.contenders) delete room.revealed[id];

  if (winners.length === 1) {
    resolveRoundEnd(room, winners[0]);
    return;
  }

  const n = currentBurialSize(room);
  const buriedCounts = {};
  for (const id of winners) {
    const player = findPlayer(room, id);
    // On garde toujours au moins 1 carte pour le tirage decisif : sinon un
    // joueur avec peu de cartes enterrerait tout et perdrait sans avoir pu
    // vraiment jouer sa bataille.
    const burySize = Math.min(n, Math.max(player.hand.length - 1, 0));
    const buried = buryUpToN(player.hand, burySize);
    room.pile.push(...buried);
    buriedCounts[id] = buried.length;
  }
  const stillIn = winners.filter((id) => findPlayer(room, id).hand.length > 0);

  broadcastToRoom(room, 'battle-start', {
    contenders: winners,
    buriedCounts,
    counts: countsPayload(room),
  });

  if (stillIn.length >= 2) {
    room.contenders = stillIn;
  } else {
    resolveRoundEnd(room, stillIn[0] || null);
  }
}

function removePlayer(room, id) {
  const idx = room.players.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const [removed] = room.players.splice(idx, 1);
  delete room.revealed[id];
  room.contenders = room.contenders.filter((cid) => cid !== id);
  return removed;
}

// Depart definitif (quitte explicitement, ou delai de grace expire sans
// retour) : retire vraiment le joueur et fait continuer la partie sans lui.
function finalizeDisconnect(room, id) {
  const removed = removePlayer(room, id);
  if (!removed) return;

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.phase === 'lobby') {
    if (room.hostId === id) {
      const idx = Math.floor(Math.random() * room.players.length);
      room.hostId = room.players[idx].id;
    }
    broadcastToRoom(room, 'player-left', { id: removed.id, nickname: removed.nickname });
    broadcastLobby(room);
    return;
  }

  // En pleine partie, on ne coupe pas tout le monde : la partie continue.
  broadcastToRoom(room, 'player-left', { id: removed.id, nickname: removed.nickname });
  if (room.gameOver) return;

  const active = room.players.filter((p) => p.hand.length > 0);
  if (active.length <= 1) {
    resolveRoundEnd(room, active[0] ? active[0].id : null);
    return;
  }

  tryResolveConfrontation(room); // son depart peut completer le tour en cours
}

// Depart volontaire (bouton "Quitter") : immediat, pas de delai de grace.
function handleExplicitLeave(socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.room = null;
  if (!room) return;
  finalizeDisconnect(room, socket.id);
}

// Coupure automatique (reseau, onglet ferme, swipe accidentel, telephone qui
// met l'onglet en veille) : on laisse toujours un delai de grace avant de
// considerer le joueur parti, y compris en salon d'attente - sinon le simple
// fait de mettre son telephone en veille une seconde pour coller le lien
// d'invitation dans un SMS detruit instantanement le salon qu'on vient de
// creer (bug reel constate : l'hote revient, son propre salon n'existe plus).
function handleDisconnecting(socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.room = null;
  if (!room) return;

  const player = findPlayer(room, socket.id);
  if (!player) return;

  player.connected = false;
  broadcastToRoom(room, 'player-disconnected', {
    id: player.id,
    nickname: player.nickname,
    graceMs: room.phase === 'lobby' ? DISCONNECT_GRACE_MS : null,
  });

  // Salon d'attente : delai de grace toujours necessaire, sinon mettre son
  // telephone en veille une seconde pour coller le lien d'invitation detruit
  // instantanement le salon qu'on vient de creer. En pleine partie en
  // revanche : pause indefinie, comme Ascenseur/Rami/Skull King - le joueur
  // peut revenir a tout moment, sinon seul l'hote choisit explicitement de
  // continuer sans lui (bouton "Terminer" ci-dessous, reutilise
  // finalizeDisconnect a la demande au lieu d'un retrait automatique apres
  // 45s) - aligne sur les 3 autres jeux (audit Backend, 12 aout 2026 ;
  // jusque-la Bataille etait le seul a garder l'ancien retrait auto).
  if (room.phase === 'lobby') {
    player.disconnectTimer = setTimeout(() => {
      if (rooms.get(code) === room) finalizeDisconnect(room, player.id);
    }, DISCONNECT_GRACE_MS);
  }
}

io.on('connection', (socket) => {
  socket.on('create-room', (payload) => {
    const nickname = sanitizeNickname(payload && payload.nickname);
    if (!nickname) {
      socket.emit('join-error', 'Choisis un pseudo avant de créer une partie.');
      return;
    }
    const code = makeRoomCode();
    const token = payload && payload.token;
    const room = {
      code,
      phase: 'lobby',
      hostId: socket.id,
      players: [{ id: socket.id, nickname, hand: [], token, connected: true, disconnectTimer: null }],
      pile: [],
      revealed: {},
      contenders: [],
      gameOver: false,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code;
    socket.emit('room-created', { code, lanIp: LAN_IP, port: PORT });
    broadcastLobby(room);
  });

  socket.on('join-room', (payload) => {
    const code = ((payload && payload.code) || '').toUpperCase();
    const nickname = sanitizeNickname(payload && payload.nickname);
    const room = rooms.get(code);
    if (!room) {
      socket.emit('join-error', "Cette partie n'existe pas (ou plus).");
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('join-error', 'Cette partie a déjà commencé.');
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('join-error', 'Cette partie est complète (4 joueurs max).');
      return;
    }
    if (!nickname) {
      socket.emit('join-error', 'Choisis un pseudo avant de rejoindre.');
      return;
    }
    room.players.push({
      id: socket.id,
      nickname,
      hand: [],
      token: payload && payload.token,
      connected: true,
      disconnectTimer: null,
    });
    socket.join(code);
    socket.data.room = code;
    broadcastLobby(room);
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    if (room.players.length < 2) return;
    recordGameStarted('bataille');
    startNewGame(room);
  });

  // La revanche renvoie tout le monde au salon d'attente (memes joueurs) ;
  // c'est ensuite a l'hote de relancer, comme pour une premiere partie.
  socket.on('request-rematch', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.phase !== 'playing' || !room.gameOver) return;

    room.phase = 'lobby';
    room.pile = [];
    room.revealed = {};
    room.contenders = [];
    room.gameOver = false;
    for (const p of room.players) p.hand = [];

    broadcastLobby(room);
  });

  socket.on('flip-card', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.phase !== 'playing' || room.gameOver) return;

    const player = findPlayer(room, socket.id);
    if (!player) return;
    if (!room.contenders.includes(socket.id)) return; // pas concerne par ce tour
    if (room.revealed[socket.id]) return;
    if (player.hand.length === 0) return;

    const card = player.hand.shift();
    room.pile.push(card);
    room.revealed[socket.id] = card;

    broadcastToRoom(room, 'card-revealed', { by: socket.id, card, counts: countsPayload(room) });

    tryResolveConfrontation(room);
  });

  // L'hote choisit de continuer sans un joueur reste deconnecte, plutot que
  // d'attendre indefiniment son retour (voir handleDisconnecting) - reutilise
  // simplement finalizeDisconnect, comme un retrait qui aurait ete declenche
  // a la demande au lieu d'un minuteur automatique.
  socket.on('end-game', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.phase !== 'playing') return;
    if (socket.id !== room.hostId) return;
    const disconnectedIds = room.players.filter((p) => p.connected === false).map((p) => p.id);
    for (const id of disconnectedIds) {
      const p = findPlayer(room, id);
      if (!p) continue;
      if (p.disconnectTimer) {
        clearTimeout(p.disconnectTimer);
        p.disconnectTimer = null;
      }
      finalizeDisconnect(room, id);
    }
  });

  // Reconnexion : le client redonne le code de la partie + son jeton
  // persistant (localStorage), qu'il ait clique le lien, retape le code, ou
  // que son socket se soit juste reconnecte tout seul apres une coupure.
  socket.on('rejoin-room', (payload) => {
    const code = ((payload && payload.code) || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('rejoin-failed', { reason: likelyServerRestart() ? 'server-restarted' : 'not-found' });
      return;
    }
    const player = findPlayerByToken(room, payload && payload.token);
    if (!player) {
      socket.emit('rejoin-failed', { reason: 'not-found' });
      return;
    }

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    const wasDisconnected = player.connected === false;
    const oldId = player.id;
    rekeyPlayerId(room, oldId, socket.id);
    player.id = socket.id;
    player.connected = true;
    socket.join(code);
    socket.data.room = code;

    if (room.phase === 'lobby') {
      broadcastLobby(room);
      return;
    }

    socket.emit('rejoin-ok', buildResyncPayload(room, player));
    if (wasDisconnected) {
      // oldId permet aux autres clients de re-indexer leur seatRefs (garde
      // la reference DOM du siege) sur le nouveau socket.id.
      broadcastToRoom(room, 'player-reconnected', { id: player.id, oldId, nickname: player.nickname });
    }
  });

  socket.on('leave-room', () => handleExplicitLeave(socket));

  socket.on('disconnecting', () => handleDisconnecting(socket));

  registerRamiHandlers(io, socket);
  registerAscenseurHandlers(io, socket);
  registerSkullKingHandlers(io, socket);
});

// Filet de securite process : l'etat de toutes les parties (4 jeux) ne vit
// qu'en memoire (pas de BDD). Apres une exception non prevue, cet etat peut
// etre partiellement mute et incoherent - continuer a servir des requetes
// dessus risquerait de propager la corruption a d'autres salons plutot que
// de la contenir. On logue puis on arrete proprement le process pour laisser
// Render en relancer un neuf, plutot que logguer-et-continuer indefiniment
// (audit Backend, 12 aout 2026).
function crashSafely(kind, err) {
  console.error(`[${kind}]`, new Date().toISOString(), err);
  httpServer.close(() => process.exit(1));
  // Filet de secours si close() reste bloque (ex. sockets qui ne se
  // terminent jamais) : on force la sortie plutot que de rester zombie.
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('uncaughtException', (err) => crashSafely('uncaughtException', err));
process.on('unhandledRejection', (reason) => crashSafely('unhandledRejection', reason));

httpServer.listen(PORT, () => {
  console.log(`Serveur lancé : http://localhost:${PORT} (réseau local : http://${LAN_IP}:${PORT})`);
});
