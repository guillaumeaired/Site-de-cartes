// Salons de Skull King en Socket.io. Même schéma que les salons de
// l'Ascenseur (rooms Map, lobby, hôte, jeton/déconnexion avec délai de
// grâce, pause de révélation de pli, enchaînement auto des manches) mais
// avec des différences de fond : les annonces sont simultanées et cachées
// jusqu'à ce que tout le monde ait choisi, une obligation de suivre la
// couleur imposée par la 1ère numérotée jouée (les cartes spéciales restent
// toujours jouables), et les cartes spéciales (Butin/Kraken/Baleine/pirates
// nommés) ont des effets propres résolus ici.

const {
  MIN_PLAYERS,
  MAX_PLAYERS,
  PIRATE_POWER_BY_NAME,
  maxPlayersFor,
  buildRoundSequence,
  dealRound,
  isValidBid,
  isCardPlayable,
  ledSuitOf,
  effectiveKind,
  resolveTrick,
  trickBonusForWinner,
  computeRoundScoreBreakdown,
} = require('./skullking');
const { likelyServerRestart } = require('./server-start');
const { recordGameStarted } = require('./play-counts');

// Salon d'attente uniquement (voir handleDisconnecting) : délai de grâce
// avant de considérer le joueur vraiment parti.
const DISCONNECT_GRACE_MS = 45_000;
const TRICK_REVEAL_MS = 2_600;
const POWER_REVEAL_MS = 3_500; // temps laissé à Juanita pour lire les cartes non distribuées
const ROUND_END_MS = 7_000;

// Déconnexion en pleine partie : pause indéfinie, plus de délai de grâce fixe
// qui met fin à la partie tout seul (décision réconciliée Backend/Game
// Design/UI-UX, Manche 2 — voir ascenseur-room.js pour le contexte détaillé).
// Seul l'hôte peut choisir d'arrêter la partie plus tôt (skullking-end-game,
// déjà existant).

// Garde-fou anti-inactivité (Manche 2) : un joueur toujours connecté mais qui
// met trop de temps à agir sur son tour (phase 'playing' uniquement — les
// annonces de la phase 'bidding' sont simultanées, pas de "tour" à surveiller
// là) reçoit un simple signal visible de tous, sans saut de tour ni
// exclusion automatique.
const INACTIVITY_WARN_MS = 120_000;

// Pirates ciblables par "Marcher sur la Planche" dans un pli en cours :
// identité choisie (effectiveKind, gère la Tigresse-Pirate), pas le type
// brut de la carte - sinon une Tigresse jouée comme Pirate n'est jamais
// proposée au ciblage (bug corrigé, cf. audit Game Designer 2026-08-12).
function eligiblePlankTargets(trick) {
  return trick.filter((t) => effectiveKind(t.card) === 'pirate');
}

// Version du pli envoyée au client : ajoute un booléen neutre par carte
// (ciblable par la Planche ou non) calculé côté serveur via effectiveKind,
// pour que le client n'ait jamais besoin de recalculer lui-même le "kind
// effectif" d'une Tigresse (et reste correct même si chosenAs venait à être
// masqué aux autres joueurs côté serveur).
function trickForClient(trick) {
  const eligibleIds = new Set(eligiblePlankTargets(trick).map((t) => t.card.id));
  return trick.map((t) => ({
    playerId: t.playerId,
    card: t.card,
    plankEligible: eligibleIds.has(t.card.id),
  }));
}

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

function sanitizeNickname(nickname) {
  if (typeof nickname !== 'string') return null;
  const trimmed = nickname.trim().slice(0, 16);
  return trimmed || null;
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function findPlayerByToken(room, token) {
  if (!token) return null;
  return room.players.find((p) => p.token === token);
}

// Voir ascenseur-room.js pour le contexte détaillé de ce piège récurrent :
// toute structure indexée par socket.id doit être ré-indexée à la
// reconnexion, sous peine d'annonce perdue / score NaN / pli orphelin.
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
  if (room.pendingPower && room.pendingPower.playerId === oldId) {
    room.pendingPower.playerId = newId;
  }
  if (room.pendingPower && room.pendingPower.leaderId === oldId) {
    room.pendingPower.leaderId = newId;
  }
  if (Array.isArray(room.lootAlliances)) {
    room.lootAlliances.forEach((a) => {
      if (a.lootPlayerId === oldId) a.lootPlayerId = newId;
      if (a.winnerId === oldId) a.winnerId = newId;
    });
  }
  if (room.lastRoundSummary) {
    room.lastRoundSummary.results.forEach((r) => {
      if (r.id === oldId) r.id = newId;
    });
    if (Array.isArray(room.lastRoundSummary.lootLinks)) {
      room.lastRoundSummary.lootLinks.forEach((link) => {
        if (link.a === oldId) link.a = newId;
        if (link.b === oldId) link.b = newId;
      });
    }
  }
  if (Array.isArray(room.finalRanking)) {
    room.finalRanking.forEach((r) => {
      if (r.id === oldId) r.id = newId;
    });
  }
  // Extension : cible du pouvoir de Mary Thorne (carte forcée au pli
  // suivant), joueur qui passe son tour après une Dernière Salve, joueur
  // qui doit encore jouer sa carte supplémentaire.
  if (room.forcedPlays && Object.prototype.hasOwnProperty.call(room.forcedPlays, oldId)) {
    room.forcedPlays[newId] = room.forcedPlays[oldId];
    delete room.forcedPlays[oldId];
  }
  if (room.sittingOutId === oldId) room.sittingOutId = newId;
  if (room.extraCardOwedBy === oldId) room.extraCardOwedBy = newId;
  rekeyHostId(room, oldId, newId);
}

