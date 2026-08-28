// Salons de L'Ascenseur en Socket.io. Même schéma que les salons de Rami
// (rooms Map, lobby, hôte, jeton/déconnexion avec délai de grâce) mais avec
// l'état spécifique : séquence de manches montée/descente, atout, annonces
// dans l'ordre (donneur en dernier), plis, score cumulé affiché en direct.

const { buildRoundSequence, dealRound, isValidBid, resolveTrick, computeRoundScore } = require('./ascenseur');
const { likelyServerRestart } = require('./server-start');
const { recordGameStarted } = require('./play-counts');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 7;

// Salon d'attente uniquement (voir handleDisconnecting) : délai de grâce
// avant de considérer le joueur vraiment parti.
const DISCONNECT_GRACE_MS = 45_000;

// Déconnexion en pleine partie : pause indéfinie, plus de délai de grâce fixe
// qui met fin à la partie tout seul (décision réconciliée Backend/Game
// Design/UI-UX, Manche 2). La partie attend le retour du joueur sans limite
// de temps ; seul l'hôte peut choisir d'arrêter la partie plus tôt via
// ascenseur-end-game (déjà existant, marche à tout moment).

// Au-delà de la déconnexion : un joueur toujours connecté mais qui met trop
// de temps à agir sur son tour reçoit un simple signal visible de tous (pas
// de saut de tour ni d'exclusion automatique — l'hôte garde la main pour
// arrêter la partie s'il le juge nécessaire).
const INACTIVITY_WARN_MS = 120_000;

// Quand la dernière carte d'un pli tombe, on ne ramasse pas tout de suite :
// sans cette pause, la carte qui vient d'être jouée (et donc le résultat du
// pli) n'est jamais visible pour personne, le pli disparaît dans la même
// diffusion que celle qui l'a complété.
const TRICK_REVEAL_MS = 2_600;

// Fin de manche : les scores s'affichent en pop-up, puis la manche suivante
// démarre toute seule — l'hôte n'a rien à cliquer (il peut quand même
// abréger ou arrêter la partie pendant ce laps de temps).
const ROUND_END_MS = 7_000;

const rooms = new Map();

// Compteurs simples pour l'observabilite (route /stats, server/index.js) -
// pas de dependance a des logs bruts pour savoir combien de parties tournent.
function getStats() {
  const list = [...rooms.values()];
  return { total: list.length, playing: list.filter((r) => r.phase === 'playing').length };
}

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
  if (!trimmed) return null;
  // Une majuscule d'office à l'initiale : le pseudo est affiché partout comme
  // un nom propre — au siège, au registre, dans le verdict de fin — et un
  // « hlo » en bas de casse au milieu de sept noms capitalisés se lit comme
  // une faute d'affichage. Le reste du pseudo n'est pas touché : « McGraw »
  // et « d'Aubigné » restent tels qu'ils ont été saisis.
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function findPlayerByToken(room, token) {
  if (!token) return null;
  return room.players.find((p) => p.token === token);
}

// Une reconnexion donne un nouveau socket.id au joueur : TOUTES les
// structures indexées par cet id doivent suivre, sinon le joueur revient
// amnésique. Concrètement, sans ça : son annonce disparaissait (`room.bids`
// gardait l'ancienne clé, donc affichage "?" puis score NaN en fin de manche
// parce que `computeRoundScore` recevait un bid undefined), et les cartes
// qu'il avait déjà posées dans le pli en cours perdaient leur propriétaire —
// au point que le gagnant du pli devenait introuvable dans `room.players` et
// que l'ordre du tour partait en vrille.
function rekeyPlayerId(room, oldId, newId) {
  if (oldId === newId) return;
  if (room.bids && Object.prototype.hasOwnProperty.call(room.bids, oldId)) {
    room.bids[newId] = room.bids[oldId];
    delete room.bids[oldId];
  }
  if (Array.isArray(room.currentTrick)) {
    room.currentTrick.forEach((t) => {
      if (t.playerId === oldId) t.playerId = newId;
    });
  }
  if (room.lastRoundSummary) {
    room.lastRoundSummary.results.forEach((r) => {
      if (r.id === oldId) r.id = newId;
    });
  }
  if (Array.isArray(room.finalRanking)) {
    room.finalRanking.forEach((r) => {
      if (r.id === oldId) r.id = newId;
    });
  }
  rekeyHostId(room, oldId, newId);
}

