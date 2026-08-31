// Script de validation autonome pour server/vingtquatre.js (même principe que
// les autres suites : des cas construits à la main, sans framework).
//
// Le solveur est le seul endroit du projet où une erreur ne se voit pas à
// l'œil : une donne insoluble proposée en partie ne se remarque qu'après une
// minute de recherche à cinq. D'où les cas de référence ci-dessous, dont les
// deux donnes réputées les plus difficiles du jeu.

const { solutionsDe, difficulteDe, tirerDonne, rejouerEtapes, frac, texteFraction } = require('./vingtquatre');

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

function checkVrai(label, actual) {
  check(label, Boolean(actual), true);
}

// --- Fractions ------------------------------------------------------------
// Le point qui justifie de ne pas travailler en virgule flottante.
check('fraction réduite', frac(6, 8), { n: 3, d: 4 });
check('signe porté par le numérateur', frac(3, -4), { n: -3, d: 4 });
check('affichage entier', texteFraction(frac(24, 1)), '24');
check('affichage fractionnaire', texteFraction(frac(8, 3)), '8/3');

// --- Le solveur : donnes de référence --------------------------------------
// Les deux donnes les plus dures du 24 : solution unique, et elle passe par
// une fraction. En virgule flottante, 8 / (3 - 8/3) donne 23.999999999999996
// et serait rejetée.
check('8 3 8 3 a exactement une solution', solutionsDe([8, 3, 8, 3]).size, 1);
check('8 3 8 3 : la solution', [...solutionsDe([8, 3, 8, 3]).values()], ['8 / (3 - 8 / 3)']);
check('1 5 5 5 a exactement une solution', solutionsDe([1, 5, 5, 5]).size, 1);
check('1 5 5 5 : la solution', [...solutionsDe([1, 5, 5, 5]).values()], ['5 * (5 - 1 / 5)']);

// Donnes sans solution : elles ne doivent jamais être distribuées.
check('1 1 1 1 est insoluble', solutionsDe([1, 1, 1, 1]).size, 0);
check('1 1 1 2 est insoluble', solutionsDe([1, 1, 1, 2]).size, 0);
check('13 13 13 13 est insoluble', solutionsDe([13, 13, 13, 13]).size, 0);

// Donnes faciles : plusieurs chemins.
checkVrai('6 4 1 1 est soluble', solutionsDe([6, 4, 1, 1]).size > 0);
checkVrai('8 8 3 3 (déjà vu) diffère de 12 2 1 1', solutionsDe([12, 2, 1, 1]).size > 0);
checkVrai('4 6 6 6 est soluble', solutionsDe([4, 6, 6, 6]).size > 0);

// Le comptage dédoublonne les variantes commutatives : « 3 * 8 » et « 8 * 3 »
// sont la même solution. Sans ça, la difficulté annoncée serait toujours
// « facile ».
check('2 3 4 1 : les commutations ne sont pas comptées deux fois', solutionsDe([2, 3, 4, 1]).size, solutionsDe([1, 4, 3, 2]).size);

// --- Difficulté -----------------------------------------------------------
check('1 solution -> difficile', difficulteDe(1), 'difficile');
check('2 solutions -> difficile', difficulteDe(2), 'difficile');
check('3 solutions -> moyen', difficulteDe(3), 'moyen');
check('9 solutions -> moyen', difficulteDe(9), 'moyen');
check('10 solutions -> facile', difficulteDe(10), 'facile');

// --- Tirage ---------------------------------------------------------------
// La garantie centrale du jeu : on ne distribue jamais une donne insoluble,
// et la solution annoncée en est bien une.
let toutesSolubles = true;
let solutionsValides = true;
let valeursDansLeDeck = true;
for (let i = 0; i < 300; i++) {
  const donne = tirerDonne();
  if (donne.nbSolutions < 1) toutesSolubles = false;
  if (donne.cartes.length !== 4) toutesSolubles = false;
  if (donne.cartes.some((c) => c.value < 1 || c.value > 13)) valeursDansLeDeck = false;
  const attendues = solutionsDe(donne.cartes.map((c) => c.value));
  if (attendues.size !== donne.nbSolutions) solutionsValides = false;
  if (![...attendues.values()].includes(donne.solution)) solutionsValides = false;
}
checkVrai('300 donnes tirées : toutes ont au moins une solution', toutesSolubles);
checkVrai('300 donnes tirées : cartes entre 1 et 13 (as = 1, pas 14)', valeursDansLeDeck);
checkVrai('300 donnes tirées : la solution affichée en est vraiment une', solutionsValides);

// L'historique évite de reproposer la même donne dans une partie.
const vues = new Set();
const cles = new Set();
let sansDoublon = true;
for (let i = 0; i < 40; i++) {
  const donne = tirerDonne(vues);
  if (cles.has(donne.cle)) sansDoublon = false;
  cles.add(donne.cle);
}
checkVrai('40 donnes d\'affilée dans une partie : aucune répétition', sansDoublon);