function rekeyHostId(room, oldId, newId) {
  if (room.hostId === oldId) room.hostId = newId;
}

function sendError(socket, message) {
  socket.emit('skullking-error', message);
}

function broadcastToRoom(io, room, event, data) {
  for (const p of room.players) io.to(p.id).emit(event, data);
}

function broadcastLobby(io, room) {
  const maxPlayers = maxPlayersFor(room.extensionEnabled);
  for (const p of room.players) {
    io.to(p.id).emit('skullking-lobby-update', {
      code: room.code,
      players: room.players.map((pp) => ({ id: pp.id, nickname: pp.nickname })),
      hostId: room.hostId,
      isHost: p.id === room.hostId,
      canStart: room.players.length >= MIN_PLAYERS && room.players.length <= maxPlayers,
      minPlayers: MIN_PLAYERS,
      maxPlayers,
      // Le switch est cliquable seulement par l'hôte (imposé aussi côté
      // serveur dans le handler dédié) ; tous les autres le voient en
      // lecture seule via ce même champ.
      extensionEnabled: Boolean(room.extensionEnabled),
    });
  }
}

function playerAtTurn(room) {
  const order = activeOrderThisTrick(room);
  if (room.turnCount < order.length) return order[room.turnCount];
  // Carte supplémentaire de Dernière Salve : jouée après tout le monde,
  // toujours par le même joueur qui l'a posée ce pli-ci.
  return findPlayer(room, room.extraCardOwedBy);
}

// Aperçu du pli en cours (même incomplet) : qui le mènerait à l'instant, et
// s'il serait détruit (Kraken, ou Baleine sans numérotée pour départager).
function currentTrickPreview(room) {
  if (!room.currentTrick || room.currentTrick.length === 0) return { leaderId: null, destroyed: false };
  const cards = room.currentTrick.map((t) => t.card);
  const result = resolveTrick(cards);
  const entry = room.currentTrick[result.leaderIdx];
  return { leaderId: entry ? entry.playerId : null, destroyed: result.destroyed };
}

function allBidsIn(room) {
  return room.players.every((p) => Object.prototype.hasOwnProperty.call(room.bids, p.id));
}

function startRound(io, room) {
  const cardsInRound = room.roundSequence[room.roundIndex];
  const { hands, residualPile } = dealRound(room.players.length, cardsInRound, room.extensionEnabled);
  room.players.forEach((p, i) => {
    p.hand = hands[i];
    p.tricksWon = 0;
    p.pendingBonus = 0;
    p.rascalStake = 0;
  });
  room.residualPile = residualPile;
  room.lootAlliances = [];
  room.cardsInRound = cardsInRound;
  room.bids = {};
  room.leaderIndex = (room.dealerIndex + 1) % room.players.length;
  room.turnCount = 0;
  room.currentTrick = [];
  room.trickNumber = 1;
  room.trickPaused = false;
  room.pendingPower = null;
  room.pendingPowerQueue = null;
  room.lastTrickResult = null;
  room.lastWinningCard = null;
  room.forcedPlays = {};
  room.sittingOutId = null;
  room.extraCardOwedBy = null;
  room.phase = 'bidding';
  broadcastState(io, room);
}

// Ordre de jeu du pli en cours, en partant du meneur : identique à
// room.players tant que personne ne "passe son tour" (effet de Dernière
// Salve sur le pli suivant sa pose) - dans ce cas, le joueur concerné est
// simplement absent de la rotation pour CE pli-ci uniquement. Si c'est lui
// qui aurait dû mener, le joueur suivant dans l'ordre prend sa place
// naturellement (aucun cas particulier à gérer).
function activeOrderThisTrick(room) {
  const n = room.players.length;
  const rotated = Array.from({ length: n }, (_, i) => room.players[(room.leaderIndex + i) % n]);
  return room.sittingOutId ? rotated.filter((p) => p.id !== room.sittingOutId) : rotated;
}

// Nombre total de cartes attendues pour boucler le pli en cours : un joueur
// qui passe son tour en retire une, et Dernière Salve (si jouée ce pli-ci,
// hors tout dernier pli de la manche) en ajoute une - la carte
// supplémentaire du joueur qui l'a posée, jouée après tout le monde.
function trickTotalCards(room) {
  return activeOrderThisTrick(room).length + (room.extraCardOwedBy ? 1 : 0);
}

function roundNumber(room) {
  return room.roundIndex + 1;
}

// Réduit au total courant (+ le dernier delta pour animer le tableau) — même
// raisonnement que l'Ascenseur : le détail manche par manche passe par le
// pop-up de fin de manche, pas par un tableau qui grossirait sans fin.
function scoreboard(room) {
  return room.players.map((p) => ({
    id: p.id,
    nickname: p.nickname,
    total: p.totalScore,
    lastDelta: p.roundHistory.length ? p.roundHistory[p.roundHistory.length - 1].delta : null,
  }));
}

