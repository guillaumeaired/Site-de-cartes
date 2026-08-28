// Couche d'orchestration (salon Skull King) : ce que le moteur de règles pur
// (skullking-simulate.js) ne couvre pas, à savoir la logique de
// ciblage/sélection réellement exécutée pendant une partie. Voir audit Game
// Designer 2026-08-12 : les bugs de ciblage passaient inaperçus malgré une
// suite de tests moteur qui passe.
const assert = require('assert');
const { eligiblePlankTargets, demanderCiblePlanche, validerCiblePlanche, activeOrderThisTrick, capturedPirateKeys, devoreesParLeVainqueur, plankedCardIds, powerResultMessage, stateFor, PACE_SETTINGS, PACE_PRESETS, paceOf, paceMs, pacePresetOf } = require('./skullking-room');

let n = 0;
function check(label, actual, expected) {
  n += 1;
  assert.deepStrictEqual(actual, expected, `${label}\nattendu: ${JSON.stringify(expected)}\nreçu: ${JSON.stringify(actual)}`);
}

const pirateCard = { id: 'c1', kind: 'pirate', name: "Rosie la Douce" };
const tigressAsPirate = { id: 'c2', kind: 'tigress', chosenAs: 'pirate' };
const tigressAsEscape = { id: 'c3', kind: 'tigress', chosenAs: 'escape' };
const numberCard = { id: 'c4', kind: 'number', suit: 'vert', value: 7 };
const firstMateCard = { id: 'c5', kind: 'firstmate' };

check(
  'un vrai Pirate est ciblable',
  eligiblePlankTargets([{ playerId: 'p1', card: pirateCard }]).map((t) => t.card.id),
  ['c1']
);

check(
  "une Tigresse jouée comme Pirate est ciblable (bug corrigé)",
  eligiblePlankTargets([{ playerId: 'p1', card: tigressAsPirate }]).map((t) => t.card.id),
  ['c2']
);

check(
  "une Tigresse jouée comme Fuite n'est pas ciblable",
  eligiblePlankTargets([{ playerId: 'p1', card: tigressAsEscape }]).map((t) => t.card.id),
  []
);

check(
  "Mat le Forban n'est pas ciblable (n'est pas un vrai Pirate)",
  eligiblePlankTargets([{ playerId: 'p1', card: firstMateCard }]).map((t) => t.card.id),
  []
);

check(
  'mélange : seuls les Pirates (bruts ou Tigresse-Pirate) ressortent',
  eligiblePlankTargets([
    { playerId: 'p1', card: numberCard },
    { playerId: 'p2', card: pirateCard },
    { playerId: 'p3', card: tigressAsPirate },
    { playerId: 'p4', card: firstMateCard },
  ]).map((t) => t.card.id),
  ['c1', 'c2']
);

// --- Marcher sur la Planche : ce que l'écran doit montrer tomber. Le
// calcul retirait bien le Pirate du pli, mais rien ne le disait à l'écran —
// ces ids sont ce qui manquait.
{
  const cible = { id: 'c-pirate', kind: 'pirate', name: 'Will le Bandit' };
  const planche = { id: 'c-planche', kind: 'plank', removesId: 'c-pirate' };

  check(
    'Planche : le Pirate ciblé est celui qui passe par-dessus bord',
    plankedCardIds([cible, planche, numberCard]),
    ['c-pirate']
  );

  check(
    "Planche sans cible (aucun Pirate au moment de la pose) : rien ne tombe",
    plankedCardIds([{ id: 'c-planche2', kind: 'plank' }, numberCard]),
    []
  );

  check(
    "Planche dont la cible n'est pas dans le pli : rien ne tombe, comme dans resolveTrick",
    plankedCardIds([{ id: 'c-planche3', kind: 'plank', removesId: 'absent' }, cible]),
    []
  );

  check(
    'Planche : une Tigresse jouée comme Pirate tombe aussi',
    plankedCardIds([tigressAsPirate, { id: 'c-planche4', kind: 'plank', removesId: 'c2' }]),
    ['c2']
  );

  // Le pli détruit par un Kraken n'annule pas la Planche : le Pirate a été
  // retiré avant, et l'écran doit le montrer tomber quand même.
  check(
    'Planche : la chute se joue même si le Kraken détruit le pli',
    plankedCardIds([cible, planche, { id: 'c-kraken', kind: 'kraken' }]),
    ['c-pirate']
  );
}

