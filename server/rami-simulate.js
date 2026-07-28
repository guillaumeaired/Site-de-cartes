// Script de validation autonome pour server/rami.js : cas construits à la
// main, à faire passer avant de brancher les vrais sockets (même principe
// que server/simulate.js pour la Bataille).

const {
  createDeck,
  dealHands,
  isValidSet,
  isValidSequence,
  meldPoints,
  handCardValue,
  canInitialMeld,
} = require('./rami');

let uid = 0;
function c(rank, suit) {
  return { id: `t${uid++}`, rank, suit, isJoker: false };
}
function j() {
  return { id: `t${uid++}`, isJoker: true };
}

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(`ÉCHEC — ${label} : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
  }
}

// --- Deck & distribution (1 jeu pour 2 joueurs, 2 de cœur = Joker) ---
const deck = createDeck();
check('createDeck : 52 cartes (1 jeu)', deck.length, 52);
check('createDeck : 1 Joker (le 2 de cœur)', deck.filter((card) => card.isJoker).length, 1);
check(
  'createDeck : le Joker est bien le 2 de cœur',
  deck.find((card) => card.isJoker),
  { id: 'c0', rank: '2', suit: 'coeur', isJoker: true }
);
check('createDeck : 4 As', deck.filter((card) => card.rank === 'A').length, 4);
check('createDeck(2) : 104 cartes, 2 Jokers', createDeck(2).filter((card) => card.isJoker).length, 2);

const { hands, drawPile } = dealHands(2);
check('dealHands(2) : 7 cartes au 1er joueur', hands[0].length, 7);
check('dealHands(2) : 7 cartes au 2e joueur', hands[1].length, 7);
check('dealHands(2) : pioche restante', drawPile.length, 52 - 7 - 7);

// --- isValidSet ---
check('set valide (brelan couleurs différentes)', isValidSet([c('7', 'coeur'), c('7', 'carreau'), c('7', 'pique')]), true);
check('set invalide (couleur dupliquée)', isValidSet([c('7', 'coeur'), c('7', 'coeur'), c('7', 'pique')]), false);
check('set valide avec 1 Joker', isValidSet([c('7', 'coeur'), c('7', 'carreau'), j()]), true);
check('set invalide avec 2 Jokers', isValidSet([c('7', 'coeur'), j(), j()]), false);
check('set invalide (rangs différents)', isValidSet([c('7', 'coeur'), c('8', 'carreau'), c('9', 'pique')]), false);

// --- isValidSequence ---
check('séquence As bas (A-2-3)', isValidSequence([c('A', 'coeur'), c('2', 'coeur'), c('3', 'coeur')]), true);
check('séquence As haut (D-R-A)', isValidSequence([c('D', 'pique'), c('R', 'pique'), c('A', 'pique')]), true);
check('séquence avec Joker au milieu (5-Jk-7)', isValidSequence([c('5', 'trefle'), j(), c('7', 'trefle')]), true);
check('séquence avec Joker en bout (5-6-Jk)', isValidSequence([c('5', 'trefle'), c('6', 'trefle'), j()]), true);
check('séquence invalide (2 Jokers)', isValidSequence([c('5', 'trefle'), j(), j(), c('8', 'trefle')]), false);
check('séquence invalide (couleurs mélangées)', isValidSequence([c('5', 'trefle'), c('6', 'coeur'), c('7', 'trefle')]), false);
check('séquence valide (tour R-A-2, rangs en cercle)', isValidSequence([c('R', 'pique'), c('A', 'pique'), c('2', 'pique')]), true);
check('séquence invalide (rangs trop espacés, même en cercle)', isValidSequence([c('5', 'trefle'), c('8', 'trefle'), c('V', 'trefle')]), false);
check('valeur séquence R-A-2 (10+15+2)', meldPoints([c('R', 'pique'), c('A', 'pique'), c('2', 'pique')], 'sequence'), 27);
check('séquence invalide (moins de 3 cartes)', isValidSequence([c('5', 'trefle'), c('6', 'trefle')]), false);

// --- meldPoints (As = 15 points fixes) ---
check('valeur séquence As bas (15+2+3)', meldPoints([c('A', 'coeur'), c('2', 'coeur'), c('3', 'coeur')], 'sequence'), 20);
check('valeur séquence As haut (10+10+15)', meldPoints([c('D', 'pique'), c('R', 'pique'), c('A', 'pique')], 'sequence'), 35);
check('valeur set de 7 avec Joker (7x3)', meldPoints([c('7', 'coeur'), c('7', 'carreau'), j()], 'set'), 21);
check('valeur set de As (15x3)', meldPoints([c('A', 'coeur'), c('A', 'carreau'), c('A', 'pique')], 'set'), 45);

// --- handCardValue (cartes restées en main en fin de partie) ---
check('valeur en main : As = 15', handCardValue(c('A', 'coeur')), 15);
check('valeur en main : Roi = 10', handCardValue(c('R', 'coeur')), 10);
check('valeur en main : 7 = 7', handCardValue(c('7', 'coeur')), 7);
check('valeur en main : Joker (2 de cœur) = 25', handCardValue(j()), 25);

// --- canInitialMeld (contrat des 30 points, sans Joker) ---
check(
  'contrat refusé sous 30 pts',
  canInitialMeld([[c('7', 'coeur'), c('7', 'carreau'), c('7', 'pique')]]),
  false
);
check(
  'contrat accepté (>=30 pts, sans Joker)',
  canInitialMeld([[c('8', 'pique'), c('9', 'pique'), c('10', 'pique'), c('V', 'pique'), c('D', 'pique')]]),
  true
);
check(
  'contrat refusé si une combinaison contient le Joker',
  canInitialMeld([
    [c('5', 'trefle'), j(), c('7', 'trefle')],
    [c('R', 'coeur'), c('R', 'carreau'), c('R', 'pique')],
  ]),
  false
);
check(
  'contrat invalide si une combinaison est mal formée',
  canInitialMeld([
    [c('8', 'pique'), c('9', 'pique'), c('10', 'pique'), c('V', 'pique'), c('D', 'pique')],
    [c('7', 'trefle'), c('8', 'pique'), c('9', 'carreau')],
  ]),
  false
);

console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
process.exit(failed > 0 ? 1 : 0);
