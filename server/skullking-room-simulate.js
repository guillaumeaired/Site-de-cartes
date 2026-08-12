// Couche d'orchestration (salon Skull King) : ce que le moteur de règles pur
// (skullking-simulate.js) ne couvre pas, à savoir la logique de
// ciblage/sélection réellement exécutée pendant une partie. Voir audit Game
// Designer 2026-08-12 : les bugs de ciblage passaient inaperçus malgré une
// suite de tests moteur qui passe.
const assert = require('assert');
const { eligiblePlankTargets } = require('./skullking-room');

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

console.log(`skullking-room-simulate.js : ${n}/${n} assertions passées.`);
