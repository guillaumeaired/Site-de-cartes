// Salons du 24 en Socket.io. Même socle que les trois autres jeux (table de
// salons, hôte, jeton de reconnexion, délai de grâce), mais un déroulé
// différent : ce n'est pas un jeu de plis au tour par tour, c'est une COURSE
// avec buzzer.
//
// Le déroulé d'une donne, qui est tout le sel du jeu :
//
//   1. Les quatre mêmes cartes s'affichent chez tout le monde. Personne ne
//      manipule rien — on cherche dans sa tête, comme autour d'une table.
//   2. Le premier qui voit la solution appuie sur « J'ai ! ». Il prend la
//      main, seul ; le chrono de la donne se FIGE pendant ce temps (sinon
//      buzzer à la 55e seconde ne laisserait que 5 secondes pour montrer).
//   3. Il a EXPLAIN_MS pour poser sa combinaison. Il peut se reprendre autant
//      qu'il veut dans cette fenêtre.
//   4. S'il tombe sur 24, il gagne la manche. Sinon, à l'expiration de sa
//      fenêtre, il est écarté de CETTE donne seulement et le chrono repart
//      où il s'était arrêté pour les autres, qui peuvent buzzer à leur tour.
//
// C'est ce point 4 qui fait tenir le jeu : buzzer à l'aveugle coûte sa donne.

const { tirerDonne, rejouerEtapes, CIBLE } = require('./vingtquatre');
const { likelyServerRestart } = require('./server-start');
const { makeRoomCode, sanitizeNickname } = require('./commun');
const { recordGameStarted } = require('./play-counts');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

// Temps de recherche par donne, hors explications. Assez pour une donne
// difficile trouvée de tête, assez court pour qu'une donne sur laquelle tout
// le monde sèche ne plombe pas la partie.
const ROUND_MS = 60_000;

// Fenêtre d'explication après un buzz. Assez pour poser une solution qu'on a
// déjà en tête, trop court pour la chercher pendant que les autres attendent.
const EXPLAIN_MS = 20_000;

// Après une manche : le temps de lire ce qui s'est passé avant que la
// suivante démarre toute seule. Plus long quand personne n'a trouvé, parce
// qu'il y a une solution à lire et à comprendre — pas juste un nom.
const REVEAL_TROUVE_MS = 5_000;
const REVEAL_RATE_MS = 8_000;

// Salon d'attente uniquement : sans ce délai, mettre son téléphone en veille
// une seconde pour coller le lien d'invitation détruit le salon qu'on vient
// de créer (bug déjà constaté sur les autres jeux).
const DISCONNECT_GRACE_MS = 45_000;

const rooms = new Map();

