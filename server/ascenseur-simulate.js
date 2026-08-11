// Script de validation autonome pour server/ascenseur.js (même principe que
// server/rami-simulate.js) : cas construits à la main, à faire passer avant
// de brancher les vrais sockets.

const {
  maxCardsFor,
  buildRoundSequence,
  dealRound,
  isValidBid,
  resolveTrick,
  computeRoundScore,
} = require('./ascenseur');

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

function card(label, suit, value) {
  return { suit, label, value };
}

// --- maxCardsFor / buildRoundSequence ---
check('max cartes à 7 joueurs', maxCardsFor(7), 7);
check('max cartes à 6 joueurs', maxCardsFor(6), 8);
check('max cartes à 5 joueurs', maxCardsFor(5), 10);
check('max cartes à 4 joueurs (division exacte)', maxCardsFor(4), 13);
check('max cartes à 3 joueurs (plafonné à 13, sinon 17)', maxCardsFor(3), 13);

check('séquence à 3 joueurs : 1..13..1 (plafonnée)', buildRoundSequence(3), [
  ...Array.from({ length: 13 }, (_, i) => i + 1),
  ...Array.from({ length: 12 }, (_, i) => 12 - i),
]);
check('séquence à 7 joueurs : longueur 13 (montée 1..7 + descente 6..1)', buildRoundSequence(7).length, 13);

// Les manches à 1 carte se jouent à l'aveugle (chacun voit la main des
// autres, pas la sienne) : la règle côté serveur ne teste que
// `cardsInRound === 1`, donc ce sont bien la première ET la dernière manche
// qui sont concernées, et elles seules.
for (const players of [3, 4, 5, 6, 7]) {
  const seq = buildRoundSequence(players);
  check(`séquence à ${players} joueurs : commence à 1 carte`, seq[0], 1);
  check(`séquence à ${players} joueurs : finit à 1 carte`, seq[seq.length - 1], 1);
  check(
    `séquence à ${players} joueurs : exactement 2 manches à l'aveugle`,
    seq.filter((n) => n === 1).length,
    2
  );
}

// --- dealRound ---
const round7 = dealRound(7, 7);
check('dealRound(7,7) : 7 cartes par joueur', round7.hands.every((h) => h.length === 7), true);
check('dealRound(7,7) : carte atout présente (49 utilisées, 3 restantes)', round7.trumpCard !== null, true);

const roundPeak4 = dealRound(4, 13);
check('dealRound(4,13) : 13 cartes par joueur (52 utilisées pile)', roundPeak4.hands.every((h) => h.length === 13), true);
check('dealRound(4,13) : sans atout (paquet épuisé pile)', roundPeak4.trumpCard, null);
check('dealRound(4,13) : trumpSuit null aussi', roundPeak4.trumpSuit, null);

// --- isValidBid ---
check('annonce valide pour un joueur non-dernier (0 à n libre)', isValidBid(3, 5, 0, false), true);
check('annonce invalide si > nb de plis', isValidBid(6, 5, 0, false), false);
check('annonce invalide si négative', isValidBid(-1, 5, 0, false), false);
check(
  'dernier joueur : interdiction si la somme totale égalerait le nb de plis',
  isValidBid(2, 5, 3, true),
  false
);
check('dernier joueur : autorisé si la somme totale diffère du nb de plis', isValidBid(3, 5, 3, true), true);
check(
  'manche à 1 pli, dernier joueur forcé (les autres ont déjà annoncé 1) : 0 interdit',
  isValidBid(0, 1, 1, true),
  false
);
check(
  'manche à 1 pli, dernier joueur forcé (les autres ont déjà annoncé 1) : 1 autorisé',
  isValidBid(1, 1, 1, true),
  true
);

// --- resolveTrick ---
check(
  'pli gagné par la plus haute carte de la couleur demandée (pas d\'atout joué)',
  resolveTrick([card('8', 'pique', 8), card('R', 'pique', 13), card('3', 'pique', 3)], 'pique', 'coeur'),
  1
);
check(
  'pli gagné par le seul atout joué, même faible',
  resolveTrick([card('A', 'pique', 14), card('2', 'coeur', 2), card('R', 'pique', 13)], 'pique', 'coeur'),
  1
);
check(
  'pli gagné par le plus haut atout quand plusieurs atouts joués',
  resolveTrick([card('2', 'coeur', 2), card('9', 'pique', 9), card('R', 'coeur', 13)], 'pique', 'coeur'),
  2
);
check(
  'carte hors-couleur (ni demandée ni atout) ne peut pas gagner malgré une valeur plus haute',
  resolveTrick([card('7', 'trefle', 7), card('A', 'carreau', 14), card('9', 'trefle', 9)], 'trefle', 'pique'),
  2
);

// --- computeRoundScore ---
check('contrat 0 réussi, manche 1', computeRoundScore(0, 0, 1), 5);
check('contrat 0 réussi, manche 3', computeRoundScore(0, 0, 3), 15);
check('contrat 0 raté (1 pli pris), manche 2', computeRoundScore(0, 1, 2), -10);
check('contrat 3 réussi exactement', computeRoundScore(3, 3, 7), 30);
check('contrat 2 raté, fait 5 (écart 3)', computeRoundScore(2, 5, 7), -30);
check('contrat 2 raté, fait 0 (écart 2)', computeRoundScore(2, 0, 7), -20);

console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
process.exit(failed > 0 ? 1 : 0);