function rekeyHostId(room, oldId, newId) {
  if (room.hostId === oldId) room.hostId = newId;
}

function sendError(socket, message) {
  socket.emit('ascenseur-error', message);
}

function broadcastToRoom(io, room, event, data) {
  for (const p of room.players) io.to(p.id).emit(event, data);
}

function broadcastLobby(io, room) {
  for (const p of room.players) {
    io.to(p.id).emit('ascenseur-lobby-update', {
      code: room.code,
      players: room.players.map((pp) => ({ id: pp.id, nickname: pp.nickname })),
      hostId: room.hostId,
      isHost: p.id === room.hostId,
      canStart: room.players.length >= MIN_PLAYERS && room.players.length <= MAX_PLAYERS,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    });
  }
}

function bidderAt(room, offset) {
  const n = room.players.length;
  return room.players[(room.dealerIndex + 1 + offset) % n];
}

function playerAtTurn(room) {
  const n = room.players.length;
  return room.players[(room.leaderIndex + room.turnCount) % n];
}

// Qui remporterait le pli si on s'arrêtait maintenant. Marche aussi bien sur
// un pli complet que partiel, resolveTrick n'ayant besoin que des cartes
// déjà posées.
function currentTrickLeaderId(room) {
  if (!room.currentTrick || room.currentTrick.length === 0) return null;
  const cards = room.currentTrick.map((t) => t.card);
  return room.currentTrick[resolveTrick(cards, room.leadSuit, room.trumpSuit)].playerId;
}

function isLastBidder(room) {
  return room.bidTurnCount === room.players.length - 1;
}

function sumBids(room) {
  return Object.values(room.bids).reduce((sum, b) => sum + b, 0);
}

function startRound(io, room) {
  const cardsInRound = room.roundSequence[room.roundIndex];
  const { hands, trumpCard, trumpSuit } = dealRound(room.players.length, cardsInRound);
  room.players.forEach((p, i) => {
    p.hand = hands[i];
    p.tricksWon = 0;
  });
  room.cardsInRound = cardsInRound;
  room.trumpCard = trumpCard;
  room.trumpSuit = trumpSuit;
  room.bids = {};
  room.bidTurnCount = 0;
  room.leaderIndex = (room.dealerIndex + 1) % room.players.length;
  room.turnCount = 0;
  room.currentTrick = [];
  room.leadSuit = null;
  room.trickNumber = 1;
  room.trickPaused = false;
  room.phase = 'bidding';
  broadcastState(io, room);
}

function roundNumber(room) {
  return room.roundIndex + 1;
}

// Volontairement réduit au total courant (+ le dernier delta, pour animer le
// tableau) : envoyer tout l'historique manche par manche ferait grossir le
// tableau de score sans fin (jusqu'à 25 lignes à 4 joueurs), alors qu'il doit
// rester un encart discret. Le détail d'une manche passe par le pop-up de
// fin de manche, pas par le tableau permanent.
function scoreboard(room) {
  return room.players.map((p) => ({
    id: p.id,
    nickname: p.nickname,
    total: p.totalScore,
    lastDelta: p.roundHistory.length ? p.roundHistory[p.roundHistory.length - 1].delta : null,
  }));
}

// Manche à l'aveugle : dès qu'on ne joue qu'une seule carte, chacun voit la
// main de tous les autres mais pas la sienne (on joue "sur le front", comme
// au poker indien). C'est ce qui rend l'annonce intéressante alors qu'il n'y
// a rien à décider. Concerne donc la première manche et la dernière, la
// séquence montant de 1 puis redescendant jusqu'à 1.
function isBlindRound(room) {
  return room.cardsInRound === 1;
}

