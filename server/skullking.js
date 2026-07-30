// Logique pure de Skull King (règles complètes : jeu de base + Butin,
// Kraken, Baleine blanche) : deck, résolution de pli (hiérarchie
// non-transitive), bonus, score. Aucune dépendance à Socket.io, testable
// seule via skullking-simulate.js avant de brancher les vrais sockets.

const { shuffle } = require('./game');

const SUITS = ['vert', 'jaune', 'violet', 'noir'];
const PIRATE_NAMES = ["Rosie D'Laney", 'Will le Bandit', 'Rascal le Flambeur', 'Juanita Jade', 'Harry le Géant'];

// Clé courte du pouvoir associé à chaque pirate nommé, utilisée côté
// serveur (skullking-room.js) pour savoir quelle phase de pouvoir déclencher
// quand ce pirate remporte un pli.
const PIRATE_POWER_BY_NAME = {
  "Rosie D'Laney": 'rosie',
  'Will le Bandit': 'will',
  'Rascal le Flambeur': 'rascal',
  'Juanita Jade': 'juanita',
  'Harry le Géant': 'harry',
};

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 7; // le deck (74 cartes) suffit largement pour 7 joueurs à la manche 10 (70 cartes)

function buildRoundSequence() {
  return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
}

// 4x14 numérotées + 2 Sirènes + 5 Pirates nommés + 1 Skull King + 5 Fuites +
// 1 Tigresse + 2 Butins + 1 Kraken + 1 Baleine blanche = 74 cartes.
function createDeck() {
  const deck = [];
  let uid = 0;
  for (const suit of SUITS) {
    for (let value = 1; value <= 14; value++) {
      deck.push({ id: `s${uid++}`, kind: 'number', suit, value });
    }
  }
  for (let i = 0; i < 2; i++) deck.push({ id: `s${uid++}`, kind: 'siren' });
  for (const name of PIRATE_NAMES) deck.push({ id: `s${uid++}`, kind: 'pirate', name });
  deck.push({ id: `s${uid++}`, kind: 'skullking' });
  for (let i = 0; i < 5; i++) deck.push({ id: `s${uid++}`, kind: 'escape' });
  deck.push({ id: `s${uid++}`, kind: 'tigress' });
  for (let i = 0; i < 2; i++) deck.push({ id: `s${uid++}`, kind: 'loot' });
  deck.push({ id: `s${uid++}`, kind: 'kraken' });
  deck.push({ id: `s${uid++}`, kind: 'whale' });
  return deck;
}

