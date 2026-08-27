// Logique pure de Skull King (règles complètes : jeu de base + Butin,
// Kraken, Baleine blanche + extension officielle optionnelle) : deck,
// résolution de pli (hiérarchie non-transitive), bonus, score. Aucune
// dépendance à Socket.io, testable seule via skullking-simulate.js avant de
// brancher les vrais sockets.

const { shuffle } = require('./game');

const SUITS = ['vert', 'jaune', 'violet', 'noir'];
const PIRATE_NAMES = ["Rosie la Douce", 'Will le Bandit', 'Rascal le Flambeur', 'Juanita Jade', 'Harry le Géant'];
const EXTENSION_PIRATE_NAME = 'Mary Thorne';

// Clé courte du pouvoir associé à chaque pirate nommé, utilisée côté
// serveur (skullking-room.js) pour savoir quelle phase de pouvoir déclencher
// quand ce pirate remporte un pli avec sa propre carte. Mat le Forban n'a
// pas d'entrée ici : son "pouvoir" n'est pas le sien, il hérite de ceux des
// pirates classiques capturés dans le même pli - mécanique à part, gérée
// dans skullking-room.js via une file de pouvoirs plutôt qu'un seul pouvoir
// direct.
const PIRATE_POWER_BY_NAME = {
  "Rosie la Douce": 'rosie',
  'Will le Bandit': 'will',
  'Rascal le Flambeur': 'rascal',
  'Juanita Jade': 'juanita',
  'Harry le Géant': 'harry',
  [EXTENSION_PIRATE_NAME]: 'marythorne',
};

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 7; // le deck de base (74 cartes) suffit pour 7 joueurs à la manche 10 (70 cartes)
const MAX_PLAYERS_EXTENDED = 9; // deck étendu (93 cartes) : 9 joueurs à la manche 10 = 90 cartes

// L'extension officielle n'est plus un bloc : chacun de ses apports s'active
// séparément dans le salon. Une table plutôt qu'une suite de booléens, parce
// qu'elle sert trois fois — construire le paquet, compter ce que chaque ligne
// ajoute, et remplir la planche du salon sans que l'écran ait à redire les
// libellés. L'ordre est celui de la planche : le plus courant en premier.
const EXTENSION_MODULES = [
  { key: 'numerotees', label: 'Les 7, 8 et 0/14', cards: 12 },
  { key: 'joker', label: 'Le Joker', cards: 1 },
  { key: 'marythorne', label: 'Mary Thorne', cards: 1 },
  { key: 'firstmate', label: 'Mat le Forban', cards: 1 },
  { key: 'stingray', label: 'La Raie Tachetée', cards: 1 },
  { key: 'lastvolley', label: 'La Dernière Salve', cards: 1 },
  { key: 'plank', label: 'Marcher sur la Planche', cards: 1 },
  { key: 'davyjones', label: 'Le Coffre de Davy Jones', cards: 1 },
];
const EXTENSION_KEYS = EXTENSION_MODULES.map((m) => m.key);

// Ce que les fonctions du paquet acceptent : le jeu de clés, mais aussi
// l'ancien booléen « tout ou rien ». Les appels internes et les tests
// continuent de dire `true`, et une salle enregistrée avant la découpe se
// relit sans conversion.
function extensionSet(extensions) {
  if (extensions === true) return new Set(EXTENSION_KEYS);
  if (!extensions) return new Set();
  const brutes = extensions instanceof Set || Array.isArray(extensions)
    ? [...extensions]
    : EXTENSION_KEYS.filter((key) => extensions[key]);
  return new Set(brutes.filter((key) => EXTENSION_KEYS.includes(key)));
}

// Le plafond de joueurs n'est pas une constante mais une division. La manche
// 10 se joue à 10 cartes par joueur : c'est elle qui charge le plus le
// paquet, et c'est donc elle qui décide combien de monde peut s'asseoir. 74
// cartes donnent 7 joueurs, 93 en donnent 9 — exactement les deux valeurs
// qu'on écrivait à la main tant que l'extension était indivisible. Écrite
// ainsi, la règle continue de tomber juste sur une extension à la carte :
// n'ajouter que les douze numérotées fait 86 cartes, donc 8 joueurs.
function deckSizeFor(extensions) {
  return createDeck(extensions).length;
}

