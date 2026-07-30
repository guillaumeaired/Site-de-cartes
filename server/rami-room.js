// Salons de Rami Français en Socket.io. Même schéma que les salons de
// Bataille dans index.js (rooms Map, lobby, hôte, déconnexion) mais avec
// l'état spécifique au Rami (pioche, défausse en ligne, tapis, tour par
// tour, score qui monte à chaque pose). Une partie = une seule manche.

const {
  dealHands,
  shuffle,
  resolveSequence,
  classifyMeld,
  cardFaceValue,
  meldPoints,
  handCardValue,
  canInitialMeld,
} = require('./rami');

const MAX_PLAYERS = 2; // v1 : 2 joueurs seulement, généralisé plus tard

// Une deconnexion en pleine partie ne met plus fin au match tout de suite :
// ce delai laisse une chance de revenir (lien, code, retour en arriere)
// avant que la partie ne soit vraiment consideree terminee.
const DISCONNECT_GRACE_MS = 45_000;

const rooms = new Map();
let meldCounter = 0;

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeNickname(nickname) {
  if (typeof nickname !== 'string') return null;
  const trimmed = nickname.trim().slice(0, 16);
  return trimmed || null;
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

// Le jeton survit a une reconnexion (contrairement a socket.id) : c'est lui
// qui permet de retrouver "le meme joueur" apres une coupure.
function findPlayerByToken(room, token) {
  if (!token) return null;
  return room.players.find((p) => p.token === token);
}

// turnIndex est un index numerique dans le tableau players, jamais affecte
// par un changement d'id - mais hostId, le proprietaire de chaque melde posee
// sur le tapis, et l'issue de la derniere partie le sont tous : sans ce
// rekey, une melde posee avant une coupure se retrouve affichee comme celle
// de l'adversaire une fois reconnecte (le socket.id change a chaque reconnexion).
function rekeyPlayerId(room, oldId, newId) {
  if (room.hostId === oldId) room.hostId = newId;
  for (const meld of room.table) {
    if (meld.ownerId === oldId) meld.ownerId = newId;
  }
  if (room.lastGameEndPayload) {
    const payload = room.lastGameEndPayload;
    if (payload.winnerId === oldId) payload.winnerId = newId;
    if (payload.gameWinnerId === oldId) payload.gameWinnerId = newId;
  }
}

function activePlayer(room) {
  return room.players[room.turnIndex];
}

function sendError(socket, message) {
  socket.emit('rami-error', message);
}

// Vérifie que c'est bien le tour de ce joueur et qu'il est dans la bonne
// phase pour cette action ; envoie un message explicite sinon (au lieu de
// laisser un clic hors-tour ne rien faire silencieusement côté client).
function guardTurn(socket, room, expectedPhase) {
  if (activePlayer(room).id !== socket.id) {
    sendError(socket, "Ce n'est pas ton tour.");
    return false;
  }
  if (expectedPhase && room.turnPhase !== expectedPhase) {
    sendError(
      socket,
      expectedPhase === 'PIOCHE' ? 'Tu as déjà pioché ce tour-ci.' : "Pioche d'abord avant de jouer."
    );
    return false;
  }
  return true;
}

function broadcastToRoom(io, room, event, data) {
  for (const p of room.players) io.to(p.id).emit(event, data);
}

// Regle stricte : tant que la carte precisement ciblee en defausse n'a pas
// ete jouee dans une combinaison, le joueur ne peut RIEN faire d'autre avec
// sa main (ni poser une autre combinaison, ni defausser une carte - meme la
// carte visee elle-meme) - seule issue si elle ne peut vraiment pas servir :
// tout reprendre via rami-undo-draw. Les autres cartes recuperees avec elle
// restent donc elles aussi bloquees, ce qui garantit que rami-undo-draw
// (qui exige que TOUTES les cartes prises soient encore en main) reste
// toujours disponible tant que rien n'a ete joue.
function hasUnresolvedDiscardCard(room, player) {
  return room.drawnFromDiscard && player.hand.some((c) => c.id === room.drawnCardId);
}

function sendMustResolveError(socket) {
  sendError(
    socket,
    "Tu dois d'abord poser la carte prise à la défausse dans une combinaison, ou reprendre ta pioche."
  );
}

function broadcastLobby(io, room) {
  for (const p of room.players) {
    io.to(p.id).emit('rami-lobby-update', {
      code: room.code,
      players: room.players.map((pp) => ({ id: pp.id, nickname: pp.nickname })),
      hostId: room.hostId,
      isHost: p.id === room.hostId,
      canStart: room.players.length === MAX_PLAYERS,
    });
  }
}

// Construit une combinaison à partir de cartes prises en main : détermine le
// type (brelan/séquence), ordonne les cartes et note ce que représente un
// Joker éventuel (utile pour valider un échange de Joker plus tard).
function buildMeld(cards, ownerId) {
  const type = classifyMeld(cards);
  if (!type) return null;

  let ordered = cards;
  if (type === 'sequence') {
    const slots = resolveSequence(cards);
    const suit = cards.find((c) => !c.isJoker).suit;
    ordered = slots.map((s) =>
      s.isJokerSlot ? { ...s.card, isJoker: true, jokerFor: { rank: s.rank, suit } } : s.card
    );
  } else {
    const rank = cards.find((c) => !c.isJoker).rank;
    ordered = cards.map((c) => (c.isJoker ? { ...c, jokerFor: { rank } } : c));
  }
  return { id: `m${meldCounter++}`, type, cards: ordered, ownerId };
}

function resolveCardsFromHand(player, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (new Set(ids).size !== ids.length) return null;
  const found = ids.map((id) => player.hand.find((c) => c.id === id));
  if (found.some((c) => !c)) return null;
  return found;
}

function removeCardsFromHand(player, cards) {
  const ids = new Set(cards.map((c) => c.id));
  player.hand = player.hand.filter((c) => !ids.has(c.id));
}

function startGame(io, room) {
  const { hands, drawPile } = dealHands(room.players.length);
  room.players.forEach((p, i) => {
    p.hand = hands[i];
    p.hasOpened = false;
    p.score = 0;
  });
  room.drawPile = drawPile;
  room.discardPile = [];
  room.table = [];
  room.turnIndex = 0;
  room.turnPhase = 'PIOCHE';
  room.drawnCardId = null;
  room.drawnFromDiscard = false;
  room.drawnCardIds = null;
  room.phase = 'playing';

  for (const p of room.players) {
    io.to(p.id).emit('rami-game-start', {
      myId: p.id,
      hand: p.hand,
      players: room.players.map((pp) => ({ id: pp.id, nickname: pp.nickname, count: pp.hand.length, score: pp.score })),
      drawPileCount: room.drawPile.length,
      turnPlayerId: activePlayer(room).id,
    });
  }
}

// Etat complet du point de vue d'un joueur donne : utilise pour la diffusion
// normale a chaque changement, et reutilise tel quel pour resynchroniser un
// joueur qui se reconnecte en pleine partie.
function stateFor(room, p) {
  return {
    hand: p.hand,
    players: room.players.map((pp) => ({
      id: pp.id,
      nickname: pp.nickname,
      count: pp.hand.length,
      score: pp.score,
      connected: pp.connected !== false,
    })),
    table: room.table,
    discardPile: room.discardPile,
    drawPileCount: room.drawPile.length,
    turnPlayerId: activePlayer(room).id,
    turnPhase: room.turnPhase,
    hasOpened: p.hasOpened,
    isMyTurn: activePlayer(room).id === p.id,
    drawnCardId: room.drawnCardId,
    drawnFromDiscard: room.drawnFromDiscard,
    canUndoDraw:
      room.drawnFromDiscard &&
      Array.isArray(room.drawnCardIds) &&
      activePlayer(room).id === p.id &&
      room.drawnCardIds.every((id) => p.hand.some((c) => c.id === id)),
  };
}

function broadcastState(io, room) {
  for (const p of room.players) {
    io.to(p.id).emit('rami-state', stateFor(room, p));
  }
}

// La partie s'arrête dès qu'un joueur n'a plus de cartes : score final de
// chacun = points de combinaisons accumulés en jouant, moins la valeur des
// cartes qui lui restent en main. Le score le plus haut gagne.
function endGame(io, room, winnerId) {
  const summary = room.players.map((p) => {
    const handPenalty = p.hand.reduce((sum, c) => sum + handCardValue(c), 0);
    return { id: p.id, nickname: p.nickname, meldScore: p.score, handPenalty, total: p.score - handPenalty };
  });
  room.phase = 'game-end';

  const gameWinnerId = summary.reduce((a, b) => (b.total > a.total ? b : a)).id;
  room.lastGameEndPayload = { winnerId, summary, gameWinnerId };
  broadcastToRoom(io, room, 'rami-game-end', room.lastGameEndPayload);
}

// Depart definitif (quitte explicitement, ou delai de grace expire sans
// retour) : v1 = 2 joueurs seulement, donc le depart de l'un met fin a la
// partie pour l'autre (pas de "la partie continue sans lui" comme pour la
// Bataille, ça n'a pas de sens en tour par tour a 2).
function finalizeRamiDisconnect(io, room, id, reason) {
  const idx = room.players.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const [removed] = room.players.splice(idx, 1);

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.phase === 'lobby') {
    if (room.hostId === id) {
      room.hostId = room.players[Math.floor(Math.random() * room.players.length)].id;
    }
    broadcastToRoom(io, room, 'rami-player-left', { nickname: removed.nickname });
    broadcastLobby(io, room);
    return;
  }

  broadcastToRoom(io, room, 'rami-opponent-left', { nickname: removed.nickname, reason: reason || 'left' });
  rooms.delete(room.code);
}