function stateFor(room, p) {
  const blind = isBlindRound(room);
  const inRound = room.phase === 'bidding' || room.phase === 'playing';
  const base = {
    phase: room.phase,
    myId: p.id,
    blindRound: blind,
    players: room.players.map((pp) => ({
      id: pp.id,
      nickname: pp.nickname,
      connected: pp.connected !== false,
      handCount: pp.hand ? pp.hand.length : 0,
      tricksWon: pp.tricksWon || 0,
      bid: room.bids ? room.bids[pp.id] : undefined,
      // Main visible des AUTRES joueurs pendant une manche à l'aveugle. La
      // sienne n'est jamais envoyée ici : c'est justement la seule qu'on ne
      // doit pas pouvoir lire, y compris en inspectant les données reçues.
      visibleHand: blind && inRound && pp.id !== p.id ? pp.hand : null,
    })),
    dealerId: room.players[room.dealerIndex] && room.players[room.dealerIndex].id,
    // Renvoyé à chaque état (et pas seulement dans le lobby) pour que l'hôte
    // retrouve ses boutons après une reconnexion en pleine partie.
    isHost: p.id === room.hostId,
    roundNumber: roundNumber(room),
    totalRounds: room.roundSequence.length,
    cardsInRound: room.cardsInRound,
    trumpCard: room.trumpCard,
    trumpSuit: room.trumpSuit,
    scoreboard: scoreboard(room),
  };

  if (inRound) {
    // À l'aveugle on n'envoie que les identifiants : impossible de deviner sa
    // propre carte, même en lisant les messages reçus. Le client affiche des
    // dos de cartes qui restent cliquables pour pouvoir les jouer.
    base.hand = blind ? p.hand.map((c) => ({ id: c.id, hidden: true })) : p.hand;
    base.bidTurnPlayerId = room.phase === 'bidding' ? bidderAt(room, room.bidTurnCount).id : null;
    base.isMyBidTurn = room.phase === 'bidding' && bidderAt(room, room.bidTurnCount).id === p.id;
    base.bids = room.bids;
  }
  if (room.phase === 'playing') {
    base.currentTrick = room.currentTrick;
    base.leadSuit = room.leadSuit;
    base.turnPlayerId = playerAtTurn(room).id;
    // Pendant la pause de fin de pli, plus personne n'a la main : sans ça le
    // joueur suivant verrait "à toi de jouer" par-dessus le pli en cours de
    // révélation.
    base.isMyTurn = !room.trickPaused && playerAtTurn(room).id === p.id;
    base.trickNumber = room.trickNumber;
    // Qui mène le pli en l'état actuel (même incomplet) : sert à entourer sa
    // carte en vert côté client.
    base.leadingPlayerId = currentTrickLeaderId(room);
    base.trickPaused = Boolean(room.trickPaused);
  }
  if (room.phase === 'round-end') {
    base.roundSummary = room.lastRoundSummary;
    base.roundEndMs = ROUND_END_MS;
  }
  if (room.phase === 'game-end') {
    base.finalRanking = room.finalRanking;
  }
  return base;
}

function broadcastState(io, room) {
  for (const p of room.players) {
    io.to(p.id).emit('ascenseur-state', stateFor(room, p));
  }
  scheduleInactivityCheck(io, room);
}

// Qui doit agir maintenant, si quelqu'un doit agir (null pendant la pause de
// révélation d'un pli, la fin de manche, ou hors partie).
function currentTurnPlayerId(room) {
  if (room.phase === 'bidding') return bidderAt(room, room.bidTurnCount).id;
  if (room.phase === 'playing' && !room.trickPaused) return playerAtTurn(room).id;
  return null;
}

// Reprogrammé à chaque état diffusé (via broadcastState) : n'importe quelle
// action remet le compteur à zéro pour le joueur concerné, et un changement
// de tour retarget automatiquement le bon joueur. Purement informatif — pas
// d'auto-saut ni d'exclusion, voir le commentaire sur INACTIVITY_WARN_MS.
function scheduleInactivityCheck(io, room) {
  clearTimeout(room.inactivityTimer);
  room.inactivityTimer = null;
  const playerId = currentTurnPlayerId(room);
  if (!playerId) return;
  room.inactivityTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    if (currentTurnPlayerId(room) !== playerId) return;
    const player = findPlayer(room, playerId);
    if (!player || player.connected === false) return; // déjà couvert par la bannière de déconnexion
    broadcastToRoom(io, room, 'ascenseur-inactivity-notice', { id: playerId, nickname: player.nickname });
  }, INACTIVITY_WARN_MS);
}