function maxPlayersFor(extensions) {
  const cartes = deckSizeFor(extensions);
  return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS_EXTENDED, Math.floor(cartes / MAX_ROUNDS)));
}

// Nombre de manches : réglable par l'hôte dans le salon. La manche N se joue
// à N cartes, donc la dernière manche est aussi la plus chargée — c'est elle
// qui fixe le plafond. À 10 manches et 7 joueurs il faut 70 cartes sur les 74
// du paquet de base ; au-delà de 10, la manche 11 en demanderait 77 et le
// paquet n'y suffirait plus. D'où ce plafond, qui n'est pas arbitraire.
const MIN_ROUNDS = 3;
const MAX_ROUNDS = 10;

function clampRounds(total) {
  const n = Math.round(Number(total));
  if (!Number.isFinite(n)) return MAX_ROUNDS;
  return Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, n));
}

function buildRoundSequence(total = MAX_ROUNDS) {
  const n = clampRounds(total);
  return Array.from({ length: n }, (_, i) => i + 1);
}

// 4x14 numérotées + 2 Sirènes + 5 (ou 6) Pirates nommés + 1 Skull King + 5
// Fuites + 1 Tigresse + 2 Butins + 1 Kraken + 1 Baleine blanche = 74 cartes
// de base. Avec l'extension : +12 numérotées (7/8/0-14 par couleur), +1
// Joker/Wild 15, +1 Mary Thorne (comptée dans la boucle des pirates
// ci-dessus), +1 Mat le Forban, +1 Raie Tachetée, +1 Dernière Salve, +1
// Marcher sur la Planche, +1 Coffre de Davy Jones = +19 cartes (93 total).
function createDeck(extensions) {
  const ext = extensionSet(extensions);
  const deck = [];
  let uid = 0;
  for (const suit of SUITS) {
    for (let value = 1; value <= 14; value++) {
      deck.push({ id: `s${uid++}`, kind: 'number', suit, value });
    }
  }
  // Les deux Sirènes sont interchangeables en règle ; elles ne diffèrent
  // que par leur illustration, d'où ce numéro de variante — sans lui, le
  // paquet classique poserait deux fois la même sirène sur le tapis.
  for (let i = 0; i < 2; i++) deck.push({ id: `s${uid++}`, kind: 'siren', variant: i + 1 });
  const pirateNames = ext.has('marythorne') ? [...PIRATE_NAMES, EXTENSION_PIRATE_NAME] : PIRATE_NAMES;
  for (const name of pirateNames) deck.push({ id: `s${uid++}`, kind: 'pirate', name });
  deck.push({ id: `s${uid++}`, kind: 'skullking' });
  for (let i = 0; i < 5; i++) deck.push({ id: `s${uid++}`, kind: 'escape' });
  deck.push({ id: `s${uid++}`, kind: 'tigress' });
  for (let i = 0; i < 2; i++) deck.push({ id: `s${uid++}`, kind: 'loot' });
  deck.push({ id: `s${uid++}`, kind: 'kraken' });
  deck.push({ id: `s${uid++}`, kind: 'whale' });

  if (ext.has('numerotees')) {
    for (const suit of SUITS) {
      deck.push({ id: `s${uid++}`, kind: 'number', suit, value: 7, ext: true });
      deck.push({ id: `s${uid++}`, kind: 'number', suit, value: 8, ext: true });
      // Le 0/14 : valeur non fixée à la donne, déclarée par le joueur au
      // moment où il la joue (voir skullking-room.js). Reste kind:'number'
      // dès la main pour respecter l'obligation de couleur comme n'importe
      // quelle numérotée (ledSuitOf/mustFollowSuit/isCardPlayable ne lisent
      // jamais .value, seulement .kind et .suit).
      deck.push({ id: `s${uid++}`, kind: 'number', suit, value: null, ext: true, wild14: true });
    }
  }
  // Une carte spéciale absente du paquet emporte sa règle avec elle : toute
  // la résolution de pli est branchée sur le `kind` de la carte posée, il n'y
  // a donc rien à débrancher ailleurs quand une ligne du salon est éteinte.
  // Joker/Wild 15 : reste toujours jouable en main (kind !== 'number'),
  // sa couleur/valeur définitive est fixée au moment de la pose.
  if (ext.has('joker')) deck.push({ id: `s${uid++}`, kind: 'wild15' });
  if (ext.has('firstmate')) deck.push({ id: `s${uid++}`, kind: 'firstmate' }); // Mat le Forban
  if (ext.has('stingray')) deck.push({ id: `s${uid++}`, kind: 'stingray' }); // Raie Tachetée
  if (ext.has('lastvolley')) deck.push({ id: `s${uid++}`, kind: 'lastvolley' }); // Dernière Salve
  if (ext.has('plank')) deck.push({ id: `s${uid++}`, kind: 'plank' }); // Marcher sur la Planche
  if (ext.has('davyjones')) deck.push({ id: `s${uid++}`, kind: 'davyjones' }); // Coffre de Davy Jones
  return deck;
}