// Depart volontaire (bouton "Quitter") : immediat, pas de delai de grace.
function handleExplicitLeave(io, socket) {
  const code = socket.data.ramiRoom;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.ramiRoom = null;
  if (!room) return;
  finalizeRamiDisconnect(io, room, socket.id, 'left');
}

// Coupure automatique (reseau, onglet ferme, swipe accidentel, telephone qui
// met l'onglet en veille) : on laisse toujours un delai de grace avant de
// considerer le joueur parti, quelle que soit la phase - y compris en salon
// d'attente et sur l'ecran de score. Sans ca, mettre son telephone en veille
// une seconde pour coller le lien d'invitation dans un SMS detruisait
// instantanement le salon qu'on venait de creer (bug reel constate : l'hote
// revient, son propre salon n'existe plus, "cette partie n'existe pas").
function handleDisconnecting(io, socket) {
  const code = socket.data.ramiRoom;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.ramiRoom = null;
  if (!room) return;

  const player = findPlayer(room, socket.id);
  if (!player) return;

  player.connected = false;
  broadcastToRoom(io, room, 'rami-player-disconnected', {
    id: player.id,
    nickname: player.nickname,
    graceMs: DISCONNECT_GRACE_MS,
  });
  player.disconnectTimer = setTimeout(() => {
    if (rooms.get(code) === room) finalizeRamiDisconnect(io, room, player.id, 'timeout');
  }, DISCONNECT_GRACE_MS);
}