function stateFor(room, p) {
  const inRound = room.phase === 'bidding' || room.phase === 'playing' || room.phase === 'power';
  const bidding = room.phase === 'bidding';
  const base = {
    phase: room.phase,
    myId: p.id,
    isHost: p.id === room.hostId,
    players: room.players.map((pp) => ({
      id: pp.id,
      nickname: pp.nickname,
      connected: pp.connected !== false,
      handCount: pp.hand ? pp.hand.length : 0,
      tricksWon: pp.tricksWon || 0,
      hasBid: room.bids ? Object.prototype.hasOwnProperty.call(room.bids, pp.id) : false,
      // Les annonces sont cachées tant que tout le monde n'a pas choisi : on
      // ne révèle que la sienne (pour confirmer son propre choix) pendant la
      // phase d'annonce ; une fois révélées (phase 'playing' et après),
      // elles sont toutes visibles d'un coup, jamais avant.
      bid: room.bids && (!bidding || pp.id === p.id) ? room.bids[pp.id] : undefined,
    })),
    dealerId: room.players[room.dealerIndex] && room.players[room.dealerIndex].id,
    // Qui mène/mènera le pli en cours (fixé dès la donne, avant même
    // l'annonce) - permet de savoir "qui commence" dès la phase d'annonce,
    // pas seulement une fois la phase de jeu entamée.
    leaderPlayerId: inRound && room.players[room.leaderIndex] ? room.players[room.leaderIndex].id : null,
    roundNumber: roundNumber(room),
    totalRounds: room.roundSequence.length,
    cardsInRound: room.cardsInRound,
    scoreboard: scoreboard(room),
    extensionEnabled: Boolean(room.extensionEnabled),
  };

  if (inRound) {
    base.hand = p.hand;
    base.myBid = room.bids ? room.bids[p.id] : undefined;
  }
  if (room.phase === 'playing' || room.phase === 'power') {
    base.currentTrick = trickForClient(room.currentTrick);
    const turnPlayer = playerAtTurn(room);
    base.turnPlayerId = turnPlayer ? turnPlayer.id : null;
    base.isMyTurn = room.phase === 'playing' && !room.trickPaused && turnPlayer && turnPlayer.id === p.id;
    base.trickNumber = room.trickNumber;
    const preview = currentTrickPreview(room);
    base.leadingPlayerId = preview.leaderId;
    base.trickWillBeDestroyed = preview.destroyed;
    base.trickPaused = Boolean(room.trickPaused);
    base.lastTrickResult = room.trickPaused ? room.lastTrickResult : null;
    // Dernière Salve : ce joueur n'a tout simplement pas de carte à jouer
    // ce pli-ci (autre chose qu'"attendre son tour normalement" - le client
    // affiche un message dédié plutôt qu'une attente silencieuse).
    base.sittingOutThisTrick = room.sittingOutId === p.id;
    // Pouvoir de Mary Thorne : une carte précise de SA main a été tirée au
    // sort pour lui - toute autre carte devient injouable tant que ce
    // n'est pas fait, peu importe la couleur imposée.
    base.forcedCardId = room.forcedPlays ? room.forcedPlays[p.id] : undefined;
  }
  if (room.phase === 'power' && room.pendingPower) {
    const pending = room.pendingPower;
    const mine = pending.playerId === p.id;
    base.pendingPower = {
      kind: pending.kind,
      playerId: pending.playerId,
      mine,
      revealCards: mine ? pending.revealCards : undefined,
      options:
        mine && (pending.kind === 'rosie' || pending.kind === 'marythorne')
          ? room.players.map((pp) => ({ id: pp.id, nickname: pp.nickname, handCount: pp.hand.length }))
          : undefined,
      currentBid: mine && pending.kind === 'harry' ? room.bids[pending.playerId] : undefined,
    };
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
    io.to(p.id).emit('skullking-state', stateFor(room, p));
  }
  scheduleInactivityCheck(io, room);
}

// Voir la constante INACTIVITY_WARN_MS : seule la phase 'playing', hors
// pause de révélation de pli, a un joueur unique dont c'est vraiment le tour.
function scheduleInactivityCheck(io, room) {
  clearTimeout(room.inactivityTimer);
  room.inactivityTimer = null;
  if (room.phase !== 'playing' || room.trickPaused) return;
  const playerId = playerAtTurn(room).id;
  room.inactivityTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    if (room.phase !== 'playing' || room.trickPaused) return;
    if (playerAtTurn(room).id !== playerId) return;
    const player = findPlayer(room, playerId);
    if (!player || player.connected === false) return; // déjà couvert par la bannière de déconnexion
    broadcastToRoom(io, room, 'skullking-inactivity-notice', { id: playerId, nickname: player.nickname });
  }, INACTIVITY_WARN_MS);
}