// Le deck complet est remélangé à chaque manche. Les cartes non distribuées
// (le "residualPile") restent visibles/piochables ce tour-ci via les
// pouvoirs de Juanita Jade et Will le Bandit — elles disparaissent ensuite,
// sans incidence sur les manches suivantes puisque le deck est entièrement
// recréé à chaque fois.
function dealRound(playerCount, cardsPerPlayer, extensions) {
  const deck = shuffle(createDeck(extensions));
  const hands = Array.from({ length: playerCount }, () => []);
  for (let i = 0; i < cardsPerPlayer * playerCount; i++) {
    hands[i % playerCount].push(deck[i]);
  }
  const residualPile = deck.slice(cardsPerPlayer * playerCount);
  return { hands, residualPile };
}

function isValidBid(bid, cardsInRound) {
  return Number.isInteger(bid) && bid >= 0 && bid <= cardsInRound;
}

// Couleur imposée par le pli en cours : celle de la première carte
// NUMÉROTÉE jouée (une carte spéciale menée en premier n'impose rien tant
// qu'aucune numérotée n'a suivi - c'est elle qui fixe la couleur le cas
// échéant). Toutes les cartes spéciales restent toujours jouables quelle
// que soit la couleur demandée : seules les numérotées y sont soumises. Le
// Joker/Wild 15 et le 0/14 sont mutés en kind:'number' au moment de leur
// pose (voir skullking-room.js) : une fois dans le pli, ils imposent leur
// couleur exactement comme une numérotée normale, sans code spécifique ici.
function ledSuitOf(trick) {
  for (const play of trick) {
    if (play.card.kind === 'number') return play.card.suit;
  }
  return null;
}

// Un joueur est tenu de suivre la couleur demandée s'il a encore au moins
// une carte numérotée de cette couleur en main.
function mustFollowSuit(hand, ledSuit) {
  return ledSuit !== null && hand.some((c) => c.kind === 'number' && c.suit === ledSuit);
}

// Une carte est jouable compte tenu du pli en cours : toute carte spéciale
// l'est toujours : une numérotée seulement si elle respecte la couleur
// imposée, ou si le joueur n'a aucune carte de cette couleur.
function isCardPlayable(card, hand, trick) {
  if (card.kind !== 'number') return true;
  const ledSuit = ledSuitOf(trick);
  if (ledSuit === null || card.suit === ledSuit) return true;
  return !mustFollowSuit(hand, ledSuit);
}

// Kind "effectif" d'une carte telle que jouée dans un pli : une Tigresse
// devient soit un Pirate soit une Fuite, au choix fixé par le joueur au
// moment de la pose (card.chosenAs).
function effectiveKind(card) {
  return card.kind === 'tigress' ? card.chosenAs : card.kind;
}

// Cartes qui ne remportent jamais un pli et n'imposent jamais la couleur
// d'entame (en plus de la Fuite déjà gérée par ledSuitOf : kind !=='number'
// suffit pour ça). "neutralized" est un marqueur interne (jamais posé sur
// une vraie carte) utilisé pour désamorcer un Monstre Marin détruit par le
// Coffre de Davy Jones ou un Pirate retiré par Marcher sur la Planche, sans
// les faire compter comme des Fuites dans la règle "que des Fuites → la
// première gagne" (elles n'ont rien d'une Fuite, elles doivent juste être
// hors-course).
const NEVER_WINS = new Set(['escape', 'lastvolley', 'plank', 'davyjones', 'neutralized']);
const MONSTER_KINDS = ['kraken', 'whale', 'stingray'];