function registerRamiHandlers(io, socket) {
  socket.on('rami-create-room', (payload) => {
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
          hand: [],
          score: 0,
          hasOpened: false,
          token: payload && payload.token,
          connected: true,
          disconnectTimer: null,
        },
      ],
      drawPile: [],
      discardPile: [],
      table: [],
      turnIndex: 0,
      turnPhase: 'PIOCHE',
      drawnCardId: null,
      drawnFromDiscard: false,
    };
    rooms.set(code, room);
    socket.data.ramiRoom = code;
    socket.emit('rami-room-created', { code });
    broadcastLobby(io, room);
  });

  socket.on('rami-join-room', (payload) => {
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
      sendError(socket, 'Cette partie est complète (2 joueurs pour le moment).');
      return;
    }
    if (!nickname) {
      sendError(socket, 'Choisis un pseudo avant de rejoindre.');
      return;
    }
    room.players.push({
      id: socket.id,
      nickname,
      hand: [],
      score: 0,
      hasOpened: false,
      token: payload && payload.token,
      connected: true,
      disconnectTimer: null,
    });
    socket.data.ramiRoom = code;
    broadcastLobby(io, room);
  });

  socket.on('rami-start-game', () => {
    const room = rooms.get(socket.data.ramiRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    if (room.players.length !== MAX_PLAYERS) return;
    startGame(io, room);
  });

  socket.on('rami-draw-stock', () => {
    const room = rooms.get(socket.data.ramiRoom);
    if (!room || room.phase !== 'playing') return;
    if (!guardTurn(socket, room, 'PIOCHE')) return;

    if (room.drawPile.length === 0) {
      if (room.discardPile.length <= 1) {
        sendError(socket, 'Plus de cartes à piocher.');
        return;
      }
      const top = room.discardPile.pop();
      room.drawPile = shuffle(room.discardPile);
      room.discardPile = [top];
    }

    const player = findPlayer(room, socket.id);
    const card = room.drawPile.shift();
    player.hand.push(card);
    room.drawnCardId = card.id;
    room.drawnFromDiscard = false;
    room.drawnCardIds = null;
    room.turnPhase = 'JEU';
    broadcastState(io, room);
  });

  // Défausse "en ligne" : on peut prendre n'importe quelle carte déjà
  // défaussée, mais on récupère aussi toutes celles posées après elle.
  socket.on('rami-draw-discard', (payload) => {
    const room = rooms.get(socket.data.ramiRoom);
    if (!room || room.phase !== 'playing') return;
    if (!guardTurn(socket, room, 'PIOCHE')) return;

    const cardId = payload && payload.cardId;
    const idx = room.discardPile.findIndex((c) => c.id === cardId);
    if (idx === -1) {
      sendError(socket, 'Carte introuvable dans la défausse.');
      return;
    }

    const player = findPlayer(room, socket.id);
    const taken = room.discardPile.splice(idx);
    player.hand.push(...taken);
    room.drawnCardId = cardId;
    room.drawnFromDiscard = true;
    room.drawnCardIds = taken.map((c) => c.id);
    room.turnPhase = 'JEU';
    broadcastState(io, room);
  });

  // Annule la prise en défausse : remet la carte ciblée ET toutes celles
  // reprises avec elle dans la défausse (ordre d'origine reconstitué), et
  // rend la main au joueur pour piocher autrement. Uniquement possible si
  // aucune de ces cartes n'a déjà servi ailleurs (combinaison posée,
  // ouverture, défausse) depuis la prise — sinon la reconstitution serait
  // fausse.
  socket.on('rami-undo-draw', () => {
    const room = rooms.get(socket.data.ramiRoom);
    if (!room || room.phase !== 'playing') return;
    if (!guardTurn(socket, room, 'JEU')) return;
    if (!room.drawnFromDiscard || !Array.isArray(room.drawnCardIds)) return;

    const player = findPlayer(room, socket.id);
    const taken = resolveCardsFromHand(player, room.drawnCardIds);
    if (!taken) {
      sendError(socket, "Impossible d'annuler : une des cartes prises a déjà été jouée.");
      return;
    }

    removeCardsFromHand(player, taken);
    room.discardPile.push(...taken);
    room.turnPhase = 'PIOCHE';
    room.drawnCardId = null;
    room.drawnFromDiscard = false;
    room.drawnCardIds = null;
    broadcastState(io, room);
  });

  socket.on('rami-open', (payload) => {
    const room = rooms.get(socket.data.ramiRoom);
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(room, socket.id);
    if (!guardTurn(socket, room, 'JEU')) return;
    if (player.hasOpened) {
      sendError(socket, 'Tu as déjà ouvert ce tour-ci.');
      return;
    }

    const groupsIds = Array.isArray(payload && payload.melds) ? payload.melds : null;
    if (!groupsIds || groupsIds.length === 0) return;

    const allIds = groupsIds.flat();
    if (new Set(allIds).size !== allIds.length) {
      sendError(socket, 'Une carte ne peut pas être utilisée deux fois.');
      return;
    }

    if (hasUnresolvedDiscardCard(room, player) && !allIds.includes(room.drawnCardId)) {
      sendMustResolveError(socket);
      return;
    }

    const groups = groupsIds.map((ids) => resolveCardsFromHand(player, ids));
    if (groups.some((g) => !g)) {
      sendError(socket, 'Cartes invalides.');
      return;
    }

    // Le tour doit toujours se terminer par une défausse (c'est elle qui
    // vide la main et déclenche la fin de partie) : impossible de poser
    // absolument toutes ses cartes d'un coup, il en faut toujours une de
    // côté à défausser ensuite.
    if (player.hand.length - allIds.length <= 0) {
      sendError(socket, 'Garde au moins une carte : ton tour doit se terminer par une défausse.');
      return;
    }

    if (!canInitialMeld(groups)) {
      sendError(socket, "Il faut au moins 30 points, sans le 2 de cœur, pour ta première pose.");
      return;
    }

    for (const group of groups) {
      const meld = buildMeld(group, player.id);
      removeCardsFromHand(player, group);
      room.table.push(meld);
      player.score += meldPoints(group, meld.type);
    }
    player.hasOpened = true;
    broadcastState(io, room);
  });

  socket.on('rami-lay-meld', (payload) => {
    const room = rooms.get(socket.data.ramiRoom);
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(room, socket.id);
    if (!guardTurn(socket, room, 'JEU')) return;
    if (!player.hasOpened) {
      sendError(socket, "Tu dois d'abord ouvrir (30 points) avant de poser une autre combinaison.");
      return;
    }

    const cards = resolveCardsFromHand(player, payload && payload.cards);
    if (!cards) {
      sendError(socket, 'Cartes invalides.');
      return;
    }
    if (hasUnresolvedDiscardCard(room, player) && !cards.some((c) => c.id === room.drawnCardId)) {
      sendMustResolveError(socket);
      return;
    }
    // Meme regle que pour rami-open : il doit toujours rester au moins une
    // carte a defausser pour terminer le tour.
    if (player.hand.length - cards.length <= 0) {
      sendError(socket, 'Garde au moins une carte : ton tour doit se terminer par une défausse.');
      return;
    }
    const meld = buildMeld(cards, player.id);
    if (!meld) {
      sendError(socket, "Ce n'est pas une combinaison valide.");
      return;
    }
    removeCardsFromHand(player, cards);
    room.table.push(meld);
    player.score += meldPoints(cards, meld.type);
    broadcastState(io, room);
  });

  socket.on('rami-lay-off', (payload) => {
    const room = rooms.get(socket.data.ramiRoom);
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(room, socket.id);
    if (!guardTurn(socket, room, 'JEU')) return;
    if (!player.hasOpened) {
      sendError(socket, "Tu dois d'abord ouvrir (30 points) avant de compléter une combinaison.");
      return;
    }

    const meld = room.table.find((m) => m.id === (payload && payload.meldId));
    if (!meld) {
      sendError(socket, 'Combinaison introuvable.');
      return;
    }
    const newCards = resolveCardsFromHand(player, payload && payload.cards);
    if (!newCards) {
      sendError(socket, 'Cartes invalides.');
      return;
    }
    if (hasUnresolvedDiscardCard(room, player) && !newCards.some((c) => c.id === room.drawnCardId)) {
      sendMustResolveError(socket);
      return;
    }
    // Meme regle que pour rami-open/rami-lay-meld : il doit toujours rester
    // au moins une carte a defausser pour terminer le tour.
    if (player.hand.length - newCards.length <= 0) {
      sendError(socket, 'Garde au moins une carte : ton tour doit se terminer par une défausse.');
      return;
    }

    const combined = [...meld.cards, ...newCards];
    const rebuilt = buildMeld(combined);
    if (!rebuilt || rebuilt.type !== meld.type) {
      sendError(socket, "Cet ajout ne forme pas une combinaison valide.");
      return;
    }

    // Seules les cartes ajoutées rapportent des points ici : celles déjà
    // sur la table ont été comptées à leur pose initiale.
    const newIds = new Set(newCards.map((c) => c.id));
    const addedValue = rebuilt.cards
      .filter((c) => newIds.has(c.id))
      .reduce((sum, c) => sum + cardFaceValue(c.isJoker ? c.jokerFor.rank : c.rank), 0);

    removeCardsFromHand(player, newCards);
    meld.cards = rebuilt.cards;
    player.score += addedValue;
    broadcastState(io, room);
  });

  socket.on('rami-swap-joker', (payload) => {
    const room = rooms.get(socket.data.ramiRoom);
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(room, socket.id);
    if (!guardTurn(socket, room, 'JEU')) return;
    if (!player.hasOpened) {
      sendError(socket, "Tu dois d'abord ouvrir (30 points) avant d'échanger un Joker.");
      return;
    }

    const meld = room.table.find((m) => m.id === (payload && payload.meldId));
    if (!meld) {
      sendError(socket, 'Combinaison introuvable.');
      return;
    }
    const jokerEntry = meld.cards.find((c) => c.id === (payload && payload.jokerCardId) && c.isJoker);
    if (!jokerEntry || !jokerEntry.jokerFor) {
      sendError(socket, 'Pas de Joker à échanger ici.');
      return;
    }
    const replacement = player.hand.find((c) => c.id === (payload && payload.replacementCardId));
    if (!replacement) {
      sendError(socket, 'Carte introuvable dans ta main.');
      return;
    }
    if (hasUnresolvedDiscardCard(room, player) && replacement.id !== room.drawnCardId) {
      sendMustResolveError(socket);
      return;
    }
    const wantsRank = jokerEntry.jokerFor.rank;
    const wantsSuit = jokerEntry.jokerFor.suit;
    const matches = replacement.rank === wantsRank && (!wantsSuit || replacement.suit === wantsSuit);
    if (!matches) {
      sendError(socket, 'Cette carte ne correspond pas au Joker.');
      return;
    }

    const afterSwap = meld.cards.map((c) => (c.id === jokerEntry.id ? replacement : c));
    if (classifyMeld(afterSwap) !== meld.type) {
      sendError(socket, 'Cette carte ne peut pas remplacer le Joker ici.');
      return;
    }

    removeCardsFromHand(player, [replacement]);
    meld.cards = afterSwap;
    player.hand.push({ id: jokerEntry.id, rank: '2', suit: 'coeur', isJoker: true });
    broadcastState(io, room);
  });

  socket.on('rami-discard', (payload) => {
    const room = rooms.get(socket.data.ramiRoom);
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(room, socket.id);
    if (!guardTurn(socket, room, 'JEU')) return;

    const cardId = payload && payload.cardId;

    // La carte visée en défausse doit être posée dans une combinaison ce
    // tour-ci — impossible de la redéfausser directement pour "s'en sortir"
    // (règle stricte : si elle ne peut vraiment rien donner, il faut tout
    // reprendre via rami-undo-draw, pas juste la relâcher toute seule).
    if (hasUnresolvedDiscardCard(room, player)) {
      sendMustResolveError(socket);
      return;
    }

    const card = player.hand.find((c) => c.id === cardId);
    if (!card) {
      sendError(socket, 'Carte introuvable dans ta main.');
      return;
    }

    removeCardsFromHand(player, [card]);
    room.discardPile.push(card);

    if (player.hand.length === 0) {
      endGame(io, room, player.id);
      return;
    }

    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    room.turnPhase = 'PIOCHE';
    room.drawnCardId = null;
    room.drawnFromDiscard = false;
    room.drawnCardIds = null;
    broadcastState(io, room);
  });

  socket.on('rami-rematch', () => {
    const room = rooms.get(socket.data.ramiRoom);
    if (!room || room.phase !== 'game-end') return;
    room.phase = 'lobby';
    room.lastGameEndPayload = null;
    for (const p of room.players) {
      p.score = 0;
      p.hasOpened = false;
      p.hand = [];
    }
    broadcastLobby(io, room);
  });

  // Reconnexion : le client redonne le code de la partie + son jeton
  // persistant (localStorage), qu'il ait clique le lien, retape le code, ou
  // que son socket se soit juste reconnecte tout seul apres une coupure.
  socket.on('rami-rejoin-room', (payload) => {
    const code = ((payload && payload.code) || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('rami-rejoin-failed');
      return;
    }
    const player = findPlayerByToken(room, payload && payload.token);
    if (!player) {
      socket.emit('rami-rejoin-failed');
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
    socket.data.ramiRoom = code;

    if (room.phase === 'lobby') {
      broadcastLobby(io, room);
      return;
    }

    if (room.phase === 'game-end') {
      socket.emit('rami-game-end', { ...room.lastGameEndPayload, myId: player.id });
      return;
    }

    socket.emit('rami-rejoin-ok', { myId: player.id, ...stateFor(room, player) });
    if (wasDisconnected) {
      broadcastToRoom(io, room, 'rami-player-reconnected', { id: player.id, nickname: player.nickname });
    }
  });

  socket.on('rami-leave-room', () => handleExplicitLeave(io, socket));
  socket.on('disconnecting', () => handleDisconnecting(io, socket));
}

module.exports = { registerRamiHandlers };