function getStats() {
  const list = [...rooms.values()];
  return { total: list.length, playing: list.filter((r) => r.phase !== 'lobby').length };
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function findPlayerByToken(room, token) {
  if (!token) return null;
  return room.players.find((p) => p.token === token);
}

// Une reconnexion donne un nouveau socket.id : tout ce qui indexait l'ancien
// doit suivre, y compris le buzz en cours — sinon un joueur qui recharge sa
// page pendant son explication perd la main sans que personne ne la reprenne,
// et la donne reste bloquée jusqu'au bout de sa fenêtre.
function rekeyPlayerId(room, oldId, newId) {
  if (oldId === newId) return;
  if (room.claimerId === oldId) room.claimerId = newId;
  if (room.reveal && room.reveal.winnerId === oldId) room.reveal.winnerId = newId;
  if (Array.isArray(room.finalRanking)) {
    room.finalRanking.forEach((r) => {
      if (r.id === oldId) r.id = newId;
    });
  }
  if (room.hostId === oldId) room.hostId = newId;
}

function sendError(socket, message) {
  socket.emit('vingtquatre-error', message);
}

// Un joueur qui a cliqué « Quitter » reste dans room.players — il doit
// figurer au classement final envoyé aux autres — mais ne reçoit plus rien.
function destinataires(room) {
  return room.players.filter((p) => !p.gone);
}

function broadcastToRoom(io, room, event, data) {
  for (const p of destinataires(room)) io.to(p.id).emit(event, data);
}

function broadcastLobby(io, room) {
  for (const p of destinataires(room)) {
    io.to(p.id).emit('vingtquatre-lobby-update', {
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

function clearRoomTimers(room) {
  clearTimeout(room.roundTimer);
  clearTimeout(room.claimTimer);
  clearTimeout(room.revealTimer);
  room.roundTimer = null;
  room.claimTimer = null;
  room.revealTimer = null;
}

function joueursConnectes(room) {
  return destinataires(room).filter((p) => p.connected !== false);
}

// Qui peut encore prendre la main sur cette donne : ni parti, ni déconnecté,
// ni ayant passé, ni écarté pour s'être trompé. Quand il n'en reste aucun, la
// donne n'a plus personne à attendre.
function chercheursActifs(room) {
  return joueursConnectes(room).filter((p) => !p.passe && !p.elimine);
}

// Le buzzer est-il pressable par ce joueur, là, maintenant ? Un seul joueur
// explique à la fois : c'est la règle qui empêche deux personnes de manipuler
// la même donne en parallèle.
function peutBuzzer(room, player) {
  if (!room || !player) return false;
  if (room.phase !== 'playing') return false;
  if (room.claimerId) return false;
  return !player.gone && player.connected !== false && !player.passe && !player.elimine;
}

function scoreboard(room) {
  return [...room.players]
    .filter((p) => !p.gone)
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname))
    .map((p) => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score,
      connected: p.connected !== false,
      passe: Boolean(p.passe),
      elimine: Boolean(p.elimine),
      claime: room.claimerId === p.id,
    }));
}

function stateFor(room, p) {
  const base = {
    phase: room.phase,
    myId: p.id,
    code: room.code,
    isHost: p.id === room.hostId,
    cible: CIBLE,
    roundNumber: room.roundNumber,
    scoreboard: scoreboard(room),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
  };

  if (room.phase === 'playing' || room.phase === 'reveal') {
    base.cartes = room.donne.cartes;
    base.difficulte = room.donne.difficulte;
    base.nbSolutions = room.donne.nbSolutions;
    base.jAiPasse = Boolean(p.passe);
    base.jeSuisElimine = Boolean(p.elimine);
  }
  if (room.phase === 'playing') {
    base.roundMs = ROUND_MS;
    // Le temps restant, pas une heure de fin : le client n'a pas à faire
    // confiance à l'horloge de sa machine, qui peut être décalée de plusieurs
    // minutes par rapport au serveur. Il décompte à partir de la réception.
    base.msRestant = msDonneRestant(room);
    base.claimerId = room.claimerId || null;
    base.claimerNickname = room.claimerId ? (findPlayer(room, room.claimerId) || {}).nickname || null : null;
    base.jeExplique = room.claimerId === p.id;
    // Chrono figé tant que quelqu'un explique : le client arrête sa barre au
    // lieu de la laisser filer sur un temps qui ne s'écoule plus.
    base.chronoFige = Boolean(room.claimerId);
    base.explainMs = EXPLAIN_MS;
    base.msExplication = room.claimerId ? Math.max(0, room.claimEndsAt - Date.now()) : null;
    base.peutBuzzer = peutBuzzer(room, p);
    base.chercheurs = chercheursActifs(room).length;
  }
  if (room.phase === 'reveal') {
    base.reveal = room.reveal;
    base.revealMs = room.revealMs;
  }
  if (room.phase === 'game-end') {
    base.finalRanking = room.finalRanking;
    base.manchesJouees = room.roundNumber;
  }
  return base;
}

// Combien de temps de recherche il reste sur la donne. Pendant une
// explication, le compteur est gelé : c'est la valeur mise de côté au buzz
// qui fait foi.
function msDonneRestant(room) {
  if (room.claimerId) return room.msGele;
  return Math.max(0, room.roundEndsAt - Date.now());
}

function broadcastState(io, room) {
  for (const p of destinataires(room)) io.to(p.id).emit('vingtquatre-state', stateFor(room, p));
}

function armerChronoDonne(io, room, ms) {
  clearTimeout(room.roundTimer);
  room.roundEndsAt = Date.now() + ms;
  room.roundTimer = setTimeout(() => {
    if (rooms.get(room.code) === room && room.phase === 'playing' && !room.claimerId) endRound(io, room, null);
  }, ms);
}

function startRound(io, room) {
  clearRoomTimers(room);

  // Contrairement aux jeux de plis, les manches du 24 s'enchaînent toutes
  // seules : sans ce garde-fou, un salon que tout le monde a quitté par une
  // coupure réseau (métro, wifi qui tombe) continuerait à tirer une donne
  // toutes les minutes jusqu'au redémarrage du serveur, sans personne pour la
  // voir. On gèle plutôt la partie ; le premier retour la relance (voir
  // vingtquatre-rejoin-room).
  if (joueursConnectes(room).length === 0) {
    room.enPause = true;
    return;
  }
  room.enPause = false;
  room.roundNumber += 1;
  room.donne = tirerDonne(room.donnesVues);
  room.phase = 'playing';
  room.roundStartedAt = Date.now();
  room.claimerId = null;
  room.claimEndsAt = 0;
  room.msGele = ROUND_MS;
  room.reveal = null;
  room.players.forEach((p) => {
    p.passe = false;
    p.elimine = false;
  });
  armerChronoDonne(io, room, ROUND_MS);
  broadcastState(io, room);
}

// Un joueur prend la main. Le chrono de la donne se fige et sa fenêtre
// d'explication démarre.
function demarrerClaim(io, room, player) {
  room.msGele = Math.max(0, room.roundEndsAt - Date.now());
  clearTimeout(room.roundTimer);
  room.roundTimer = null;
  room.claimerId = player.id;
  room.claimEndsAt = Date.now() + EXPLAIN_MS;
  broadcastState(io, room);

  room.claimTimer = setTimeout(() => {
    if (rooms.get(room.code) === room && room.claimerId === player.id) echecClaim(io, room, 'temps');
  }, EXPLAIN_MS);
}

// La main est rendue sans que 24 soit tombé : le joueur est écarté de cette
// donne (et d'elle seule), le chrono repart où il s'était arrêté.
function echecClaim(io, room, raison) {
  const claimer = findPlayer(room, room.claimerId);
  clearTimeout(room.claimTimer);
  room.claimTimer = null;
  room.claimerId = null;
  if (claimer) claimer.elimine = true;

  if (claimer) {
    broadcastToRoom(io, room, 'vingtquatre-claim-rate', {
      id: claimer.id,
      nickname: claimer.nickname,
      raison: raison || 'temps',
    });
  }

  // Plus personne pour chercher : la donne n'a plus de raison d'attendre la
  // fin de son chrono devant des joueurs qui ne peuvent plus rien tenter.
  if (chercheursActifs(room).length === 0) {
    endRound(io, room, null);
    return;
  }
  armerChronoDonne(io, room, room.msGele);
  broadcastState(io, room);
}

// Fin de manche. `gagnant` est null quand le temps est écoulé ou que plus
// personne ne peut chercher : on montre alors une solution, sans quoi la
// donne repart sans qu'on ait jamais su ce qu'il fallait voir — c'est le
// moment où on apprend à jouer.
function endRound(io, room, gagnant, formule) {
  clearRoomTimers(room);
  const trouve = Boolean(gagnant);
  if (trouve) gagnant.score += 1;
  room.claimerId = null;

  room.reveal = {
    trouve,
    winnerId: trouve ? gagnant.id : null,
    winnerNickname: trouve ? gagnant.nickname : null,
    formule: trouve ? formule : null,
    tempsMs: trouve ? Date.now() - room.roundStartedAt : null,
    solution: room.donne.solution,
    nbSolutions: room.donne.nbSolutions,
    // Trois fins différentes à raconter : quelqu'un a trouvé, le temps est
    // tombé, ou tout le monde s'est éliminé/a passé. Ce n'est pas la même
    // chose à lire pour les joueurs.
    raison: trouve ? 'trouve' : chercheursActifs(room).length === 0 ? 'abandon' : 'temps',
  };
  room.revealMs = trouve ? REVEAL_TROUVE_MS : REVEAL_RATE_MS;
  room.phase = 'reveal';
  broadcastState(io, room);

  // La manche suivante s'enchaîne toute seule : personne n'a à cliquer, et
  // une partie ne s'arrête pas parce que l'hôte a le nez ailleurs.
  room.revealTimer = setTimeout(() => {
    if (rooms.get(room.code) === room && room.phase === 'reveal') startRound(io, room);
  }, room.revealMs);
}

function finishGame(io, room) {
  clearRoomTimers(room);
  room.claimerId = null;
  room.finalRanking = [...room.players]
    .filter((p) => !p.gone)
    .map((p) => ({ id: p.id, nickname: p.nickname, score: p.score }))
    .sort((a, b) => b.score - a.score);
  room.phase = 'game-end';
  broadcastState(io, room);
}

function startGame(io, room) {
  room.roundNumber = 0;
  room.donnesVues = new Set();
  room.players.forEach((p) => {
    p.score = 0;
    p.passe = false;
    p.elimine = false;
  });
  startRound(io, room);
}

function nouveauJoueur(socket, nickname, payload) {
  return {
    id: socket.id,
    nickname,
    token: payload && payload.token,
    connected: true,
    disconnectTimer: null,
    score: 0,
    passe: false,
    elimine: false,
  };
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
  broadcastToRoom(io, room, 'vingtquatre-player-left', { nickname: removed.nickname });
  broadcastLobby(io, room);
}

// Un joueur n'est plus là (départ, coupure). Si c'est lui qui avait la main,
// la donne ne doit pas rester suspendue à quelqu'un qui ne reviendra pas
// avant la fin de sa fenêtre : on lui reprend la main tout de suite.
function libererSiClaimer(io, room, id) {
  if (room.phase !== 'playing' || room.claimerId !== id) return false;
  echecClaim(io, room, 'parti');
  return true;
}

// Départ définitif en pleine partie. Contrairement à l'Ascenseur, la partie
// n'a aucune raison de s'arrêter : personne ne dépendait de ce joueur pour
// jouer son tour. On le retire des destinataires et la course continue.
function finalizeDisconnect(io, room, id) {
  const player = findPlayer(room, id);
  if (!player) return;

  if (room.phase === 'lobby') {
    removeFromLobby(io, room, id);
    return;
  }

  player.gone = true;

  if (destinataires(room).length === 0) {
    clearRoomTimers(room);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === id) {
    room.hostId = destinataires(room)[0].id;
  }

  broadcastToRoom(io, room, 'vingtquatre-player-left', { nickname: player.nickname });

  if (libererSiClaimer(io, room, id)) return;

  // Son départ peut achever la manche : s'il était le dernier à chercher
  // encore, plus personne n'attend la fin du chrono.
  if (room.phase === 'playing' && chercheursActifs(room).length === 0) {
    endRound(io, room, null);
    return;
  }
  broadcastState(io, room);
}

function handleExplicitLeave(io, socket) {
  const code = socket.data.vingtquatreRoom;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.vingtquatreRoom = null;
  if (!room) return;
  finalizeDisconnect(io, room, socket.id);
}

function handleDisconnecting(io, socket) {
  const code = socket.data.vingtquatreRoom;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.vingtquatreRoom = null;
  if (!room) return;

  const player = findPlayer(room, socket.id);
  if (!player) return;

  player.connected = false;
  broadcastToRoom(io, room, 'vingtquatre-player-disconnected', { id: player.id, nickname: player.nickname });

  if (room.phase === 'lobby') {
    player.disconnectTimer = setTimeout(() => {
      if (rooms.get(code) === room) finalizeDisconnect(io, room, player.id);
    }, DISCONNECT_GRACE_MS);
    return;
  }

  // En partie : pas de délai de grâce, il peut revenir quand il veut. Mais la
  // donne ne l'attend pas — surtout s'il avait la main.
  if (libererSiClaimer(io, room, player.id)) return;

  if (room.phase === 'playing' && chercheursActifs(room).length === 0) {
    endRound(io, room, null);
    return;
  }
  broadcastState(io, room);
}

function registerVingtquatreHandlers(io, socket) {
  socket.on('vingtquatre-create-room', (payload) => {
    const nickname = sanitizeNickname(payload && payload.nickname);
    if (!nickname) {
      sendError(socket, 'Choisis un pseudo avant de créer une partie.');
      return;
    }
    const code = makeRoomCode(rooms);
    const room = {
      code,
      phase: 'lobby',
      hostId: socket.id,
      players: [nouveauJoueur(socket, nickname, payload)],
      roundNumber: 0,
      donnesVues: new Set(),
      donne: null,
      reveal: null,
      claimerId: null,
      claimEndsAt: 0,
      msGele: ROUND_MS,
      roundTimer: null,
      claimTimer: null,
      revealTimer: null,
    };
    rooms.set(code, room);
    socket.data.vingtquatreRoom = code;
    socket.emit('vingtquatre-room-created', { code });
    broadcastLobby(io, room);
  });

  socket.on('vingtquatre-join-room', (payload) => {
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
    room.players.push(nouveauJoueur(socket, nickname, payload));
    socket.data.vingtquatreRoom = code;
    broadcastLobby(io, room);
  });

  socket.on('vingtquatre-start-game', () => {
    const room = rooms.get(socket.data.vingtquatreRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) return;
    recordGameStarted('vingtquatre');
    startGame(io, room);
  });

  // Le buzzer. Node traite les messages un par un : le premier « J'ai ! »
  // reçu pose room.claimerId, et tous ceux qui arrivent derrière tombent sur
  // le test de peutBuzzer. Pas de verrou nécessaire, pas d'égalité possible.
  socket.on('vingtquatre-claim', () => {
    const room = rooms.get(socket.data.vingtquatreRoom);
    if (!room) return;
    const player = findPlayer(room, socket.id);
    if (!peutBuzzer(room, player)) return;
    demarrerClaim(io, room, player);
  });

  // L'explication. Le client a fusionné ses cartes de son côté (c'est ce qui
  // rend la manipulation instantanée) et envoie la suite d'opérations ; c'est
  // ici qu'on tranche. Seul celui qui a la main est écouté.
  socket.on('vingtquatre-solve', (payload) => {
    const room = rooms.get(socket.data.vingtquatreRoom);
    if (!room || room.phase !== 'playing') return;
    if (room.claimerId !== socket.id) {
      sendError(socket, "Ce n'est pas toi qui as la main.");
      return;
    }
    const player = findPlayer(room, socket.id);
    if (!player) return;

    const verdict = rejouerEtapes(room.donne.cartes, payload && payload.etapes);
    if (!verdict.ok) {
      // Pas d'élimination immédiate : dans sa fenêtre, il a le droit de se
      // reprendre (un clic malheureux ne doit pas coûter la donne). C'est
      // l'expiration de la fenêtre qui sanctionne, pas la première erreur.
      socket.emit('vingtquatre-solve-refuse', { erreur: verdict.erreur });
      return;
    }
    endRound(io, room, player, verdict.formule);
  });

  // « Je passe » : ce n'est pas un abandon de partie, juste de cette donne.
  // Quand plus personne ne cherche, inutile de laisser tourner le chrono
  // devant des joueurs qui attendent — on révèle tout de suite.
  socket.on('vingtquatre-give-up', () => {
    const room = rooms.get(socket.data.vingtquatreRoom);
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(room, socket.id);
    if (!player || player.gone || player.passe || player.elimine) return;
    // Celui qui a la main ne « passe » pas : il rend la main, ce qui est déjà
    // géré (et coûte la donne, comme une explication ratée).
    if (room.claimerId === player.id) {
      echecClaim(io, room, 'abandon');
      return;
    }
    player.passe = true;
    if (chercheursActifs(room).length === 0 && !room.claimerId) {
      endRound(io, room, null);
      return;
    }
    broadcastState(io, room);
  });

  // La partie n'a pas de fin programmée (choix de conception : on enchaîne
  // les donnes tant que ça amuse). C'est l'hôte qui décide de s'arrêter, à
  // tout moment.
  socket.on('vingtquatre-end-game', () => {
    const room = rooms.get(socket.data.vingtquatreRoom);
    if (!room || (room.phase !== 'playing' && room.phase !== 'reveal')) return;
    if (socket.id !== room.hostId) return;
    finishGame(io, room);
  });

  socket.on('vingtquatre-rematch', () => {
    const room = rooms.get(socket.data.vingtquatreRoom);
    if (!room || room.phase !== 'game-end') return;
    room.phase = 'lobby';
    room.players = destinataires(room);
    if (!findPlayer(room, room.hostId)) {
      room.hostId = room.players[Math.floor(Math.random() * room.players.length)].id;
    }
    room.players.forEach((p) => {
      p.score = 0;
      p.passe = false;
      p.elimine = false;
    });
    room.roundNumber = 0;
    room.donne = null;
    room.reveal = null;
    room.claimerId = null;
    broadcastLobby(io, room);
  });

  socket.on('vingtquatre-rejoin-room', (payload) => {
    const code = ((payload && payload.code) || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('vingtquatre-rejoin-failed', { reason: likelyServerRestart() ? 'server-restarted' : 'not-found' });
      return;
    }
    const player = findPlayerByToken(room, payload && payload.token);
    if (!player || player.gone) {
      socket.emit('vingtquatre-rejoin-failed', { reason: 'not-found' });
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
    socket.data.vingtquatreRoom = code;

    if (room.phase === 'lobby') {
      broadcastLobby(io, room);
      return;
    }

    // Partie gelée faute de joueur connecté : son retour la redémarre sur une
    // donne neuve, plutôt que de le laisser devant un écran figé.
    if (room.enPause) {
      startRound(io, room);
      return;
    }

    socket.emit('vingtquatre-rejoin-ok', stateFor(room, player));
    if (wasDisconnected) {
      broadcastToRoom(io, room, 'vingtquatre-player-reconnected', { id: player.id, nickname: player.nickname });
    }
  });

  socket.on('vingtquatre-leave-room', () => handleExplicitLeave(io, socket));
  socket.on('disconnecting', () => handleDisconnecting(io, socket));
}

module.exports = {
  registerVingtquatreHandlers,
  MIN_PLAYERS,
  MAX_PLAYERS,
  ROUND_MS,
  EXPLAIN_MS,
  getStats,
  // Exportés pour la suite de tests de la couche salon
  // (vingtquatre-room-simulate.js), comme le fait skullking-room.js : la
  // machine buzzer/explication/échec ne se voit pas depuis le moteur pur.
  peutBuzzer,
  chercheursActifs,
  joueursConnectes,
  scoreboard,
  stateFor,
  demarrerClaim,
  echecClaim,
  msDonneRestant,
};
