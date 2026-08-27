// Script de validation autonome pour server/skullking.js (même principe que
// server/ascenseur-simulate.js) : cas construits à la main, à faire passer
// avant de brancher les vrais sockets.

const {
  createDeck,
  buildRoundSequence,
  isValidBid,
  ledSuitOf,
  mustFollowSuit,
  isCardPlayable,
  resolveTrick,
  trickBonusForWinner,
  computeRoundScore,
  computeRoundScoreBreakdown,
  maxPlayersFor,
  clampRounds,
  MIN_ROUNDS,
  MAX_ROUNDS,
  EXTENSION_KEYS,
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
// --- Extension ---
function firstmate() {
  return { kind: 'firstmate' }; // Mat le Forban
}
function stingray() {
  return { kind: 'stingray' }; // Raie Tachetée
}
function lastvolley() {
  return { kind: 'lastvolley' }; // Dernière Salve
}
function plank(removesId) {
  return { kind: 'plank', removesId }; // Marcher sur la Planche
}
function davyjones() {
  return { kind: 'davyjones' }; // Coffre de Davy Jones
}
// Joker/Wild 15 et 0/14 : représentés déjà "résolus" (comme le fait
// skullking-room.js au moment de la pose), resolveTrick ne connaît que des
// cartes kind:'number' une fois jouées, sans logique dédiée.
function wild15(suit) {
  return { kind: 'number', suit, value: 15, wild15: true };
}
function declared014(suit, value) {
  return { kind: 'number', suit, value, ext: true, wild14: true };
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
  // Unifié avec la règle d'extension (2026-07-31) : dorénavant toujours
  // l'entameur d'origine, plus le joueur de la Baleine spécifiquement.
  check('baleine : que des spéciales → mené par l\'entameur d\'origine', r.leaderIdx, 0);
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

// --- Obligation de couleur (ledSuitOf / mustFollowSuit / isCardPlayable) ---
check('couleur imposée : aucune carte jouée → aucune couleur imposée', ledSuitOf([]), null);
check(
  'couleur imposée : 1ère carte spéciale menée → toujours aucune couleur imposée',
  ledSuitOf([{ card: pirate() }]),
  null
);
check(
  'couleur imposée : spéciale puis numérotée → couleur de la numérotée',
  ledSuitOf([{ card: pirate() }, { card: num('jaune', 5) }]),
  'jaune'
);
check(
  'couleur imposée : 1ère numérotée jouée en tête → sa couleur',
  ledSuitOf([{ card: num('vert', 3) }, { card: num('jaune', 5) }]),
  'vert'
);

check(
  'doit suivre : a une carte de la couleur imposée en main',
  mustFollowSuit([num('vert', 5), num('jaune', 2)], 'vert'),
  true
);
check(
  'doit suivre : aucune carte de la couleur imposée en main',
  mustFollowSuit([num('jaune', 2), pirate()], 'vert'),
  false
);
check('doit suivre : aucune couleur imposée encore', mustFollowSuit([num('vert', 5)], null), false);

{
  const trick = [{ card: num('vert', 9) }];
  const hand = [num('vert', 3), num('jaune', 7)];
  check(
    "jouable : carte de la couleur imposée toujours autorisée",
    isCardPlayable(num('vert', 3), hand, trick),
    true
  );
  check(
    "jouable : carte hors-couleur refusée si on a la couleur imposée en main",
    isCardPlayable(num('jaune', 7), hand, trick),
    false
  );
  check('jouable : une carte spéciale reste toujours jouable', isCardPlayable(pirate(), hand, trick), true);
  check('jouable : la Tigresse reste toujours jouable', isCardPlayable(tigress('escape'), hand, trick), true);
}
{
  const trick = [{ card: num('vert', 9) }];
  const hand = [num('jaune', 7), pirate()];
  check(
    "jouable : carte hors-couleur autorisée si on n'a pas la couleur imposée",
    isCardPlayable(num('jaune', 7), hand, trick),
    true
  );
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

// --- computeRoundScoreBreakdown ---
check('breakdown : contrat 3 exact avec bonus', computeRoundScoreBreakdown(3, 3, 5, 40), { base: 60, bonus: 40, total: 100 });
check('breakdown : contrat raté, bonus ignoré', computeRoundScoreBreakdown(2, 5, 5, 999), { base: -30, bonus: 0, total: -30 });
check('breakdown : contrat 0 réussi', computeRoundScoreBreakdown(0, 0, 4, 0), { base: 40, bonus: 0, total: 40 });

// ============================================================
// --- Extension officielle (2026-07-31) ---
// ============================================================

// --- Deck étendu ---
{
  const extDeck = createDeck(true);
  check('extension : deck de 93 cartes', extDeck.length, 93);
  check('extension : deck de base inchangé sans le flag', createDeck().length, 74);
  check('extension : 4 sept supplémentaires', extDeck.filter((c) => c.kind === 'number' && c.ext && c.value === 7).length, 4);
  check('extension : 4 huit supplémentaires', extDeck.filter((c) => c.kind === 'number' && c.ext && c.value === 8).length, 4);
  check('extension : 4 cartes 0/14 (valeur non fixée à la donne)', extDeck.filter((c) => c.wild14).length, 4);
  check('extension : 1 Joker/Wild 15', extDeck.filter((c) => c.kind === 'wild15').length, 1);
  check('extension : 6 pirates nommés (Mary Thorne incluse)', extDeck.filter((c) => c.kind === 'pirate').length, 6);
  check('extension : 1 Mat le Forban', extDeck.filter((c) => c.kind === 'firstmate').length, 1);
  check('extension : 1 Raie Tachetée', extDeck.filter((c) => c.kind === 'stingray').length, 1);
  check('extension : 1 Dernière Salve', extDeck.filter((c) => c.kind === 'lastvolley').length, 1);
  check('extension : 1 Marcher sur la Planche', extDeck.filter((c) => c.kind === 'plank').length, 1);
  check('extension : 1 Coffre de Davy Jones', extDeck.filter((c) => c.kind === 'davyjones').length, 1);
}

// --- Extensions à la carte ---
// Chaque ligne du salon n'ajoute QUE ses cartes : c'est ce qui permet de
// jouer avec les monstres sans les numérotées, ou l'inverse.
{
  const seulesNum = createDeck(['numerotees']);
  check('à la carte : les numérotées seules font 86 cartes', seulesNum.length, 86);
  check('à la carte : pas de Joker sans sa ligne', seulesNum.filter((c) => c.kind === 'wild15').length, 0);
  check('à la carte : 5 pirates tant que Mary Thorne est éteinte', seulesNum.filter((c) => c.kind === 'pirate').length, 5);

  const seuleMary = createDeck(['marythorne']);
  check('à la carte : Mary Thorne seule fait 75 cartes', seuleMary.length, 75);
  check('à la carte : Mary Thorne est le 6e pirate', seuleMary.filter((c) => c.kind === 'pirate').length, 6);
  check('à la carte : aucune numérotée d\'extension sans sa ligne', seuleMary.filter((c) => c.ext).length, 0);

  const monstres = createDeck(['stingray', 'davyjones']);
  check('à la carte : deux monstres font 76 cartes', monstres.length, 76);
  check('à la carte : la Raie répond présente', monstres.filter((c) => c.kind === 'stingray').length, 1);
  check('à la carte : la Salve reste au vestiaire', monstres.filter((c) => c.kind === 'lastvolley').length, 0);

  // Les huit clés, cochées une à une, doivent refaire le paquet complet.
  check('à la carte : les huit lignes refont les 93 cartes', createDeck(EXTENSION_KEYS).length, 93);
  check('à la carte : une clé inconnue ne fait rien', createDeck(['inexistant']).length, 74);
  check('à la carte : l\'objet du salon est compris aussi', createDeck({ joker: true, plank: false }).length, 75);
}

// --- Plafond de joueurs ---
// Ce n'est pas une constante mais une division : la manche 10 se joue à 10
// cartes par joueur, donc le paquet divisé par 10 dit combien de monde peut
// s'asseoir. Les deux valeurs historiques doivent en ressortir intactes.
check('extension : plafond 7 joueurs sans extension', maxPlayersFor(false), 7);
check('extension : plafond 9 joueurs avec extension', maxPlayersFor(true), 9);
check('à la carte : les numérotées seules ouvrent un 8e siège', maxPlayersFor(['numerotees']), 8);
check('à la carte : une seule carte de plus ne suffit pas à un 8e siège', maxPlayersFor(['joker']), 7);
check('à la carte : le plafond ne dépasse jamais 9', maxPlayersFor(EXTENSION_KEYS), 9);

// --- Mat le Forban (First Mate Con) ---
check('Mat le Forban bat un Pirate classique', winnerIdx([pirate(), firstmate()]), 1);
check('Mat le Forban bat plusieurs Pirates classiques', winnerIdx([pirate(), firstmate(), pirate()]), 1);
check('Mat le Forban perd contre le Skull King', winnerIdx([firstmate(), sk()]), 1);
check('Mat le Forban perd contre une Sirène', winnerIdx([firstmate(), siren()]), 1);
check('Mat le Forban bat une numérotée (aucun Pirate/SK/Sirène)', winnerIdx([num('vert', 14), firstmate()]), 1);
check(
  'Mat le Forban + Pirate + Skull King + Sirène : la Sirène ferme toujours la boucle',
  winnerIdx([pirate(), firstmate(), sk(), siren()]),
  3
);
{
  // Capturé par le Skull King : bonus de capture "comme un pirate normal",
  // en plus du décompte des vrais Pirates du même pli.
  const cards = [pirate(), firstmate(), sk()];
  const r = resolveTrick(cards);
  check('Mat le Forban capturé par le Skull King : le SK gagne', r.winnerIdx, 2);
  check(
    'Mat le Forban capturé par le Skull King : bonus = 30 (pirate) + 30 (Mat)',
    trickBonusForWinner(cards, r.winnerIdx, r.excludedIdx),
    60
  );
}
{
  // Capturé par une Sirène (élargissement propre à Mat : les vrais Pirates
  // ne donnent ce bonus que capturés par le Skull King, pas par une Sirène).
  const cards = [firstmate(), siren()];
  const r = resolveTrick(cards);
  check('Mat le Forban capturé par une Sirène : bonus = 30', trickBonusForWinner(cards, r.winnerIdx, r.excludedIdx), 30);
}
check(
  'Un Pirate classique capturé par une Sirène (sans Mat) ne donne toujours aucun bonus',
  trickBonusForWinner([pirate(), siren()], 1, resolveTrick([pirate(), siren()]).excludedIdx),
  0
);
{
  // Le sens INVERSE de la capture, celui qu'on croit toujours symétrique :
  // Mat rafle les Pirates du pli et n'en tire rien. Le bonus de +30 par
  // Pirate appartient au seul Skull King ; Mat n'hérite que des pouvoirs.
  const cards = [pirate(), pirate(), firstmate()];
  const r = resolveTrick(cards);
  check('Mat le Forban capturant des Pirates : il gagne le pli', r.winnerIdx, 2);
  check(
    "Mat le Forban capturant des Pirates : aucun bonus (le +30 est au Skull King seul)",
    trickBonusForWinner(cards, r.winnerIdx, r.excludedIdx),
    0
  );
}
{
  // Sans Skull King, la boucle Mat > Pirate > Sirène > Mat se ferme comme
  // celle du jeu de base : la Sirène l'emporte. Elle touche les 30 de Mat,
  // et rien pour le Pirate qu'elle emporte au passage.
  const cards = [pirate(), firstmate(), siren()];
  const r = resolveTrick(cards);
  check('Mat + Pirate + Sirène (sans Skull King) : la Sirène ferme la boucle', r.winnerIdx, 2);
  check(
    'Mat + Pirate + Sirène : la Sirène touche 30 pour Mat, rien pour le Pirate',
    trickBonusForWinner(cards, r.winnerIdx, r.excludedIdx),
    30
  );
}

// --- Raie Tachetée (Spotted Stingray) : miroir de la Baleine, la plus basse gagne ---
check('Raie Tachetée : la plus basse valeur gagne (vert 3 < vert 9)', winnerIdx([num('vert', 9), stingray(), num('vert', 3)]), 2);
check('Raie Tachetée : neutralise le statut d\'atout du noir', winnerIdx([num('vert', 2), stingray(), num('noir', 9)]), 0);
{
  const cards = [pirate(), stingray(), sk()];
  const r = resolveTrick(cards);
  check('Raie Tachetée : que des spéciales → pli détruit', r.destroyed, true);
  check('Raie Tachetée : que des spéciales → mené par l\'entameur d\'origine', r.leaderIdx, 0);
}

// --- Interaction à 3 Monstres Marins : le dernier joué décide ---
check('Kraken, Baleine puis Raie : la Raie (dernière) décide, la plus basse gagne', winnerIdx([kraken(), whale(), stingray(), num('vert', 9), num('jaune', 3)]), 4);
check('Raie puis Baleine : la Baleine (dernière) décide, la plus haute gagne', winnerIdx([stingray(), whale(), num('vert', 3), num('jaune', 9)]), 3);
check('Baleine puis Kraken puis Raie : la Raie (dernière) décide', destroyed([whale(), kraken(), stingray(), num('vert', 9), num('jaune', 3)]), false);

// --- Coffre de Davy Jones : priorité absolue sur les Monstres Marins ---
{
  const cards = [num('vert', 5), kraken(), whale(), stingray(), davyjones(), num('jaune', 9)];
  const r = resolveTrick(cards);
  check('Davy Jones détruit les 3 Monstres Marins peu importe l\'ordre', r.monstersDestroyed, 3);
  // jaune 9 n'a pas suivi la couleur imposée par le vert 5 (1ère numérotée
  // jouée) : comme toute carte hors-couleur, elle ne peut jamais gagner,
  // peu importe sa valeur — vert 5 l'emporte donc, seule carte éligible.
  check('Davy Jones : seule la carte de la couleur imposée reste éligible (vert 5)', r.winnerIdx, 0);
  check('Davy Jones : lui-même + les 3 Monstres exclus du bonus', [...r.excludedIdx].sort(), [1, 2, 3, 4]);
}
{
  // Davy Jones seul avec des Monstres, rien d'autre : plus rien à gagner.
  const cards = [davyjones(), kraken(), whale()];
  const r = resolveTrick(cards);
  check('Davy Jones + Monstres seuls : pli détruit', r.destroyed, true);
  check('Davy Jones + Monstres seuls : mené par l\'entameur d\'origine (pas Davy Jones lui-même)', r.leaderIdx, 0);
}
{
  // Bonus : +20 par Monstre détruit, calculé côté skullking-room.js à
  // partir de result.monstersDestroyed (pas dans trickBonusForWinner).
  const cards = [num('vert', 5), kraken(), davyjones(), num('jaune', 9)];
  const r = resolveTrick(cards);
  check('Davy Jones détruit 1 Monstre (Kraken) parmi une numérotée', r.monstersDestroyed, 1);
  check('Davy Jones : le Kraken détruit ne détruit plus le pli', r.destroyed, false);
}

// --- Marcher sur la Planche : retire un Pirate ciblé ---
{
  const target = { kind: 'pirate', id: 'target-pirate' };
  const cards = [target, sk(), { kind: 'plank', removesId: 'target-pirate' }];
  const r = resolveTrick(cards);
  check('Planche retire le Pirate ciblé : plus de Pirate face au Skull King, mais la Planche ne gagne jamais', r.winnerIdx, 1);
  check('Planche : le Pirate retiré est exclu du bonus de capture du Skull King', trickBonusForWinner(cards, r.winnerIdx, r.excludedIdx), 0);
}
{
  const cards = [pirate(), plank(undefined)];
  const r = resolveTrick(cards);
  check('Planche jamais gagnante elle-même', r.winnerIdx, 0);
}

// --- Dernière Salve : ne gagne jamais ---
check('Dernière Salve ne gagne jamais face à une numérotée', winnerIdx([lastvolley(), num('vert', 2)]), 1);

// --- Mélange de cartes "ne gagnent jamais" sans numérotée : défaussé, mené par l'entameur ---
{
  const cards = [esc(), lastvolley(), plank(undefined)];
  const r = resolveTrick(cards);
  check('Fuite + Dernière Salve + Planche (aucune numérotée) : pli défaussé', r.destroyed, true);
  check('Fuite + Dernière Salve + Planche : mené par l\'entameur d\'origine', r.leaderIdx, 0);
}
check('Mais "que des Fuites" (sans les nouvelles cartes) reste gagné par la première', winnerIdx([esc(), esc()]), 0);
check('Butin reste exceptionnel même mélangé aux nouvelles cartes non-gagnantes', winnerIdx([lastvolley(), loot(), plank(undefined)]), 1);

// --- Joker/Wild 15 et 0/14 (déjà "résolus" au moment où ils entrent dans le pli) ---
check('Joker (couleur prise = vert) bat une autre numérotée vert', winnerIdx([num('vert', 14), wild15('vert')]), 1);
check('Joker perd face à l\'atout noir', winnerIdx([num('noir', 5), wild15('vert')]), 0);
check('0/14 déclaré à 14 se comporte comme un vrai 14 (bonus couleur)', trickBonusForWinner([declared014('vert', 14), num('jaune', 3)], 0), 10);
check('0/14 déclaré à 0 ne gagne jamais, même seule carte numérotée en lice', winnerIdx([esc(), declared014('vert', 0)]), null);
check('0/14 déclaré à 0 + Butin (rien d\'autre) : le Butin gagne quand même exceptionnellement', winnerIdx([declared014('vert', 0), loot()]), 1);
check('7 d\'extension capturé : bonus -5', trickBonusForWinner([{ kind: 'number', suit: 'vert', value: 7, ext: true }, num('jaune', 3)], 0), -5);
check('8 d\'extension capturé : bonus +5', trickBonusForWinner([{ kind: 'number', suit: 'vert', value: 8, ext: true }, num('jaune', 3)], 0), 5);
check('un 7 de base (non-extension) ne donne aucun bonus', trickBonusForWinner([num('vert', 7), num('jaune', 3)], 0), 0);

// --- Égalité sous la Baleine blanche / la Raie Tachetée ---
// La Baleine annule les cartes spéciales : seule la valeur compte, et deux
// joueurs peuvent donc se retrouver à égalité, ce qui n'arrive jamais dans
// la hiérarchie normale. Dans ce cas c'est le premier à avoir posé cette
// valeur qui remporte le pli (l'ordre du tableau est l'ordre de pose).
const nb = (id, v) => ({ id, kind: 'number', suit: 'vert', value: v });

check(
  'Baleine + égalité : le premier à avoir posé la valeur gagne',
  resolveTrick([nb('a', 9), { id: 'w', kind: 'whale' }, nb('b', 9), nb('c', 5)]).winnerIdx,
  0
);
check(
  'Baleine + égalité posée plus tard dans le pli : toujours le premier des deux',
  resolveTrick([nb('x', 5), { id: 'w', kind: 'whale' }, nb('y', 9), nb('z', 9)]).winnerIdx,
  2
);
check(
  'Baleine + trois cartes à égalité : le tout premier posé',
  resolveTrick([nb('p', 7), nb('q', 7), { id: 'w', kind: 'whale' }, nb('r', 7)]).winnerIdx,
  0
);
check(
  'Baleine : la couleur ne départage pas (le noir perd son statut d\'atout)',
  resolveTrick([nb('v', 9), { id: 'w', kind: 'whale' }, { id: 'n', kind: 'number', suit: 'noir', value: 9 }]).winnerIdx,
  0
);
check(
  'Raie Tachetée + égalité sur la plus basse : le premier posé aussi',
  resolveTrick([nb('a', 3), { id: 'r', kind: 'stingray' }, nb('b', 3), nb('c', 9)]).winnerIdx,
  0
);

// --- Nombre de manches réglable ------------------------------------------
// La manche N se joue à N cartes : c'est la DERNIÈRE manche qui dimensionne
// le paquet. À 10 manches et 7 joueurs il faut 70 cartes sur 74 ; une 11e en
// demanderait 77. Le plafond n'est donc pas cosmétique, il est matériel.
check('4 manches : la suite va de 1 à 4', buildRoundSequence(4), [1, 2, 3, 4]);
check('par défaut : la partie complète', buildRoundSequence().length, MAX_ROUNDS);
check('au-dessus du plafond : ramené au maximum', buildRoundSequence(99).length, MAX_ROUNDS);
check('en dessous du plancher : ramené au minimum', buildRoundSequence(1).length, MIN_ROUNDS);
check('valeur absente : partie complète', clampRounds(undefined), MAX_ROUNDS);
check('valeur non numérique : partie complète', clampRounds('abc'), MAX_ROUNDS);
check('valeur décimale : arrondie', clampRounds(6.4), 6);
check('la dernière manche vaut le nombre de manches', buildRoundSequence(7).at(-1), 7);
check('aucune manche à 0 carte', buildRoundSequence(5).includes(0), false);

console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
process.exit(failed > 0 ? 1 : 0);