// Le deck complet est remélangé à chaque manche. Les cartes non distribuées
// (le "residualPile") restent visibles/piochables ce tour-ci via les
// pouvoirs de Juanita Jade et Will le Bandit — elles disparaissent ensuite,
// sans incidence sur les manches suivantes puisque le deck est entièrement
// recréé à chaque fois.
function dealRound(playerCount, cardsPerPlayer) {
  const deck = shuffle(createDeck());
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
// échéant). Toutes les cartes spéciales (Pirates, Sirènes, Skull King,
// Fuite, Tigresse, Butin, Kraken, Baleine) restent toujours jouables quelle
// que soit la couleur demandée : seules les numérotées y sont soumises.
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

// Hiérarchie du jeu de base (Fuite/Butin, Pirates, Sirènes, Skull King,
// numérotées), sans Kraken ni Baleine blanche — utilisée à la fois pour le
// cas normal et pour calculer le gagnant "virtuel" que le Kraken détruit.
function resolveHierarchy(cards, kinds) {
  // Fuites et Butin ne gagnent jamais, SAUF si le pli n'est composé que de
  // ça : dans ce cas précis, le Butin l'emporte exceptionnellement (le
  // premier joué s'il y en a deux) ; à défaut, la 1ère Fuite jouée "gagne"
  // par convention (aucune règle officielle ne couvre ce cas).
  if (kinds.every((k) => k === 'escape' || k === 'loot')) {
    const lootIdx = kinds.indexOf('loot');
    return lootIdx !== -1 ? lootIdx : 0;
  }

  const pirateIdx = [];
  const sirenIdx = [];
  let skIdx = -1;
  kinds.forEach((k, i) => {
    if (k === 'pirate') pirateIdx.push(i);
    else if (k === 'siren') sirenIdx.push(i);
    else if (k === 'skullking') skIdx = i;
  });

  if (pirateIdx.length && skIdx !== -1 && sirenIdx.length) return sirenIdx[0];
  if (pirateIdx.length && skIdx !== -1) return skIdx;
  if (skIdx !== -1 && sirenIdx.length) return sirenIdx[0];
  if (pirateIdx.length) return pirateIdx[0];
  if (skIdx !== -1) return skIdx;
  if (sirenIdx.length) return sirenIdx[0];

  const numberIdx = [];
  kinds.forEach((k, i) => { if (k === 'number') numberIdx.push(i); });
  const blackIdx = numberIdx.filter((i) => cards[i].suit === 'noir');
  const pool = blackIdx.length ? blackIdx : numberIdx.filter((i) => cards[i].suit === cards[numberIdx[0]].suit);
  return pool.reduce((best, i) => (cards[i].value > cards[best].value ? i : best));
}

// Résout un pli complet. Retourne { winnerIdx, leaderIdx, destroyed } :
// - winnerIdx : index de la carte qui remporte le pli (null si détruit).
// - leaderIdx : index dont le joueur entame le pli suivant (toujours défini).
// - destroyed : true si personne ne ramasse ce pli (Kraken, ou Baleine sans
//   aucune carte numérotée pour départager).
function resolveTrick(cards) {
  const rawKinds = cards.map(effectiveKind);
  let krakenIdx = rawKinds.indexOf('kraken');
  let whaleIdx = rawKinds.indexOf('whale');
  const kinds = [...rawKinds];

  // Kraken + Baleine dans le même pli : celle jouée en second l'emporte et
  // applique son effet ; l'autre devient une simple Fuite pour le reste de
  // la résolution.
  if (krakenIdx !== -1 && whaleIdx !== -1) {
    if (krakenIdx < whaleIdx) {
      kinds[krakenIdx] = 'escape';
      krakenIdx = -1;
    } else {
      kinds[whaleIdx] = 'escape';
      whaleIdx = -1;
    }
  }

  if (krakenIdx !== -1) {
    // Le pli est détruit ; le pli suivant est mené par qui aurait gagné en
    // ignorant le Kraken (calculé sur les autres cartes, hiérarchie normale,
    // Kraken traité comme une Fuite).
    const virtualKinds = [...kinds];
    virtualKinds[krakenIdx] = 'escape';
    const leaderIdx = resolveHierarchy(cards, virtualKinds);
    return { winnerIdx: null, leaderIdx, destroyed: true };
  }

  if (whaleIdx !== -1) {
    // Neutralise toutes les cartes spéciales (dont un Kraken déjà neutralisé
    // ci-dessus) : seule la valeur numérique des numérotées compte, sans
    // distinction de couleur ni statut d'atout pour le noir.
    const numberIdx = [];
    kinds.forEach((k, i) => { if (k === 'number' && i !== whaleIdx) numberIdx.push(i); });
    if (numberIdx.length === 0) {
      // Que des spéciales en plus de la Baleine : pli détruit, mené par le
      // joueur de la Baleine (pas de gagnant "virtuel" ici, contrairement
      // au Kraken — la Baleine n'a pas cette règle).
      return { winnerIdx: null, leaderIdx: whaleIdx, destroyed: true };
    }
    // Égalité de valeur entre deux couleurs différentes (possible ici,
    // puisque la couleur ne compte plus) : la première jouée l'emporte, par
    // cohérence avec toutes les autres égalités de ce jeu.
    const winnerIdx = numberIdx.reduce((best, i) => (cards[i].value > cards[best].value ? i : best));
    return { winnerIdx, leaderIdx: winnerIdx, destroyed: false };
  }

  const winnerIdx = resolveHierarchy(cards, kinds);
  return { winnerIdx, leaderIdx: winnerIdx, destroyed: false };
}

// Points bonus gagnés par le vainqueur d'UN pli (créditables seulement si
// son annonce de manche est réussie exactement — décidé au moment du score
// de fin de manche, pas ici). Inchangé par la Baleine : les 14 comptent pour
// la carte physiquement capturée, indépendamment de pourquoi le pli a été
// gagné.
function trickBonusForWinner(cards, winnerIdx) {
  let bonus = 0;
  for (const c of cards) {
    if (c.kind === 'number' && c.value === 14) bonus += c.suit === 'noir' ? 20 : 10;
  }
  const winnerKind = effectiveKind(cards[winnerIdx]);
  if (winnerKind === 'skullking') {
    bonus += cards.filter((c) => effectiveKind(c) === 'pirate').length * 30;
  }
  if (winnerKind === 'siren' && cards.some((c) => effectiveKind(c) === 'skullking')) {
    bonus += 40;
  }
  return bonus;
}

// bonus = somme des trickBonusForWinner accumulés pendant la manche par ce
// joueur, créditée uniquement si son annonce est réussie exactement. Les
// bonus Butin (+20/+20) et la mise Rascal sont ajoutés séparément côté
// skullking-room.js, car ils dépendent de l'exactitude d'un AUTRE joueur.
// Détail du score d'une manche : `base` (le contrat réussi/raté seul) et
// `bonus` (14 de couleur/noir, capture de Pirate(s)/Skull King, séparés) -
// exposé pour que le résumé de fin de manche puisse afficher les deux au
// lieu d'un seul delta agrégé.
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
  PIRATE_NAMES,
  PIRATE_POWER_BY_NAME,
  MIN_PLAYERS,
  MAX_PLAYERS,
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