// Hiérarchie "normale" (aucun effet de Monstre Marin actif à ce stade,
// resolveTrick s'en est déjà chargé) : Fuite/Butin, Pirates/Mat le Forban,
// Sirènes, Skull King, numérotées.
function resolveHierarchy(cards, kinds) {
  // Un 0/14 déclaré à 0 ne remporte jamais le pli, exactement comme une
  // Fuite (mais il garde kind:'number' pour l'obligation de couleur) - donc
  // pris en compte ici aussi pour repérer "que des cartes qui ne gagnent
  // jamais".
  const neverWinning = (i) => NEVER_WINS.has(kinds[i]) || (kinds[i] === 'number' && cards[i].value === 0);

  // Butin exceptionnel : si le pli n'est composé que de cartes qui ne
  // gagnent jamais autrement (Fuite et assimilées, 0/14 déclaré à 0) +
  // éventuellement du Butin, le Butin l'emporte (le premier joué s'il y en
  // a deux) ; sinon, s'il n'y a QUE des Fuites, la première gagne (règle
  // inchangée) ; sinon (mélange avec au moins une carte "ne gagne jamais"
  // de l'extension ou un Monstre Marin neutralisé), personne ne gagne, le
  // pli est défaussé.
  if (kinds.every((k, i) => neverWinning(i) || k === 'loot')) {
    const lootIdx = kinds.indexOf('loot');
    if (lootIdx !== -1) return { winnerIdx: lootIdx };
    if (kinds.every((k) => k === 'escape')) return { winnerIdx: 0 };
    return { winnerIdx: null, allNeverWin: true };
  }

  const pirateIdx = [];
  const sirenIdx = [];
  let skIdx = -1;
  let firstMateIdx = -1;
  kinds.forEach((k, i) => {
    if (k === 'pirate') pirateIdx.push(i);
    else if (k === 'siren') sirenIdx.push(i);
    else if (k === 'skullking') skIdx = i;
    else if (k === 'firstmate') firstMateIdx = i;
  });

  // Sirène + Skull King présents ensemble : la Sirène ferme toujours la
  // boucle, qu'il y ait des Pirates/Mat le Forban ou non.
  if (skIdx !== -1 && sirenIdx.length) return { winnerIdx: sirenIdx[0] };
  // Skull King bat tout Pirate-tier (vrai Pirate OU Mat le Forban) quand il
  // est seul face à eux (pas de Sirène pour retourner la situation).
  if ((pirateIdx.length || firstMateIdx !== -1) && skIdx !== -1) return { winnerIdx: skIdx };
  // Mat le Forban perd aussi face à une Sirène SEULE (sans Skull King) -
  // contrairement aux vrais Pirates, qui battent une Sirène isolée.
  if (firstMateIdx !== -1 && sirenIdx.length) return { winnerIdx: sirenIdx[0] };
  if (pirateIdx.length || firstMateIdx !== -1) return { winnerIdx: firstMateIdx !== -1 ? firstMateIdx : pirateIdx[0] };
  if (skIdx !== -1) return { winnerIdx: skIdx };
  if (sirenIdx.length) return { winnerIdx: sirenIdx[0] };

  const numberIdx = [];
  kinds.forEach((k, i) => { if (k === 'number' && cards[i].value !== 0) numberIdx.push(i); });
  if (numberIdx.length === 0) return { winnerIdx: null, allNeverWin: true };
  const blackIdx = numberIdx.filter((i) => cards[i].suit === 'noir');
  const pool = blackIdx.length ? blackIdx : numberIdx.filter((i) => cards[i].suit === cards[numberIdx[0]].suit);
  return { winnerIdx: pool.reduce((best, i) => (cards[i].value > cards[best].value ? i : best)) };
}