// --- Skull King (et Mat le Forban) mangent des Pirates : héritage des
// pouvoirs, quel que soit qui a effectivement remporté le pli.
const rosieCard = { id: 'p1', kind: 'pirate', name: "Rosie la Douce" };
const willCard = { id: 'p2', kind: 'pirate', name: 'Will le Bandit' };
const noPowerPirate = { id: 'p3', kind: 'pirate', name: 'Personne Connue' };

check(
  'un seul Pirate capturé : son pouvoir, seul',
  capturedPirateKeys([{ playerId: 'x', card: rosieCard }], new Set(), false),
  ['rosie']
);

check(
  'plusieurs Pirates capturés : tous les pouvoirs, dans l\'ordre du pli',
  capturedPirateKeys(
    [
      { playerId: 'x', card: rosieCard },
      { playerId: 'y', card: willCard },
    ],
    new Set(),
    false
  ),
  ['rosie', 'will']
);

check(
  'un Pirate retiré par la Planche (excludedIdx) ne transmet pas son pouvoir',
  capturedPirateKeys(
    [
      { playerId: 'x', card: rosieCard },
      { playerId: 'y', card: willCard },
    ],
    new Set([0]),
    false
  ),
  ['will']
);

check(
  "sur le dernier pli de la manche, seul Harry le Géant survit",
  capturedPirateKeys(
    [
      { playerId: 'x', card: rosieCard },
      { playerId: 'y', card: { id: 'p4', kind: 'pirate', name: 'Harry le Géant' } },
    ],
    new Set(),
    true
  ),
  ['harry']
);

check(
  'un Pirate sans pouvoir connu (nom absent de PIRATE_POWER_BY_NAME) ne transmet rien',
  capturedPirateKeys([{ playerId: 'x', card: noPowerPirate }], new Set(), false),
  []
);

check(
  'une Tigresse jouée comme Pirate ne transmet pas de pouvoir (pas de nom)',
  capturedPirateKeys([{ playerId: 'x', card: tigressAsPirate }], new Set(), false),
  []
);

// --- L'annonce de la Tigresse : chosenAs part vers TOUS les joueurs dès que
// la carte est posée. C'est la seule carte du jeu qui change de nature en se
// posant, et ce que l'état envoie décide de ce que l'écran peut montrer.
function makePlayer(id, nickname) {
  return { id, nickname, connected: true, hand: [], tricksWon: 0, totalScore: 0, roundHistory: [] };
}