function endRound(io, room) {
  const num = roundNumber(room);
  const exactness = {};
  const summary = room.players.map((p) => {
    const bid = room.bids[p.id];
    const made = p.tricksWon;
    const exact = made === bid;
    exactness[p.id] = exact;
    const { base, bonus } = computeRoundScoreBreakdown(bid, made, num, p.pendingBonus);
    return { id: p.id, nickname: p.nickname, bid, made, base, bonus, rascalDelta: 0, lootBonus: 0, delta: base + bonus };
  });

  // Mise secondaire de Rascal le Flambeur : gagnée si SA propre annonce de
  // manche est exacte, perdue sinon.
  summary.forEach((s) => {
    const player = findPlayer(room, s.id);
    if (player.rascalStake) {
      const rascalDelta = exactness[s.id] ? player.rascalStake : -player.rascalStake;
      s.rascalDelta = rascalDelta;
      s.delta += rascalDelta;
    }
  });

  // Bonus Butin : +20 chacun si le poseur ET le gagnant du pli réussissent
  // TOUS LES DEUX leur annonce de manche exactement. On garde aussi la paire
  // (dédupliquée : plusieurs Butins dans la manche peuvent lier deux fois les
  // mêmes deux joueurs) pour l'animation de lien côté client.
  const lootLinks = [];
  const seenLootPairs = new Set();
  room.lootAlliances.forEach(({ lootPlayerId, winnerId }) => {
    if (exactness[lootPlayerId] && exactness[winnerId]) {
      const lootEntry = summary.find((s) => s.id === lootPlayerId);
      const winEntry = summary.find((s) => s.id === winnerId);
      if (lootEntry) {
        lootEntry.lootBonus += 20;
        lootEntry.delta += 20;
      }
      if (winEntry) {
        winEntry.lootBonus += 20;
        winEntry.delta += 20;
      }
      const pairKey = [lootPlayerId, winnerId].sort().join('|');
      if (!seenLootPairs.has(pairKey)) {
        seenLootPairs.add(pairKey);
        lootLinks.push({ a: lootPlayerId, b: winnerId });
      }
    }
  });

  summary.forEach((s) => {
    const player = findPlayer(room, s.id);
    player.totalScore += s.delta;
    player.roundHistory.push({ round: num, bid: s.bid, made: s.made, delta: s.delta, total: player.totalScore });
  });

  room.roundIndex += 1;
  if (room.roundIndex >= room.roundSequence.length) {
    finishGame(io, room);
    return;
  }

  room.lastRoundSummary = {
    round: num,
    results: summary.map(({ id, nickname, bid, made, base, bonus, rascalDelta, lootBonus, delta }) => ({
      id,
      nickname,
      bid,
      made,
      base,
      bonus,
      rascalDelta,
      lootBonus,
      delta,
    })),
    lootLinks,
  };
  room.phase = 'round-end';
  broadcastState(io, room);

  room.roundEndTimer = setTimeout(() => {
    if (rooms.get(room.code) === room && room.phase === 'round-end') advanceRound(io, room);
  }, ROUND_END_MS);
}

// Fin de la pause de révélation d'un pli (ou d'un pouvoir de pirate) : le
// meneur passé en paramètre entame le pli suivant, ou la manche se termine
// si c'était le dernier.
function finishTrickCollection(io, room, leaderId) {
  room.currentTrick = [];
  room.trickPaused = false;
  room.pendingPower = null;
  room.pendingPowerQueue = null;
  room.lastTrickResult = null;
  room.lastWinningCard = null;
  room.leaderIndex = room.players.findIndex((p) => p.id === leaderId);
  room.turnCount = 0;
  room.trickNumber += 1;
  // Dernière Salve : le joueur qui l'a posée passe son tour sur le pli qui
  // vient de s'ouvrir (celui-ci uniquement), puis redevient actif normal.
  room.sittingOutId = room.extraCardOwedBy;
  room.extraCardOwedBy = null;

  if (room.trickNumber > room.cardsInRound) {
    endRound(io, room);
    return;
  }
  room.phase = 'playing';
  broadcastState(io, room);
}

// Ouvre la phase d'action d'un pouvoir de pirate. `leaderId` est le meneur
// par défaut du pli suivant (le gagnant du pli) — seule Rosie D'Laney peut
// le changer.
function startPiratePower(io, room, powerKey, playerId, leaderId) {
  room.pendingPower = { kind: powerKey, playerId, leaderId };

  if (powerKey === 'will') {
    const drawn = room.residualPile.splice(0, 2);
    findPlayer(room, playerId).hand.push(...drawn);
  }
  if (powerKey === 'juanita') {
    room.pendingPower.revealCards = [...room.residualPile];
  }

  room.phase = 'power';
  broadcastState(io, room);

  if (powerKey === 'juanita') {
    room.powerTimer = setTimeout(() => {
      if (rooms.get(room.code) === room && room.phase === 'power') resolvePowerDone(io, room);
    }, POWER_REVEAL_MS);
  }
}