// Résout un pli complet. `cards` est le tableau des cartes dans l'ordre de
// pose (index = ordre de jeu, stable, réutilisé par skullking-room.js pour
// retrouver quel joueur a posé quoi). Retourne :
// - winnerIdx : index de la carte qui remporte le pli (null si détruit).
// - leaderIdx : index dont le joueur entame le pli suivant (toujours
//   défini ; c'est l'entameur d'origine - index 0 - dans tous les cas où
//   personne ne peut gagner, y compris pour les Monstres Marins désormais,
//   sauf le Kraken qui garde son "gagnant virtuel").
// - destroyed : true si personne ne ramasse ce pli.
// - monstersDestroyed : nombre de Monstres Marins détruits par le Coffre de
//   Davy Jones ce pli-ci (0 sinon) — sert au bonus +20/monstre.
// - excludedIdx : Set des index à ignorer pour le calcul des bonus et pour
//   la liste des Pirates "capturés" (Monstres+Davy Jones détruits, Pirate
//   retiré par Marcher sur la Planche) - ces cartes restent dans le pli
//   affiché mais ne comptent plus pour rien après coup.
function resolveTrick(cards) {
  const rawKinds = cards.map(effectiveKind);
  const kinds = [...rawKinds];
  const excludedIdx = new Set();

  // Marcher sur la Planche : retire un Pirate précis du pli (ciblé au
  // moment de la pose, voir card.removesId côté skullking-room.js). La
  // carte retirée n'existe plus pour la suite (gagnant, bonus, pouvoir de
  // Mat le Forban) ; la Planche elle-même reste dans le pli sans jamais le
  // gagner.
  cards.forEach((c, i) => {
    if (effectiveKind(c) === 'plank' && c.removesId) {
      const targetIdx = cards.findIndex((cc) => cc.id === c.removesId);
      if (targetIdx !== -1) {
        excludedIdx.add(targetIdx);
        kinds[targetIdx] = 'neutralized';
      }
    }
  });

  // Coffre de Davy Jones : détruit TOUS les Monstres Marins présents (peu
  // importe leur nombre ou l'ordre de pose), lui-même y compris - priorité
  // absolue sur la règle "dernier Monstre joué décide" ci-dessous.
  let monstersDestroyed = 0;
  const davyIdx = kinds.indexOf('davyjones');
  if (davyIdx !== -1) {
    excludedIdx.add(davyIdx);
    kinds[davyIdx] = 'neutralized';
    kinds.forEach((k, i) => {
      if (!excludedIdx.has(i) && MONSTER_KINDS.includes(k)) {
        excludedIdx.add(i);
        monstersDestroyed += 1;
        kinds[i] = 'neutralized';
      }
    });
  } else {
    // Entre plusieurs Monstres Marins (Kraken/Baleine/Raie), le dernier
    // joué décide de l'effet appliqué ; les autres deviennent neutres.
    const monsterIdx = [];
    kinds.forEach((k, i) => { if (MONSTER_KINDS.includes(k)) monsterIdx.push(i); });
    for (let j = 0; j < monsterIdx.length - 1; j++) kinds[monsterIdx[j]] = 'escape';
  }

  const activeKraken = kinds.indexOf('kraken');
  const activeWhale = kinds.indexOf('whale');
  const activeStingray = kinds.indexOf('stingray');

  if (activeKraken !== -1) {
    // Le pli est détruit ; le pli suivant est mené par qui aurait gagné en
    // ignorant le Kraken (hiérarchie normale sur le reste, Kraken traité
    // comme une Fuite pour ce calcul).
    const virtualKinds = [...kinds];
    virtualKinds[activeKraken] = 'escape';
    const { winnerIdx: virtualWinner, allNeverWin } = resolveHierarchy(cards, virtualKinds);
    const leaderIdx = allNeverWin ? 0 : virtualWinner;
    // krakenIdx : QUI a détruit le pli. Un pli détruit ne l'est pas toujours
    // par le Kraken (Baleine ou Raie sur un pli sans numérotée le détruisent
    // aussi), et l'écran doit pouvoir montrer l'engloutissement sans avoir à
    // redeviner la cause depuis les cartes posées.
    return { winnerIdx: null, leaderIdx, destroyed: true, monstersDestroyed, excludedIdx, krakenIdx: activeKraken };
  }

  if (activeWhale !== -1 || activeStingray !== -1) {
    // Neutralise toutes les cartes spéciales : seule la valeur numérique
    // des numérotées compte, sans distinction de couleur ni statut d'atout
    // pour le noir. La Baleine fait gagner la plus haute valeur, la Raie
    // Tachetée la plus basse (jamais un 0/14 déclaré à 0).
    const monsterI = activeWhale !== -1 ? activeWhale : activeStingray;
    const pickLowest = activeWhale === -1;
    const numberIdx = [];
    kinds.forEach((k, i) => {
      if (k === 'number' && i !== monsterI && cards[i].value !== 0) numberIdx.push(i);
    });
    if (numberIdx.length === 0) {
      return { winnerIdx: null, leaderIdx: 0, destroyed: true, monstersDestroyed, excludedIdx };
    }
    const winnerIdx = numberIdx.reduce((best, i) => {
      const better = pickLowest ? cards[i].value < cards[best].value : cards[i].value > cards[best].value;
      return better ? i : best;
    });
    return { winnerIdx, leaderIdx: winnerIdx, destroyed: false, monstersDestroyed, excludedIdx };
  }

  const { winnerIdx, allNeverWin } = resolveHierarchy(cards, kinds);
  if (winnerIdx === null) {
    return { winnerIdx: null, leaderIdx: 0, destroyed: true, monstersDestroyed, excludedIdx };
  }
  return { winnerIdx, leaderIdx: winnerIdx, destroyed: false, monstersDestroyed, excludedIdx };
}

