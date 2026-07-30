// Script de validation autonome pour server/skullking.js (même principe que
// server/ascenseur-simulate.js) : cas construits à la main, à faire passer
// avant de brancher les vrais sockets.

const {
  createDeck,
  buildRoundSequence,
  isValidBid,
  resolveTrick,
  trickBonusForWinner,
  computeRoundScore,
} = require('./skullking');

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

function num(suit, value) {
  return { kind: 'number', suit, value };
}
function pirate() {
  return { kind: 'pirate' };
}
function siren() {
  return { kind: 'siren' };
}
function sk() {
  return { kind: 'skullking' };
}
function esc() {
  return { kind: 'escape' };
}
function tigress(as) {
  return { kind: 'tigress', chosenAs: as };
}
function loot() {
  return { kind: 'loot' };
}
function kraken() {
  return { kind: 'kraken' };
}
function whale() {
  return { kind: 'whale' };
}

function winnerIdx(cards) {
  return resolveTrick(cards).winnerIdx;
}
function leaderIdx(cards) {
  return resolveTrick(cards).leaderIdx;
}
function destroyed(cards) {
  return resolveTrick(cards).destroyed;
}

// --- Deck ---
const deck = createDeck();
check('deck : 74 cartes', deck.length, 74);
check('deck : 56 numérotées (4x14)', deck.filter((c) => c.kind === 'number').length, 56);
check('deck : 2 sirènes', deck.filter((c) => c.kind === 'siren').length, 2);
check('deck : 5 pirates nommés', deck.filter((c) => c.kind === 'pirate').length, 5);
check('deck : noms de pirates uniques', new Set(deck.filter((c) => c.kind === 'pirate').map((c) => c.name)).size, 5);
check('deck : 1 skull king', deck.filter((c) => c.kind === 'skullking').length, 1);
check('deck : 5 fuites', deck.filter((c) => c.kind === 'escape').length, 5);
check('deck : 1 tigresse', deck.filter((c) => c.kind === 'tigress').length, 1);
check('deck : 2 butins', deck.filter((c) => c.kind === 'loot').length, 2);
check('deck : 1 kraken', deck.filter((c) => c.kind === 'kraken').length, 1);
check('deck : 1 baleine blanche', deck.filter((c) => c.kind === 'whale').length, 1);