function endRound(io, room) {
  const num = roundNumber(room);
  const summary = room.players.map((p) => {
    const bid = room.bids[p.id];
    const made = p.tricksWon;
    const delta = computeRoundScore(bid, made, num);
    p.totalScore += delta;
    p.roundHistory.push({ round: num, cardsInRound: room.cardsInRound, bid, made, delta, total: p.totalScore });
    return { id: p.id, nickname: p.nickname, bid, made, delta, total: p.totalScore };
  });

  room.roundIndex += 1;
  if (room.roundIndex >= room.roundSequence.length) {
    finishGame(io, room);
    return;
  }

  room.lastRoundSummary = { round: num, cardsInRound: room.cardsInRound, results: summary };
  room.phase = 'round-end';
  broadcastState(io, room);

  // La manche suivante s'enchaîne toute seule : le pop-up de scores reste
  // affiché le temps que tout le monde le lise, sans que l'hôte ait à
  // cliquer (et sans bloquer la partie s'il a le nez ailleurs).
  room.roundEndTimer = setTimeout(() => {
    if (rooms.get(room.code) === room && room.phase === 'round-end') advanceRound(io, room);
  }, ROUND_END_MS);
}

// Fin de la pause de révélation : le gagnant ramasse et ouvre le pli suivant
// (ou la manche se termine si c'était le dernier).
function collectTrick(io, room, winnerId) {
  room.currentTrick = [];
  room.leadSuit = null;
  room.trickPaused = false;
  room.leaderIndex = room.players.findIndex((p) => p.id === winnerId);
  room.turnCount = 0;
  room.trickNumber += 1;

  if (room.trickNumber > room.cardsInRound) {
    endRound(io, room);
    return;
  }
  broadcastState(io, room);
}

function advanceRound(io, room) {
  clearRoomTimers(room);
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  startRound(io, room);
}

function clearRoomTimers(room) {
  clearTimeout(room.roundEndTimer);
  clearTimeout(room.trickTimer);
  clearTimeout(room.inactivityTimer);
  room.roundEndTimer = null;
  room.trickTimer = null;
  room.inactivityTimer = null;
}

function finishGame(io, room) {
  clearRoomTimers(room);
  const ranking = [...room.players]
    .map((p) => ({ id: p.id, nickname: p.nickname, total: p.totalScore }))
    .sort((a, b) => b.total - a.total);
  room.finalRanking = ranking;
  room.phase = 'game-end';
  broadcastState(io, room);
}

function startGame(io, room) {
  room.roundSequence = buildRoundSequence(room.players.length);
  room.roundIndex = 0;
  room.dealerIndex = 0;
  room.players.forEach((p) => {
    p.totalScore = 0;
    p.roundHistory = [];
  });
  startRound(io, room);
}

// Départ définitif pendant le lobby : retrait simple, la partie n'a pas
// encore commencé donc rien d'autre à défaire.
function removeFromLobby(io, room, id) {
  const idx = room.players.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const [removed] = room.players.splice(idx, 1);
  if (room.players.length === 0) {
    clearRoomTimers(room);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === id) {
    room.hostId = room.players[Math.floor(Math.random() * room.players.length)].id;
  }
  broadcastToRoom(io, room, 'ascenseur-player-left', { nickname: removed.nickname });
  broadcastLobby(io, room);
}

// Départ définitif en pleine partie (délai de grâce expiré, ou "Quitter"
// explicite) : contrairement au Rami à 2, on ne peut pas juste retirer le
// joueur (ça casserait l'ordre des annonces/plis et le calcul des manches
// restantes déjà engagées) — la partie s'arrête pour tout le monde, avec le
// classement actuel comme résultat final, comme un arrêt anticipé.
function finalizeAscenseurDisconnect(io, room, id, reason) {
  const player = findPlayer(room, id);
  if (!player) return;

  if (room.phase === 'lobby') {
    removeFromLobby(io, room, id);
    return;
  }

  broadcastToRoom(io, room, 'ascenseur-player-left', { nickname: player.nickname, reason: reason || 'left' });
  finishGame(io, room);
}

