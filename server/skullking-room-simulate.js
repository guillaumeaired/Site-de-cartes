// Couche d'orchestration (salon Skull King) : ce que le moteur de règles pur
// (skullking-simulate.js) ne couvre pas, à savoir la logique de
// ciblage/sélection réellement exécutée pendant une partie. Voir audit Game
// Designer 2026-08-12 : les bugs de ciblage passaient inaperçus malgré une
// suite de tests moteur qui passe.
const assert = require('assert');
const { eligiblePlankTargets, capturedPirateKeys, stateFor } = require('./skullking-room');

let n = 0;
function check(label, actual, expected) {
  n += 1;
  assert.deepStrictEqual(actual, expected, `${label}\nattendu: ${JSON.stringify(expected)}\nreçu: ${JSON.stringify(actual)}`);
}

const pirateCard = { id: 'c1', kind: 'pirate', name: "Rosie D'Laney" };
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

// --- Skull King (et Mat le Forban) mangent des Pirates : héritage des
// pouvoirs, quel que soit qui a effectivement remporté le pli.
const rosieCard = { id: 'p1', kind: 'pirate', name: "Rosie D'Laney" };
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

// --- Secret de la Tigresse : chosenAs ne doit jamais fuiter aux autres
// joueurs dans l'état envoyé, seulement à celle ou celui qui l'a posée.
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
    sittingOutId: null,
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

const seenByOther = stateFor(makeRoom(trickWithTigress), { id: 'p2', hand: [] });
const otherView = seenByOther.currentTrick.find((t) => t.card.id === 'c1').card;
check('chosenAs est absent pour un autre joueur', Object.prototype.hasOwnProperty.call(otherView, 'chosenAs'), false);
check('le reste de la carte Tigresse reste intact pour un autre joueur', otherView.kind, 'tigress');

// --- Manche 1 : chacun voit les cartes des autres, jamais la sienne, tant
// qu'on est en phase d'annonce.
function makeBiddingRoom() {
  const p1 = { ...makePlayer('p1', 'Alice'), hand: [{ id: 'h1', kind: 'number', suit: 'vert', value: 9 }] };
  const p2 = { ...makePlayer('p2', 'Bob'), hand: [{ id: 'h2', kind: 'pirate', name: "Rosie D'Laney" }] };
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
    ['p2', 'pirate', "Rosie D'Laney"],
    ['p3', 'skullking', undefined],
  ]
);

const round1PlayingRoom = { ...makeBiddingRoom(), phase: 'playing', bids: { p1: 0, p2: 0, p3: 0 }, turnCount: 0 };
const playingView = stateFor(round1PlayingRoom, { id: 'p1', hand: [{ id: 'h1', kind: 'number', suit: 'vert', value: 9 }] });
check('une fois la phase de jeu entamée, ma carte redevient visible pour moi', playingView.hand[0].kind, 'number');
check(
  'et je ne vois plus les cartes des autres via revealedCard (redevenu normal)',
  playingView.players.every((p) => p.revealedCard === undefined),
  true
);

console.log(`skullking-room-simulate.js : ${n}/${n} assertions passées.`);