// --- Séquence de manches ---
check('séquence : 10 manches, 1 à 10', buildRoundSequence(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

// --- isValidBid ---
check('annonce valide : 0', isValidBid(0, 5), true);
check('annonce valide : = nb de plis', isValidBid(5, 5), true);
check('annonce invalide : > nb de plis', isValidBid(6, 5), false);
check('annonce invalide : négative', isValidBid(-1, 5), false);

// --- resolveTrick : hiérarchie de base (jeu de base, revalidé avec la nouvelle forme de retour) ---
check('numérotées : la plus haute de la couleur menée gagne', winnerIdx([num('vert', 5), num('jaune', 12), num('vert', 9)]), 2);
check('numérotées : le noir gagne quel que soit son chiffre', winnerIdx([num('vert', 14), num('noir', 2), num('jaune', 10)]), 1);
check('fuite : ne gagne jamais face à une numérotée', winnerIdx([esc(), num('vert', 2)]), 1);
check('tout-fuites : la 1ère jouée "gagne"', winnerIdx([esc(), esc(), esc()]), 0);
check('pirate bat une numérotée', winnerIdx([num('noir', 14), pirate()]), 1);
check('pirate bat une sirène (sans skull king)', winnerIdx([siren(), pirate()]), 1);
check('skull king bat les pirates (sans sirène)', winnerIdx([pirate(), sk(), pirate()]), 1);
check('sirène bat le skull king (sans pirate)', winnerIdx([sk(), siren()]), 1);
check('cas spécial : pirate + skull king + sirène → la sirène gagne toujours', winnerIdx([pirate(), sk(), siren()]), 2);
check('tigresse-en-pirate compte comme un pirate', winnerIdx([num('noir', 14), tigress('pirate')]), 1);
check('destroyed=false hors Kraken/Baleine', destroyed([num('vert', 5), num('jaune', 12)]), false);

// --- Butin (Loot) ---
check('butin seul : agit comme une fuite', winnerIdx([loot(), num('vert', 2)]), 1);
check('butin : perd même face à un pirate', winnerIdx([loot(), pirate()]), 1);
check('tout-fuites + butin : le butin gagne exceptionnellement', winnerIdx([esc(), loot(), esc()]), 1);
check('tout-fuites + 2 butins : le premier joué gagne', winnerIdx([esc(), loot(), loot()]), 1);

// --- Kraken ---
{
  const cards = [num('vert', 5), kraken(), num('vert', 14)];
  const r = resolveTrick(cards);
  check('kraken : personne ne gagne (winnerIdx null)', r.winnerIdx, null);
  check('kraken : pli détruit', r.destroyed, true);
  check('kraken : pli suivant mené par le gagnant virtuel (ici le vert 14)', r.leaderIdx, 2);
}
{
  // Kraken en présence de pirates/SK/sirène : le gagnant virtuel suit quand
  // même toute la hiérarchie normale (pas juste les numérotées).
  const cards = [pirate(), kraken(), siren()];
  const r = resolveTrick(cards);
  check('kraken + pirate + sirène : gagnant virtuel = le pirate (sirène seule ne bat pas un pirate)', r.leaderIdx, 0);
  check('kraken + pirate + sirène : pli quand même détruit', r.destroyed, true);
}

// --- Baleine blanche ---
{
  const cards = [num('vert', 5), whale(), num('noir', 2)];
  const r = resolveTrick(cards);
  check('baleine : le noir perd son atout, seule la valeur compte (vert 5 > noir 2)', r.winnerIdx, 0);
  check('baleine : pli non détruit puisqu\'il y a des numérotées', r.destroyed, false);
}
{
  const cards = [pirate(), whale(), sk()];
  const r = resolveTrick(cards);
  check('baleine : que des spéciales → pli détruit', r.destroyed, true);
  check('baleine : que des spéciales → menée par le joueur de la baleine', r.leaderIdx, 1);
}
{
  // Deux couleurs différentes à égalité de valeur : la 1ère jouée gagne.
  const cards = [num('vert', 9), whale(), num('jaune', 9)];
  const r = resolveTrick(cards);
  check('baleine : égalité entre couleurs différentes → la 1ère jouée gagne', r.winnerIdx, 0);
}

// --- Interaction Kraken + Baleine : la carte jouée en second l'emporte ---
{
  const cards = [kraken(), whale(), num('vert', 5), num('jaune', 9)];
  const r = resolveTrick(cards);
  check('kraken puis baleine : la baleine (jouée en second) l\'emporte', r.destroyed, false);
  check('kraken puis baleine : le kraken neutralisé ne détruit plus rien, la baleine tranche par la valeur', r.winnerIdx, 3);
}
{
  const cards = [whale(), kraken(), num('vert', 5), num('jaune', 9)];
  const r = resolveTrick(cards);
  check('baleine puis kraken : le kraken (joué en second) l\'emporte, pli détruit', r.destroyed, true);
}

// --- Bonus ---
check('bonus : capturer un 14 de couleur', trickBonusForWinner([num('vert', 14), num('jaune', 3)], 1), 10);
check('bonus : capturer le 14 noir', trickBonusForWinner([num('noir', 14), num('jaune', 3)], 1), 20);
check('bonus : capturer 2 pirates avec le skull king', trickBonusForWinner([pirate(), sk(), pirate()], 1), 60);
check('bonus : capturer le skull king avec une sirène', trickBonusForWinner([sk(), siren()], 1), 40);

// --- computeRoundScore ---
check('contrat 0 réussi, manche 3', computeRoundScore(0, 0, 3, 0), 30);
check('contrat 0 raté (1 pli pris), manche 3', computeRoundScore(0, 1, 3, 0), -30);
check('contrat 3 réussi exactement, avec bonus', computeRoundScore(3, 3, 5, 40), 100);
check('contrat 2 raté : le bonus accumulé ne compte pas', computeRoundScore(2, 5, 5, 999), -30);

console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
process.exit(failed > 0 ? 1 : 0);