function handleExplicitLeave(io, socket) {
  const code = socket.data.ascenseurRoom;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.ascenseurRoom = null;
  if (!room) return;
  finalizeAscenseurDisconnect(io, room, socket.id, 'left');
}

function handleDisconnecting(io, socket) {
  const code = socket.data.ascenseurRoom;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.ascenseurRoom = null;
  if (!room) return;

  const player = findPlayer(room, socket.id);
  if (!player) return;

  player.connected = false;
  broadcastToRoom(io, room, 'ascenseur-player-disconnected', {
    id: player.id,
    nickname: player.nickname,
  });

  // En salon d'attente, un délai de grâce reste nécessaire : sans lui, mettre
  // son téléphone en veille une seconde pour coller le lien d'invitation
  // détruit instantanément le salon qu'on vient de créer (l'hôte revient,
  // "cette partie n'existe pas"). En pleine partie en revanche : pause
  // indéfinie, pas de délai qui met fin à la partie tout seul — le joueur
  // peut revenir à tout moment, sinon seul l'hôte choisit d'arrêter
  // (ascenseur-end-game, déjà existant) — décision réconciliée Manche 2.
  if (room.phase === 'lobby') {
    player.disconnectTimer = setTimeout(() => {
      if (rooms.get(code) === room) finalizeAscenseurDisconnect(io, room, player.id, 'timeout');
    }, DISCONNECT_GRACE_MS);
  }
}