// Résumé en clair de la décision prise avec ce pouvoir, diffusé à toute la
// table avant de ramasser le pli - sans ça, seul le joueur qui a utilisé le
// pouvoir sait ce qu'il vient de se passer.
function powerResultMessage(room) {
  const pending = room.pendingPower;
  const player = findPlayer(room, pending.playerId);
  const name = player ? player.nickname : '?';
  switch (pending.kind) {
    case 'rosie': {
      const leader = findPlayer(room, pending.leaderId);
      const leaderName = leader ? (leader.id === pending.playerId ? 'elle-même/lui-même' : leader.nickname) : '?';
      return `🏴‍☠️ Rosie D'Laney (${name}) désigne ${leaderName} pour mener le prochain pli.`;
    }
    case 'will':
      return `🏴‍☠️ Will le Bandit (${name}) a pioché 2 cartes non distribuées et en a défaussé 2.`;
    case 'rascal': {
      const stake = player ? player.rascalStake || 0 : 0;
      return stake > 0
        ? `🏴‍☠️ Rascal le Flambeur (${name}) mise ${stake} points de plus sur sa propre annonce.`
        : `🏴‍☠️ Rascal le Flambeur (${name}) ne mise rien de plus cette manche.`;
    }
    case 'juanita':
      return `🏴‍☠️ Juanita Jade (${name}) a consulté les cartes non distribuées.`;
    case 'harry': {
      const delta = pending.harryDelta || 0;
      const newBid = room.bids[pending.playerId];
      const sign = delta > 0 ? '+1' : delta < 0 ? '-1' : '±0';
      return `🏴‍☠️ Harry le Géant (${name}) modifie son annonce (${sign}) : nouvelle annonce ${newBid}.`;
    }
    case 'marythorne': {
      const target = findPlayer(room, pending.marythorneTargetId);
      const targetName = target ? (target.id === pending.playerId ? 'elle-même/lui-même' : target.nickname) : '?';
      return `🏴‍☠️ Mary Thorne (${name}) tire une carte au hasard dans la main de ${targetName}, à jouer obligatoirement au pli suivant.`;
    }
    default:
      return null;
  }
}

function resolvePowerDone(io, room) {
  const leaderId = room.pendingPower.leaderId;
  const playerId = room.pendingPower.playerId;
  const message = powerResultMessage(room);
  if (message) broadcastToRoom(io, room, 'skullking-power-result', { message });
  // Mat le Forban : plusieurs pouvoirs de Pirates capturés à résoudre à la
  // suite (file constituée à la résolution du pli, voir plus bas) - on
  // enchaîne sur le suivant avant de ramasser le pli pour de bon, en
  // conservant le meneur déjà éventuellement changé par un pouvoir
  // précédent de la même file (ex: Rosie D'Laney).
  if (room.pendingPowerQueue && room.pendingPowerQueue.length) {
    const nextKey = room.pendingPowerQueue.shift();
    startPiratePower(io, room, nextKey, playerId, leaderId);
    return;
  }
  finishTrickCollection(io, room, leaderId);
}

function advanceRound(io, room) {
  clearRoomTimers(room);
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  startRound(io, room);
}

function clearRoomTimers(room) {
  clearTimeout(room.roundEndTimer);
  clearTimeout(room.trickTimer);
  clearTimeout(room.powerTimer);
  clearTimeout(room.inactivityTimer);
  room.roundEndTimer = null;
  room.trickTimer = null;
  room.powerTimer = null;
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
  room.roundSequence = buildRoundSequence();
  room.roundIndex = 0;
  room.dealerIndex = 0;
  room.players.forEach((p) => {
    p.totalScore = 0;
    p.roundHistory = [];
  });
  startRound(io, room);
}

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
  broadcastToRoom(io, room, 'skullking-player-left', { nickname: removed.nickname });
  broadcastLobby(io, room);
}

// Même choix que l'Ascenseur : un départ définitif en pleine partie (délai
// de grâce expiré, ou "Quitter" explicite) met fin à la partie pour tout le
// monde, classement sur le score courant — retirer un seul joueur casserait
// l'ordre des plis et la main déjà distribuée des autres.
function finalizeSkullKingDisconnect(io, room, id, reason) {
  const player = findPlayer(room, id);
  if (!player) return;

  if (room.phase === 'lobby') {
    removeFromLobby(io, room, id);
    return;
  }

  broadcastToRoom(io, room, 'skullking-player-left', { nickname: player.nickname, reason: reason || 'left' });
  finishGame(io, room);
}

function handleExplicitLeave(io, socket) {
  const code = socket.data.skullkingRoom;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.skullkingRoom = null;
  if (!room) return;
  finalizeSkullKingDisconnect(io, room, socket.id, 'left');
}

function handleDisconnecting(io, socket) {
  const code = socket.data.skullkingRoom;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.skullkingRoom = null;
  if (!room) return;

  const player = findPlayer(room, socket.id);
  if (!player) return;

  player.connected = false;
  broadcastToRoom(io, room, 'skullking-player-disconnected', {
    id: player.id,
    nickname: player.nickname,
  });

  // En salon d'attente, un délai de grâce reste nécessaire (voir
  // ascenseur-room.js pour le contexte du bug qu'il corrige). En pleine
  // partie : pause indéfinie, décision réconciliée Manche 2 — seul l'hôte
  // peut choisir d'arrêter (skullking-end-game, déjà existant).
  if (room.phase === 'lobby') {
    player.disconnectTimer = setTimeout(() => {
      if (rooms.get(code) === room) finalizeSkullKingDisconnect(io, room, player.id, 'timeout');
    }, DISCONNECT_GRACE_MS);
  }
}

// Garde commune à tous les handlers de pouvoir : bonne phase, bon pouvoir en
// attente, et c'est bien à ce joueur d'agir.
function guardPower(room, socket, kind) {
  if (!room || room.phase !== 'power' || !room.pendingPower) return false;
  if (room.pendingPower.kind !== kind) return false;
  return room.pendingPower.playerId === socket.id;
}