function makeRoom(currentTrick) {
  const players = [makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob'), makePlayer('p3', 'Chloé')];
  return {
    phase: 'playing',
    hostId: 'p1',
    players,
    bids: { p1: 1, p2: 1, p3: 1 },
    dealerIndex: 0,
    leaderIndex: 0,
    roundSequence: [1, 2, 3],
    roundIndex: 0,
    cardsInRound: 3,
    extensionEnabled: false,
    currentTrick,
    turnCount: currentTrick.length,
    sittingOutIds: new Set(),
    extraCardOwedBy: null,
    trickPaused: false,
    lastTrickResult: null,
    forcedPlays: {},
    pendingPower: null,
  };
}

const trickWithTigress = [
  { playerId: 'p1', card: { id: 'c1', kind: 'tigress', chosenAs: 'pirate' } },
  { playerId: 'p2', card: { id: 'c2', kind: 'number', suit: 'vert', value: 5 } },
];

const seenByOwner = stateFor(makeRoom(trickWithTigress), { id: 'p1', hand: [] });
check(
  'la Tigresse voit son propre chosenAs dans son propre état',
  seenByOwner.currentTrick.find((t) => t.card.id === 'c1').card.chosenAs,
  'pirate'
);

// Le choix s'annonce EN SE POSANT, comme dans la règle officielle : les
// autres joueurs le voient tout de suite, sans attendre la résolution. Il a
// été caché un temps — plus tendu, mais faux, et surtout injouable : les
// joueurs suivants ne savaient pas si le pli était pris ou abandonné au
// moment de choisir leur propre carte.
const seenByOther = stateFor(makeRoom(trickWithTigress), { id: 'p2', hand: [] });
const otherView = seenByOther.currentTrick.find((t) => t.card.id === 'c1').card;
check('un autre joueur voit le choix de la Tigresse dès la pose', otherView.chosenAs, 'pirate');
check('le reste de la carte Tigresse reste intact pour un autre joueur', otherView.kind, 'tigress');

const pausedRoom = { ...makeRoom(trickWithTigress), trickPaused: true };
const otherViewPaused = stateFor(pausedRoom, { id: 'p2', hand: [] }).currentTrick.find((t) => t.card.id === 'c1').card;
check(
  'et il le voit toujours une fois le pli résolu',
  otherViewPaused.chosenAs,
  'pirate'
);
check(
  'et la carte reste bien une Tigresse une fois révélée',
  otherViewPaused.kind,
  'tigress'
);

// --- Manche 1 : chacun voit les cartes des autres, jamais la sienne, tant
// qu'on est en phase d'annonce.
function makeBiddingRoom() {
  const p1 = { ...makePlayer('p1', 'Alice'), hand: [{ id: 'h1', kind: 'number', suit: 'vert', value: 9 }] };
  const p2 = { ...makePlayer('p2', 'Bob'), hand: [{ id: 'h2', kind: 'pirate', name: "Rosie la Douce" }] };
  const p3 = { ...makePlayer('p3', 'Chloé'), hand: [{ id: 'h3', kind: 'skullking' }] };
  return {
    phase: 'bidding',
    hostId: 'p1',
    players: [p1, p2, p3],
    bids: {},
    dealerIndex: 0,
    leaderIndex: 1,
    roundSequence: [1, 2, 3],
    roundIndex: 0,
    cardsInRound: 1,
    extensionEnabled: false,
    currentTrick: [],
  };
}

const round1View = stateFor(makeBiddingRoom(), { id: 'p1', hand: [{ id: 'h1', kind: 'number', suit: 'vert', value: 9 }] });
check('manche 1 : ma propre carte est cachée (kind hidden, même id)', round1View.hand, [{ id: 'h1', kind: 'hidden' }]);
check(
  'manche 1 : je vois la carte des autres joueurs',
  round1View.players.map((p) => [p.id, p.revealedCard && p.revealedCard.kind, p.revealedCard && p.revealedCard.name]),
  [
    ['p1', undefined, undefined],
    ['p2', 'pirate', "Rosie la Douce"],
    ['p3', 'skullking', undefined],
  ]
);

const round1PlayingRoom = { ...makeBiddingRoom(), phase: 'playing', bids: { p1: 0, p2: 0, p3: 0 }, turnCount: 0 };
const playingView = stateFor(round1PlayingRoom, { id: 'p1', hand: [{ id: 'h1', kind: 'number', suit: 'vert', value: 9 }] });
check('une fois la phase de jeu entamée, ma carte redevient visible pour moi', playingView.hand[0].kind, 'number');
// Les cartes tenues ne sont envoyées QUE pendant l'annonce. Elles l'étaient
// aussi pendant le jeu, tant que leur porteur ne les avait pas posées : rien
// de neuf n'était révélé — tout le monde les avait vues — mais le tapis
// portait alors pêle-mêle ce qui était tombé et ce qui ne l'était pas, alors
// que dans toute autre manche il ne porte que le pli. On lit un tour de table
// en comptant les cartes, pas en cherchant une marque sur chacune.
check(
  'phase de jeu : plus aucune carte tenue, le tapis ne porte que le pli',
  playingView.players.map((p) => p.revealedCard && p.revealedCard.kind),
  [undefined, undefined, undefined]
);
// La condition porte sur le nombre de CARTES et non sur le numéro de manche :
// c'est d'en avoir une seule, tenue face aux autres, qui met les cartes sur le
// tapis avant qu'elles soient jouées. Les deux ne se séparent qu'en mode
// essai, où prendre la première carte d'une main de dix pour « la carte
// tenue » n'aurait aucun sens.
const manche1ADeuxCartes = { ...makeBiddingRoom(), cardsInRound: 2 };
check(
  'manche 1 à deux cartes (mode essai) : rien n\'est tenu, donc rien n\'est montré',
  stateFor(manche1ADeuxCartes, { id: 'p1', hand: [] }).players.map((p) => p.revealedCard),
  [undefined, undefined, undefined]
);

// --- Annonces des pouvoirs de Pirates ---
// Un pouvoir qui pèse sur la suite de la manche doit être annoncé à toute la
// table ; ceux qui ne changent rien de visible pour les autres (Will remanie
// sa propre main, Juanita ne fait que regarder) ne doivent rien envoyer.
function makePowerRoom(pending, extra) {
  return {
    players: [
      { id: 'p1', nickname: 'Guillaume', rascalStake: 0 },
      { id: 'p2', nickname: 'Barbe-Rousse', rascalStake: 20 },
    ],
    bids: { p1: 2, p2: 3 },
    pendingPower: pending,
    ...extra,
  };
}

check(
  "Will le Bandit n'envoie aucune annonce",
  powerResultMessage(makePowerRoom({ kind: 'will', playerId: 'p1' })),
  null
);
check(
  "Juanita Jade n'envoie aucune annonce",
  powerResultMessage(makePowerRoom({ kind: 'juanita', playerId: 'p1' })),
  null
);
check(
  'Rosie annonce qui mènera le prochain pli',
  powerResultMessage(makePowerRoom({ kind: 'rosie', playerId: 'p1', leaderId: 'p2' })),
  { title: "Rosie la Douce", detail: 'Guillaume désigne Barbe-Rousse pour mener le prochain pli.' }
);
check(
  'Rosie qui se désigne elle-même le dit sans répéter le pseudo',
  powerResultMessage(makePowerRoom({ kind: 'rosie', playerId: 'p1', leaderId: 'p1' })).detail,
  'Guillaume désigne soi-même pour mener le prochain pli.'
);
check(
  'Rascal annonce sa mise supplémentaire',
  powerResultMessage(makePowerRoom({ kind: 'rascal', playerId: 'p2' })),
  { title: 'Rascal le Flambeur', detail: 'Barbe-Rousse mise 20 points de plus sur sa propre annonce.' }
);
check(
  'Rascal qui ne mise rien le dit quand même',
  powerResultMessage(makePowerRoom({ kind: 'rascal', playerId: 'p1' })).detail,
  "Guillaume ne mise rien de plus cette manche."
);
check(
  'Harry qui monte son annonce dit d\'où elle vient et où elle va',
  powerResultMessage(makePowerRoom({ kind: 'harry', playerId: 'p1', harryDelta: 1 })),
  { title: 'Harry le Géant', detail: "Guillaume monte son annonce d'un pli : 1 → 2." }
);
check(
  'Harry qui descend son annonce',
  powerResultMessage(makePowerRoom({ kind: 'harry', playerId: 'p1', harryDelta: -1 })).detail,
  "Guillaume descend son annonce d'un pli : 3 → 2."
);
check(
  'Harry qui ne bouge pas ne dit PAS qu\'il modifie quelque chose',
  powerResultMessage(makePowerRoom({ kind: 'harry', playerId: 'p1', harryDelta: 0 })).detail,
  'Guillaume ne bouge pas son annonce : elle reste à 2.'
);
check(
  'Harry sans réponse (minuteur expiré) : même message que « ne pas changer »',
  powerResultMessage(makePowerRoom({ kind: 'harry', playerId: 'p1' })).detail,
  'Guillaume ne bouge pas son annonce : elle reste à 2.'
);
check(
  'Mary Thorne annonce à qui elle prend une carte',
  powerResultMessage(makePowerRoom({ kind: 'marythorne', playerId: 'p1', marythorneTargetId: 'p2' })).detail,
  'Guillaume tire une carte au hasard dans la main de Barbe-Rousse, à jouer obligatoirement au pli suivant.'
);

// --- Pirates dévorés par le Skull King (animation) ---
const sk = { id: 'sk', kind: 'skullking' };
const rosie = { id: 'r1', kind: 'pirate', name: "Rosie la Douce" };
const harry = { id: 'r2', kind: 'pirate', name: 'Harry le Géant' };
const num = { id: 'n1', kind: 'number', suit: 'vert', value: 9 };
const forban = { id: 'f1', kind: 'firstmate' };
const tigressePirate = { id: 't1', kind: 'tigress', chosenAs: 'pirate' };
const tigresseFuite = { id: 't2', kind: 'tigress', chosenAs: 'escape' };
const win = (idx, extra) => ({ destroyed: false, winnerIdx: idx, excludedIdx: new Set(), ...extra });

const sirene = { id: 's1', kind: 'siren' };
const sirene2 = { id: 's2', kind: 'siren' };

// Qui dévore, et quoi. On vérifie les deux : la carte qui mange, et la liste
// de celles qu'elle emporte.
const devore = (cards, result) => {
  const r = devoreesParLeVainqueur(cards, result);
  return [r.devoreurId, r.ids];
};

check(
  'le Skull King dévore les deux Pirates du pli',
  devore([sk, rosie, harry, num], win(0)),
  ['sk', ['r1', 'r2']]
);
check(
  'une Tigresse annoncée en Pirate est dévorée elle aussi',
  devore([sk, tigressePirate], win(0)),
  ['sk', ['t1']]
);
check(
  "une Tigresse annoncée en Fuite n'est pas dévorée",
  devore([sk, tigresseFuite], win(0)),
  [null, []]
);
check(
  'le Skull King dévore AUSSI Mat le Forban : il le capture comme un Pirate (+30)',
  devore([sk, forban, rosie], win(0)),
  ['sk', ['f1', 'r1']]
);
check(
  'un Pirate retiré par la Planche n\'est plus là pour être mangé',
  devore([sk, rosie, harry], win(0, { excludedIdx: new Set([1]) })),
  ['sk', ['r2']]
);

// --- Un Pirate dévore les Sirènes -------------------------------------
check(
  'le Pirate qui remporte le pli avale les deux Sirènes',
  devore([rosie, sirene, sirene2, num], win(0)),
  ['r1', ['s1', 's2']]
);
check(
  "c'est le PREMIER Pirate joué qui gagne, donc lui qui avale",
  devore([sirene, rosie, harry], win(1)),
  ['r1', ['s1']]
);
check(
  'une Tigresse annoncée en Pirate avale la Sirène comme un Pirate',
  devore([tigressePirate, sirene], win(0)),
  ['t1', ['s1']]
);
check(
  "rien à dévorer pour un Pirate qui n'a battu que des numérotées",
  devore([rosie, num], win(0)),
  [null, []]
);

// --- Une Sirène emporte le Skull King ---------------------------------
check(
  'la Sirène qui bat le Skull King l\'emporte avec elle',
  devore([sk, sirene], win(1)),
  ['s1', ['sk']]
);
check(
  'la Sirène emporte aussi Mat le Forban, qu\'elle bat',
  devore([forban, sirene], win(1)),
  ['s1', ['f1']]
);
check(
  'boucle à trois : la Sirène emporte le Skull King, PAS le Pirate qu\'elle ne bat pas',
  devore([rosie, sk, sirene], win(2)),
  ['s1', ['sk']]
);

// --- Mat le Forban rafle les Pirates ----------------------------------
check(
  'Mat le Forban avale tous les Pirates du pli',
  devore([rosie, harry, forban], win(2)),
  ['f1', ['r1', 'r2']]
);

// --- Rien du tout -----------------------------------------------------
check(
  'rien à dévorer si le pli est détruit (Kraken)',
  devore([sk, rosie], { destroyed: true, winnerIdx: null, excludedIdx: new Set() }),
  [null, []]
);
check(
  'rien à dévorer quand une numérotée remporte le pli',
  devore([num, { id: 'n2', kind: 'number', suit: 'vert', value: 3 }], win(0)),
  [null, []]
);

// --- MARCHER SUR LA PLANCHE : LA CIBLE SE DÉSIGNE À LA FIN DU PLI ------
//
// Le livret : « must remove one standard Pirate AT THE END OF THE TRICK ».
// On ciblait au moment de la pose, sur le pli en cours : une Planche jouée
// avant le Pirate ne retirait personne, et le pouvoir avait l'air de ne pas
// marcher une fois sur deux. C'est ce que ces tests tiennent.
const ioMuet = { to: () => ({ emit: () => {} }) };

function roomAvecPli(plis) {
  const room = makeRoom(plis);
  room.code = 'TEST';
  room.trickNumber = 1;
  room.players = [...new Set(plis.map((t) => t.playerId))].map((id) => ({
    ...makePlayer(id, id),
    pendingBonus: 0,
  }));
  room.lootAlliances = [];
  return room;
}

// Le pli est joué dans l'ordre du tableau : la Planche en PREMIER, le Pirate
// après. C'est exactement le cas qui ne retirait rien.
const pliPlanchePuisPirate = roomAvecPli([
  { playerId: 'p1', card: { id: 'pl', kind: 'plank' } },
  { playerId: 'p2', card: { id: 'r1', kind: 'pirate', name: 'Harry le Géant' } },
]);
check(
  'une Planche posée AVANT le Pirate le cible quand même (rien à choisir)',
  demanderCiblePlanche(ioMuet, pliPlanchePuisPirate),
  false
);
check(
  'et le Pirate est bien désigné',
  pliPlanchePuisPirate.currentTrick[0].card.removesId,
  'r1'
);

const pliDeuxPirates = roomAvecPli([
  { playerId: 'p1', card: { id: 'pl', kind: 'plank' } },
  { playerId: 'p2', card: { id: 'r1', kind: 'pirate', name: 'Harry le Géant' } },
  { playerId: 'p3', card: { id: 'r2', kind: 'pirate', name: 'Rosie la Douce' } },
]);
check(
  'deux Pirates : le pli attend que le joueur de la Planche désigne',
  demanderCiblePlanche(ioMuet, pliDeuxPirates),
  true
);
check('la phase passe en pouvoir', pliDeuxPirates.phase, 'power');
check('et c\'est au joueur de la Planche de répondre', [
  pliDeuxPirates.pendingPower.kind,
  pliDeuxPirates.pendingPower.playerId,
  pliDeuxPirates.pendingPower.plankTargetIds,
], ['plank', 'p1', ['r1', 'r2']]);
clearTimeout(pliDeuxPirates.powerTimer);
clearTimeout(pliDeuxPirates.inactivityTimer);

// Et la réponse résout le pli : le Pirate désigné passe par-dessus bord,
// l'autre remporte le pli. C'est le bout de la chaîne — le calcul retirait
// déjà la cible (resolveTrick), encore fallait-il qu'une cible soit posée.
validerCiblePlanche(ioMuet, pliDeuxPirates, 'r1');
check('la Planche retient la cible désignée', pliDeuxPirates.currentTrick[0].card.removesId, 'r1');
check('le pli repart en phase de jeu', pliDeuxPirates.phase, 'playing');
check('le Pirate désigné tombe à l\'eau', pliDeuxPirates.lastTrickResult.plankedCardIds, ['r1']);
check("et c'est l'autre Pirate qui remporte le pli", pliDeuxPirates.lastTrickResult.winnerId, 'p3');
clearTimeout(pliDeuxPirates.trickTimer);
clearTimeout(pliDeuxPirates.inactivityTimer);

// Une Tigresse annoncée en Fuite n'est pas un Pirate : elle ne compte pas
// dans les cibles, et ne doit donc pas déclencher un choix qui n'en est pas
// un (le cadre s'ouvrait pour elle, et le serveur refusait ensuite la pose).
const pliTigresseFuite = roomAvecPli([
  { playerId: 'p1', card: { id: 'pl', kind: 'plank' } },
  { playerId: 'p2', card: { id: 'r1', kind: 'pirate', name: 'Harry le Géant' } },
  { playerId: 'p3', card: { id: 't1', kind: 'tigress', chosenAs: 'escape' } },
]);
check(
  "une Tigresse en Fuite n'est pas une cible : aucun choix à poser",
  demanderCiblePlanche(ioMuet, pliTigresseFuite),
  false
);
check('le seul vrai Pirate est désigné', pliTigresseFuite.currentTrick[0].card.removesId, 'r1');
clearTimeout(pliTigresseFuite.inactivityTimer);

const pliSansPirate = roomAvecPli([
  { playerId: 'p1', card: { id: 'pl', kind: 'plank' } },
  { playerId: 'p2', card: { id: 'n9', kind: 'number', suit: 'vert', value: 9 } },
]);
check('aucun Pirate : la Planche ne retire rien', demanderCiblePlanche(ioMuet, pliSansPirate), false);
check('et ne désigne personne', pliSansPirate.currentTrick[0].card.removesId, undefined);
clearTimeout(pliSansPirate.inactivityTimer);

// --- LE RYTHME DE LA PARTIE : ce que le salon a le droit de régler -----
//
// Cinq durées réglables par l'hôte, donc cinq valeurs qui arrivent par le
// réseau. Tout l'enjeu est là : une valeur hors liste ne doit jamais devenir
// un délai réel, et un salon qui n'a rien réglé (ou qui date d'avant ces
// réglages) doit se jouer exactement comme avant.

check(
  'un salon sans rien de réglé retombe sur les durées d\'origine',
  paceOf({}),
  Object.fromEntries(PACE_SETTINGS.map((r) => [r.key, r.default]))
);

check(
  "les durées d'origine sont exactement l'allure « Normal »",
  paceOf({}),
  PACE_PRESETS.find((p) => p.key === 'normal').values
);

check(
  'une valeur hors liste est ignorée au profit de la durée d\'origine',
  paceMs({ pace: { juanita: 3 } }, 'juanita'),
  PACE_SETTINGS.find((r) => r.key === 'juanita').default
);

check(
  'une valeur bricolée ne contamine pas les autres réglages',
  paceMs({ pace: { juanita: 999_999, trick: 4_000 } }, 'trick'),
  4_000
);

check(
  '« Jamais » (0) est une vraie valeur du rappel d\'inactivité, pas un trou',
  paceMs({ pace: { inactivity: 0 } }, 'inactivity'),
  0
);

check(
  "l'allure se reconnaît quand les cinq durées correspondent",
  pacePresetOf({ pace: PACE_PRESETS.find((p) => p.key === 'vif').values }),
  'vif'
);

check(
  "et aucune n'est désignée dès qu'une seule durée sort du lot",
  pacePresetOf({ pace: { ...PACE_PRESETS.find((p) => p.key === 'vif').values, juanita: 90_000 } }),
  null
);

// Chaque allure doit rester composée de valeurs réellement proposées : sans
// ça, un préréglage poserait une durée que paceOf refuserait de relire, et le
// bouton s'allumerait sur une valeur qui ne s'applique pas.
PACE_PRESETS.forEach((preset) => {
  check(
    `l'allure « ${preset.label} » n'utilise que des valeurs proposées`,
    paceOf({ pace: preset.values }),
    preset.values
  );
});

console.log(`skullking-room-simulate.js : ${n}/${n} assertions passées.`);