function registerAscenseurHandlers(io, socket) {
  socket.on('ascenseur-create-room', (payload) => {
    const nickname = sanitizeNickname(payload && payload.nickname);
    if (!nickname) {
      sendError(socket, 'Choisis un pseudo avant de créer une partie.');
      return;
    }
    const code = makeRoomCode();
    const room = {
      code,
      phase: 'lobby',
      hostId: socket.id,
      players: [
        {
          id: socket.id,
          nickname,
          token: payload && payload.token,
          connected: true,
          disconnectTimer: null,
          hand: [],
          tricksWon: 0,
          totalScore: 0,
          roundHistory: [],
        },
      ],
    };
    rooms.set(code, room);
    socket.data.ascenseurRoom = code;
    socket.emit('ascenseur-room-created', { code });
    broadcastLobby(io, room);
  });

  socket.on('ascenseur-join-room', (payload) => {
    const code = ((payload && payload.code) || '').toUpperCase();
    const nickname = sanitizeNickname(payload && payload.nickname);
    const room = rooms.get(code);
    if (!room) {
      sendError(socket, "Cette partie n'existe pas (ou plus).");
      return;
    }
    if (room.phase !== 'lobby') {
      sendError(socket, 'Cette partie a déjà commencé.');
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      sendError(socket, `Cette partie est complète (${MAX_PLAYERS} joueurs max).`);
      return;
    }
    if (!nickname) {
      sendError(socket, 'Choisis un pseudo avant de rejoindre.');
      return;
    }
    room.players.push({
      id: socket.id,
      nickname,
      token: payload && payload.token,
      connected: true,
      disconnectTimer: null,
      hand: [],
      tricksWon: 0,
      totalScore: 0,
      roundHistory: [],
    });
    socket.data.ascenseurRoom = code;
    broadcastLobby(io, room);
  });

  socket.on('ascenseur-start-game', () => {
    const room = rooms.get(socket.data.ascenseurRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) return;
    recordGameStarted('ascenseur');
    startGame(io, room);
  });

  socket.on('ascenseur-rematch', () => {
    const room = rooms.get(socket.data.ascenseurRoom);
    if (!room || room.phase !== 'game-end') return;
    room.phase = 'lobby';
    room.players.forEach((p) => {
      p.hand = [];
      p.tricksWon = 0;
      p.totalScore = 0;
      p.roundHistory = [];
    });
    broadcastLobby(io, room);
  });

  socket.on('ascenseur-bid', (payload) => {
    const room = rooms.get(socket.data.ascenseurRoom);
    if (!room || room.phase !== 'bidding') return;
    const expected = bidderAt(room, room.bidTurnCount);
    if (expected.id !== socket.id) {
      sendError(socket, "Ce n'est pas ton tour d'annoncer.");
      return;
    }
    const bid = Number(payload && payload.bid);
    if (!isValidBid(bid, room.cardsInRound, sumBids(room), isLastBidder(room))) {
      sendError(
        socket,
        isLastBidder(room)
          ? "Cette annonce ferait que le total égale le nombre de plis en jeu, c'est interdit."
          : 'Annonce invalide.'
      );
      return;
    }
    room.bids[socket.id] = bid;
    room.bidTurnCount += 1;
    if (room.bidTurnCount >= room.players.length) {
      room.phase = 'playing';
    }
    broadcastState(io, room);
  });

  socket.on('ascenseur-play-card', (payload) => {
    const room = rooms.get(socket.data.ascenseurRoom);
    if (!room || room.phase !== 'playing') return;
    if (room.trickPaused) return; // pli en cours de révélation, personne ne joue
    const player = playerAtTurn(room);
    if (player.id !== socket.id) {
      sendError(socket, "Ce n'est pas ton tour de jouer.");
      return;
    }
    const cardId = payload && payload.cardId;
    const card = player.hand.find((c) => c.id === cardId);
    if (!card) {
      sendError(socket, 'Carte introuvable dans ta main.');
      return;
    }
    if (room.leadSuit) {
      const hasLedSuit = player.hand.some((c) => c.suit === room.leadSuit);
      if (hasLedSuit && card.suit !== room.leadSuit) {
        sendError(socket, `Tu dois fournir la couleur demandée (${room.leadSuit}) si tu en as.`);
        return;
      }
    }

    player.hand = player.hand.filter((c) => c.id !== cardId);
    room.currentTrick.push({ playerId: player.id, card });
    if (!room.leadSuit) room.leadSuit = card.suit;
    room.turnCount += 1;

    // Pli complet : on le laisse affiché un instant (gagnant en surbrillance)
    // avant de le ramasser, sinon la dernière carte posée n'apparaît jamais.
    if (room.currentTrick.length === room.players.length) {
      const winnerId = currentTrickLeaderId(room);
      findPlayer(room, winnerId).tricksWon += 1;
      room.trickPaused = true;
      broadcastState(io, room);
      room.trickTimer = setTimeout(() => {
        if (rooms.get(room.code) === room) collectTrick(io, room, winnerId);
      }, TRICK_REVEAL_MS);
      return;
    }
    broadcastState(io, room);
  });

  socket.on('ascenseur-next-round', () => {
    const room = rooms.get(socket.data.ascenseurRoom);
    if (!room || room.phase !== 'round-end') return;
    if (socket.id !== room.hostId) return;
    advanceRound(io, room);
  });

  // Arrêt anticipé : possible à tout moment de la partie, pas seulement
  // pendant la courte fenêtre de fin de manche (la montée-descente complète
  // est longue et on ne la joue pas toujours jusqu'au bout).
  socket.on('ascenseur-end-game', () => {
    const room = rooms.get(socket.data.ascenseurRoom);
    if (!room) return;
    if (!['bidding', 'playing', 'round-end'].includes(room.phase)) return;
    if (socket.id !== room.hostId) return;
    finishGame(io, room);
  });

  socket.on('ascenseur-rejoin-room', (payload) => {
    const code = ((payload && payload.code) || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('ascenseur-rejoin-failed', { reason: likelyServerRestart() ? 'server-restarted' : 'not-found' });
      return;
    }
    const player = findPlayerByToken(room, payload && payload.token);
    if (!player) {
      socket.emit('ascenseur-rejoin-failed', { reason: 'not-found' });
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
    socket.data.ascenseurRoom = code;

    if (room.phase === 'lobby') {
      broadcastLobby(io, room);
      return;
    }

    socket.emit('ascenseur-rejoin-ok', stateFor(room, player));
    if (wasDisconnected) {
      broadcastToRoom(io, room, 'ascenseur-player-reconnected', { id: player.id, nickname: player.nickname });
    }
  });

  socket.on('ascenseur-leave-room', () => handleExplicitLeave(io, socket));
  socket.on('disconnecting', () => handleDisconnecting(io, socket));
}

module.exports = { registerAscenseurHandlers, MIN_PLAYERS, MAX_PLAYERS, getStats };