function registerSkullKingHandlers(io, socket) {
  socket.on('skullking-create-room', (payload) => {
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
      extensionEnabled: false,
      players: [
        {
          id: socket.id,
          nickname,
          token: payload && payload.token,
          connected: true,
          disconnectTimer: null,
          hand: [],
          tricksWon: 0,
          pendingBonus: 0,
          rascalStake: 0,
          totalScore: 0,
          roundHistory: [],
        },
      ],
    };
    rooms.set(code, room);
    socket.data.skullkingRoom = code;
    socket.emit('skullking-room-created', { code });
    broadcastLobby(io, room);
  });

  socket.on('skullking-join-room', (payload) => {
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
    const maxPlayers = maxPlayersFor(room.extensionEnabled);
    if (room.players.length >= maxPlayers) {
      sendError(socket, `Cette partie est complète (${maxPlayers} joueurs max).`);
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
      pendingBonus: 0,
      rascalStake: 0,
      totalScore: 0,
      roundHistory: [],
    });
    socket.data.skullkingRoom = code;
    broadcastLobby(io, room);
  });

  // Le switch d'extension : seul l'hôte peut le basculer, uniquement en
  // lobby (verrouillé dès que la partie démarre, room.extensionEnabled
  // n'est plus modifié nulle part ailleurs). Diffusé à tous via
  // broadcastLobby comme le reste de l'état du salon, pas de système de
  // sync dédié.
  socket.on('skullking-toggle-extension', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    room.extensionEnabled = !room.extensionEnabled;
    // Si l'extension vient d'être désactivée et que la salle dépassait déjà
    // le plafond de base, on laisse l'hôte constater l'incompatibilité via
    // canStart plutôt que d'expulser qui que ce soit.
    broadcastLobby(io, room);
  });

  socket.on('skullking-start-game', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    const maxPlayers = maxPlayersFor(room.extensionEnabled);
    if (room.players.length < MIN_PLAYERS || room.players.length > maxPlayers) return;
    recordGameStarted('skullking');
    startGame(io, room);
  });

  socket.on('skullking-rematch', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'game-end') return;
    room.phase = 'lobby';
    room.players.forEach((p) => {
      p.hand = [];
      p.tricksWon = 0;
      p.pendingBonus = 0;
      p.rascalStake = 0;
      p.totalScore = 0;
      p.roundHistory = [];
    });
    broadcastLobby(io, room);
  });

  // Annonce simultanée : chaque joueur choisit en aveugle, la révélation a
  // lieu d'un coup pour tout le monde dès que le dernier a annoncé (voir
  // stateFor : la valeur de chaque annonce reste cachée aux autres tant que
  // room.phase==='bidding', même après avoir été reçue par le serveur).
  socket.on('skullking-bid', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'bidding') return;
    // L'annonce reste modifiable tant que la phase d'annonce n'est pas
    // terminée (donc tant que tout le monde n'a pas annoncé) - une fois
    // que tous ont choisi, la phase passe à 'playing' et ce handler ne
    // fait plus rien de toute façon.
    const bid = Number(payload && payload.bid);
    if (!isValidBid(bid, room.cardsInRound)) {
      sendError(socket, 'Annonce invalide.');
      return;
    }
    room.bids[socket.id] = bid;
    if (allBidsIn(room)) room.phase = 'playing';
    broadcastState(io, room);
  });

  socket.on('skullking-play-card', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'playing') return;
    if (room.trickPaused) return;
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
    // Pouvoir de Mary Thorne : une carte précise de sa main a été tirée au
    // sort pour ce joueur - elle prime sur toute autre règle de jouabilité
    // ("peu importe la couleur d'entame ou tout autre effet de carte").
    const forcedCardId = room.forcedPlays && room.forcedPlays[player.id];
    if (forcedCardId && cardId !== forcedCardId) {
      sendError(socket, 'Le pouvoir de Mary Thorne t\'oblige à jouer une carte précise ce pli-ci.');
      return;
    }
    if (!forcedCardId && !isCardPlayable(card, player.hand, room.currentTrick)) {
      sendError(socket, 'Tu dois suivre la couleur demandée si tu en as encore en main.');
      return;
    }
    // Seule la Tigresse demande un choix au moment de la pose (jouée comme
    // Pirate ou comme Fuite) - elle reste toujours jouable quelle que soit
    // la couleur demandée, comme toute carte spéciale.
    if (card.kind === 'tigress') {
      const chosenAs = payload && payload.chosenAs;
      if (chosenAs !== 'pirate' && chosenAs !== 'escape') {
        sendError(socket, 'Choisis si la Tigresse est jouée comme Pirate ou comme Fuite.');
        return;
      }
      card.chosenAs = chosenAs;
    }
    // 0/14 : la valeur n'est fixée qu'au moment de la pose.
    if (card.wild14 && card.value == null) {
      const declaredValue = Number(payload && payload.declaredValue);
      if (declaredValue !== 0 && declaredValue !== 14) {
        sendError(socket, 'Choisis si cette carte vaut 0 ou 14.');
        return;
      }
      card.value = declaredValue;
    }
    // Joker/Wild 15 : prend la couleur déjà imposée par le pli si elle est
    // vert/jaune/violet ; sinon (rien d'imposé encore) le joueur choisit ;
    // sinon (le noir est déjà imposé) il reste sans couleur, ce qui suffit
    // à le faire perdre face à l'atout noir (voir resolveTrick/resolveHierarchy,
    // aucun cas particulier n'y est nécessaire).
    if (card.kind === 'wild15') {
      const ledSuit = ledSuitOf(room.currentTrick);
      let chosenSuit;
      if (ledSuit === 'vert' || ledSuit === 'jaune' || ledSuit === 'violet') {
        chosenSuit = ledSuit;
      } else if (ledSuit === null) {
        const requested = payload && payload.chosenSuit;
        if (!['vert', 'jaune', 'violet'].includes(requested)) {
          sendError(socket, 'Choisis la couleur prise par le Joker (vert, jaune ou violet).');
          return;
        }
        chosenSuit = requested;
      }
      card.kind = 'number';
      card.suit = chosenSuit;
      card.value = 15;
      card.wild15 = true; // marqueur explicite pour l'affichage client, sans incidence sur la résolution
    }
    // Marcher sur la Planche : retire un Pirate présent dans le pli en
    // cours (pas Mat le Forban, qui n'est pas un "vrai" Pirate) - aucun
    // choix nécessaire s'il n'y en a qu'un seul ou aucun.
    if (card.kind === 'plank') {
      const piratesInTrick = eligiblePlankTargets(room.currentTrick);
      if (piratesInTrick.length > 1) {
        const requested = payload && payload.removesId;
        if (!piratesInTrick.some((t) => t.card.id === requested)) {
          sendError(socket, 'Choisis quel Pirate retirer du pli.');
          return;
        }
        card.removesId = requested;
      } else if (piratesInTrick.length === 1) {
        card.removesId = piratesInTrick[0].card.id;
      }
    }

    player.hand = player.hand.filter((c) => c.id !== cardId);
    if (forcedCardId) delete room.forcedPlays[player.id];
    room.currentTrick.push({ playerId: player.id, card });
    room.turnCount += 1;

    // Dernière Salve : sauf sur le tout dernier pli de la manche, le joueur
    // qui la pose devra encore jouer une carte après tout le monde ce
    // pli-ci, puis passera son tour au pli suivant (voir finishTrickCollection).
    if (card.kind === 'lastvolley' && room.trickNumber !== room.cardsInRound) {
      room.extraCardOwedBy = player.id;
    }

    if (room.currentTrick.length !== trickTotalCards(room)) {
      broadcastState(io, room);
      return;
    }

    // Pli complet : on le laisse affiché un instant avant de le ramasser,
    // sinon la dernière carte posée n'apparaît jamais.
    const cards = room.currentTrick.map((t) => t.card);
    const result = resolveTrick(cards);
    let winnerId = null;
    if (!result.destroyed) {
      winnerId = room.currentTrick[result.winnerIdx].playerId;
      const winner = findPlayer(room, winnerId);
      winner.tricksWon += 1;
      winner.pendingBonus += trickBonusForWinner(cards, result.winnerIdx, result.excludedIdx);
      winner.pendingBonus += result.monstersDestroyed * 20;
      // Alliance Butin : chaque Butin posé par un AUTRE joueur que le
      // vainqueur forme une alliance avec lui (sauf s'il a gagné lui-même
      // via le cas exceptionnel "tout-Fuites + Butin", déjà exclu ici
      // puisque result.winnerIdx pointerait alors sur ce Butin lui-même).
      room.currentTrick.forEach((t, i) => {
        if (t.card.kind === 'loot' && i !== result.winnerIdx) {
          room.lootAlliances.push({ lootPlayerId: t.playerId, winnerId });
        }
      });
    }
    const leaderId = room.currentTrick[result.leaderIdx].playerId;
    room.lastTrickResult = { destroyed: result.destroyed, winnerId };
    room.lastWinningCard = result.destroyed ? null : cards[result.winnerIdx];
    room.trickPaused = true;
    broadcastState(io, room);

    room.trickTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room) return;
      const winningCard = room.lastWinningCard;
      const isLastTrick = room.trickNumber === room.cardsInRound;
      if (winningCard && winningCard.kind === 'pirate' && winningCard.name) {
        const powerKey = PIRATE_POWER_BY_NAME[winningCard.name];
        // Tous les pouvoirs sauf celui d'Harry le Géant sont indisponibles
        // sur le dernier pli de la manche.
        if (powerKey === 'harry' || !isLastTrick) {
          startPiratePower(io, room, powerKey, winnerId, leaderId);
          return;
        }
      }
      // Mat le Forban : hérite du/des pouvoir(s) de tout(s) Pirate(s)
      // classique(s) capturé(s) dans le même pli (retiré par la Planche
      // exclu, voir result.excludedIdx), à résoudre à la suite les uns des
      // autres - sans toucher au bonus de capture normal, géré séparément
      // dans trickBonusForWinner.
      if (winningCard && winningCard.kind === 'firstmate') {
        const capturedNames = room.currentTrick
          .filter((t, i) => !result.excludedIdx.has(i) && t.card.kind === 'pirate')
          .map((t) => t.card.name);
        const powerKeys = capturedNames
          .map((name) => PIRATE_POWER_BY_NAME[name])
          .filter((k) => k && (k === 'harry' || !isLastTrick));
        if (powerKeys.length) {
          room.pendingPowerQueue = powerKeys.slice(1);
          startPiratePower(io, room, powerKeys[0], winnerId, leaderId);
          return;
        }
      }
      finishTrickCollection(io, room, leaderId);
    }, TRICK_REVEAL_MS);
  });

  // Rosie D'Laney : choisit qui entame le pli suivant (elle-même incluse).
  socket.on('skullking-power-rosie', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'rosie')) return;
    const targetId = payload && payload.leaderId;
    // Corrigé Manche 2 : une cible invalide restait sans aucun retour, le
    // pouvoir semblait juste ne rien faire côté client.
    if (!findPlayer(room, targetId)) {
      sendError(socket, 'Cible invalide pour Rosie D\'Laney.');
      return;
    }
    room.pendingPower.leaderId = targetId;
    resolvePowerDone(io, room);
  });

  // Mary Thorne : choisit un joueur (elle-même incluse) - une carte au
  // hasard de sa main lui sera imposée au pli suivant, peu importe la
  // couleur d'entame ou tout autre effet de carte à ce moment-là (voir le
  // contrôle forcedCardId dans skullking-play-card). Sans effet si la
  // cible n'a plus de carte en main (fin de manche).
  socket.on('skullking-power-marythorne', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'marythorne')) return;
    const targetId = payload && payload.targetId;
    const target = findPlayer(room, targetId);
    // Même bug que Rosie D'Laney (corrigé Manche 2) : une cible invalide ne
    // renvoyait rien.
    if (!target) {
      sendError(socket, 'Cible invalide pour Mary Thorne.');
      return;
    }
    room.pendingPower.marythorneTargetId = target.id;
    if (target.hand.length > 0) {
      const picked = target.hand[Math.floor(Math.random() * target.hand.length)];
      room.forcedPlays = room.forcedPlays || {};
      room.forcedPlays[target.id] = picked.id;
    }
    resolvePowerDone(io, room);
  });

  // Will le Bandit : les 2 cartes piochées sont déjà dans sa main (ajoutées
  // à l'ouverture du pouvoir) — il doit désormais en défausser 2, parmi
  // n'importe lesquelles de sa main actuelle.
  socket.on('skullking-power-will', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'will')) return;
    const discardIds = payload && payload.discardIds;
    if (!Array.isArray(discardIds) || discardIds.length !== 2 || new Set(discardIds).size !== 2) {
      sendError(socket, 'Choisis exactement 2 cartes à défausser.');
      return;
    }
    const player = findPlayer(room, socket.id);
    const found = discardIds.map((id) => player.hand.find((c) => c.id === id));
    if (found.some((c) => !c)) {
      sendError(socket, 'Carte introuvable dans ta main.');
      return;
    }
    player.hand = player.hand.filter((c) => !discardIds.includes(c.id));
    room.residualPile.push(...found);
    resolvePowerDone(io, room);
  });

  // Rascal le Flambeur : mise secondaire 0/10/20, réglée en même temps que
  // le score de la manche (voir endRound).
  socket.on('skullking-power-rascal', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'rascal')) return;
    const stake = Number(payload && payload.stake);
    if (![0, 10, 20].includes(stake)) {
      sendError(socket, 'Mise invalide.');
      return;
    }
    findPlayer(room, socket.id).rascalStake = stake;
    resolvePowerDone(io, room);
  });

  // Harry le Géant : modifie sa propre annonce de ±1, dans les limites de la
  // manche — seul pouvoir utilisable même après le dernier pli.
  socket.on('skullking-power-harry', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'harry')) return;
    const delta = Number(payload && payload.delta);
    if (![-1, 0, 1].includes(delta)) {
      sendError(socket, 'Choix invalide.');
      return;
    }
    const player = findPlayer(room, socket.id);
    const newBid = room.bids[player.id] + delta;
    if (newBid < 0 || newBid > room.cardsInRound) {
      sendError(socket, 'Annonce hors limites.');
      return;
    }
    room.bids[player.id] = newBid;
    room.pendingPower.harryDelta = delta;
    resolvePowerDone(io, room);
  });

  socket.on('skullking-next-round', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'round-end') return;
    if (socket.id !== room.hostId) return;
    advanceRound(io, room);
  });

  socket.on('skullking-end-game', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room) return;
    if (!['bidding', 'playing', 'power', 'round-end'].includes(room.phase)) return;
    if (socket.id !== room.hostId) return;
    finishGame(io, room);
  });

  socket.on('skullking-rejoin-room', (payload) => {
    const code = ((payload && payload.code) || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('skullking-rejoin-failed', { reason: likelyServerRestart() ? 'server-restarted' : 'not-found' });
      return;
    }
    const player = findPlayerByToken(room, payload && payload.token);
    if (!player) {
      socket.emit('skullking-rejoin-failed', { reason: 'not-found' });
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
    socket.data.skullkingRoom = code;

    if (room.phase === 'lobby') {
      broadcastLobby(io, room);
      return;
    }

    socket.emit('skullking-rejoin-ok', stateFor(room, player));
    if (wasDisconnected) {
      broadcastToRoom(io, room, 'skullking-player-reconnected', { id: player.id, nickname: player.nickname });
    }
  });

  socket.on('skullking-leave-room', () => handleExplicitLeave(io, socket));
  socket.on('disconnecting', () => handleDisconnecting(io, socket));
}

module.exports = {
  registerSkullKingHandlers,
  MIN_PLAYERS,
  MAX_PLAYERS,
  eligiblePlankTargets,
  trickForClient,
  getStats,
};