// Points bonus gagnés par le vainqueur d'UN pli (créditables seulement si
// son annonce de manche est réussie exactement — décidé au moment du score
// de fin de manche, pas ici). `excludedIdx` (Monstres/Davy Jones détruits,
// Pirate retiré par la Planche) ne compte pour rien ici, ni dans le calcul
// des 14/7/8 d'extension, ni dans la capture de Pirate(s)/Mat le Forban.
function trickBonusForWinner(cards, winnerIdx, excludedIdx = new Set()) {
  let bonus = 0;
  cards.forEach((c, i) => {
    if (excludedIdx.has(i)) return;
    if (c.kind !== 'number') return;
    if (c.value === 14) bonus += c.suit === 'noir' ? 20 : 10;
    if (c.ext && c.value === 8) bonus += 5;
    if (c.ext && c.value === 7) bonus -= 5;
  });
  const winnerKind = effectiveKind(cards[winnerIdx]);
  const activeCards = cards.filter((c, i) => !excludedIdx.has(i));
  const pirateCount = activeCards.filter((c) => effectiveKind(c) === 'pirate').length;
  // Mat le Forban compte "comme un pirate normal" pour le bonus de capture,
  // qu'il soit capturé par le Skull King (comme un vrai Pirate) OU par une
  // Sirène (élargissement propre à Mat, les vrais Pirates ne donnent ce
  // bonus que capturés par le Skull King).
  const firstMatePresent = activeCards.some((c) => effectiveKind(c) === 'firstmate');
  if (winnerKind === 'skullking') {
    bonus += pirateCount * 30;
    if (firstMatePresent) bonus += 30;
  }
  if (winnerKind === 'siren') {
    if (activeCards.some((c) => effectiveKind(c) === 'skullking')) bonus += 40;
    if (firstMatePresent) bonus += 30;
  }
  return bonus;
}

// bonus = somme des trickBonusForWinner accumulés pendant la manche par ce
// joueur (Davy Jones inclus : +20/Monstre détruit ajouté séparément côté
// skullking-room.js au même titre que trickBonusForWinner, car il dépend
// du nombre détruit CE pli-ci), créditée uniquement si son annonce est
// réussie exactement. Les bonus Butin (+20/+20) et la mise Rascal sont
// ajoutés séparément côté skullking-room.js, car ils dépendent de
// l'exactitude d'un AUTRE joueur.
function computeRoundScoreBreakdown(bid, made, roundNumber, bonus) {
  const exact = made === bid;
  let base;
  if (bid === 0) {
    base = exact ? 10 * roundNumber : -10 * roundNumber;
  } else {
    base = exact ? 20 * bid : -10 * Math.abs(bid - made);
  }
  const appliedBonus = exact ? bonus : 0;
  return { base, bonus: appliedBonus, total: base + appliedBonus };
}

function computeRoundScore(bid, made, roundNumber, bonus) {
  return computeRoundScoreBreakdown(bid, made, roundNumber, bonus).total;
}

module.exports = {
  SUITS,
  MONSTER_KINDS,
  PIRATE_NAMES,
  EXTENSION_PIRATE_NAME,
  PIRATE_POWER_BY_NAME,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_PLAYERS_EXTENDED,
  EXTENSION_MODULES,
  EXTENSION_KEYS,
  extensionSet,
  deckSizeFor,
  MIN_ROUNDS,
  MAX_ROUNDS,
  clampRounds,
  maxPlayersFor,
  buildRoundSequence,
  createDeck,
  dealRound,
  isValidBid,
  ledSuitOf,
  mustFollowSuit,
  isCardPlayable,
  effectiveKind,
  resolveTrick,
  trickBonusForWinner,
  computeRoundScore,
  computeRoundScoreBreakdown,
};