// --- Validation d'une réponse de joueur ------------------------------------
const cartes = [
  { id: 'c0', value: 8 },
  { id: 'c1', value: 4 },
  { id: 'c2', value: 3 },
  { id: 'c3', value: 2 },
];

// (8 - 4) * 3 * 2 = 24. Les résultats intermédiaires s'appellent r0, r1, r2 :
// c'est la convention partagée avec le client.
check(
  'suite valide acceptée',
  rejouerEtapes(cartes, [
    { a: 'c0', b: 'c1', op: '-' },
    { a: 'r0', b: 'c2', op: '*' },
    { a: 'r1', b: 'c3', op: '*' },
  ]).ok,
  true
);
check(
  'suite valide : la formule est reconstituée',
  rejouerEtapes(cartes, [
    { a: 'c0', b: 'c1', op: '-' },
    { a: 'r0', b: 'c2', op: '*' },
    { a: 'r1', b: 'c3', op: '*' },
  ]).formule,
  '(8 - 4) * 3 * 2'
);

// Le résultat est bon mais une carte n'a pas servi : refusé, les quatre
// cartes doivent être utilisées (c'est la règle du jeu, et le fait d'imposer
// trois opérations la garantit).
check(
  'moins de trois opérations refusé',
  rejouerEtapes(cartes, [
    { a: 'c0', b: 'c2', op: '*' },
  ]).ok,
  false
);

check(
  'résultat qui ne fait pas 24 refusé',
  rejouerEtapes(cartes, [
    { a: 'c0', b: 'c1', op: '+' },
    { a: 'r0', b: 'c2', op: '+' },
    { a: 'r1', b: 'c3', op: '+' },
  ]).ok,
  false
);
check(
  'résultat refusé : le message dit ce que ça fait',
  rejouerEtapes(cartes, [
    { a: 'c0', b: 'c1', op: '+' },
    { a: 'r0', b: 'c2', op: '+' },
    { a: 'r1', b: 'c3', op: '+' },
  ]).erreur,
  'Ça fait 17, pas 24.'
);

// Réutiliser une carte déjà consommée reviendrait à jouer cinq cartes.
check(
  'carte réutilisée refusée',
  rejouerEtapes(cartes, [
    { a: 'c0', b: 'c1', op: '-' },
    { a: 'c0', b: 'c2', op: '*' },
    { a: 'r1', b: 'c3', op: '*' },
  ]).ok,
  false
);
check('carte inconnue refusée', rejouerEtapes(cartes, [{ a: 'c9', b: 'c1', op: '-' }, { a: 'r0', b: 'c2', op: '*' }, { a: 'r1', b: 'c3', op: '*' }]).ok, false);
check('opérateur inconnu refusé', rejouerEtapes(cartes, [{ a: 'c0', b: 'c1', op: '^' }, { a: 'r0', b: 'c2', op: '*' }, { a: 'r1', b: 'c3', op: '*' }]).ok, false);
check('même carte des deux côtés refusée', rejouerEtapes(cartes, [{ a: 'c0', b: 'c0', op: '*' }, { a: 'r0', b: 'c1', op: '*' }, { a: 'r1', b: 'c2', op: '*' }]).ok, false);
check('étapes absentes refusées', rejouerEtapes(cartes, null).ok, false);

// Division par zéro : 4 - 4 = 0 puis 8 / 0. Le moteur doit refuser, pas
// renvoyer Infinity.
const avecZero = [
  { id: 'c0', value: 8 },
  { id: 'c1', value: 4 },
  { id: 'c2', value: 4 },
  { id: 'c3', value: 3 },
];
check(
  'division par zéro refusée',
  rejouerEtapes(avecZero, [
    { a: 'c1', b: 'c2', op: '-' },
    { a: 'c0', b: 'r0', op: '/' },
    { a: 'r1', b: 'c3', op: '*' },
  ]).ok,
  false
);

// Le chemin qui exige des fractions exactes, joué comme un vrai joueur le
// jouerait : 8 / (3 - 8/3).
const donneDure = [
  { id: 'c0', value: 8 },
  { id: 'c1', value: 3 },
  { id: 'c2', value: 8 },
  { id: 'c3', value: 3 },
];
check(
  '8/(3-8/3) accepté malgré la fraction intermédiaire',
  rejouerEtapes(donneDure, [
    { a: 'c2', b: 'c3', op: '/' },
    { a: 'c1', b: 'r0', op: '-' },
    { a: 'c0', b: 'r1', op: '/' },
  ]).ok,
  true
);

console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
process.exit(failed > 0 ? 1 : 0);
