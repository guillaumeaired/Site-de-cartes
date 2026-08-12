// Logique pure du Rami Français : deck, distribution, valeur des cartes et
// validation des combinaisons. Aucune dépendance à Socket.io, pour rester
// testable seule via rami-simulate.js avant de brancher les vrais sockets.

const SUITS = ['coeur', 'carreau', 'trefle', 'pique'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R', 'A'];
const FACE_VALUE = { V: 10, D: 10, R: 10 };

// Les rangs forment un cercle (comme sur une horloge) : après le Roi on
// retrouve l'As, puis le 2 — une séquence peut donc se former dans les deux
// sens et enjamber cette frontière (ex : D-R-A, R-A-2, A-2-3...).
const RANK_CIRCLE = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R'];

function rotate(order, start) {
  return [...order.slice(start), ...order.slice(0, start)];
}

function baseRankValue(rank) {
  if (FACE_VALUE[rank]) return FACE_VALUE[rank];
  return Number(rank);
}

// As = 15 points fixes (ne dépend plus de sa position en séquence). Le 2 de
// cœur (joker) est traité à part, voir handCardValue.
function cardFaceValue(rank) {
  return rank === 'A' ? 15 : baseRankValue(rank);
}

function shuffle(cards) {
  const arr = [...cards];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 1 jeu de 52 cartes pour 2 joueurs, 2 jeux (104 cartes) à partir de 3. Pas
// de carte Joker séparée : le 2 de cœur de chaque jeu tient ce rôle
// (isJoker: true), tout en gardant son rang/couleur pour l'affichage.
function createDeck(deckCount = 1) {
  const deck = [];
  let uid = 0;
  for (let copy = 0; copy < deckCount; copy++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        const isWildcard = rank === '2' && suit === 'coeur';
        deck.push({ id: `c${uid++}`, rank, suit, isJoker: isWildcard });
      }
    }
  }
  return deck;
}

// 7 cartes par joueur, personne n'est avantagé au départ.
function dealHands(playerCount) {
  const deckCount = playerCount <= 2 ? 1 : 2;
  const deck = shuffle(createDeck(deckCount));
  const hands = [];
  for (let p = 0; p < playerCount; p++) {
    hands.push(deck.splice(0, 7));
  }
  return { hands, drawPile: deck };
}

// Brelan / carré : 3-4 cartes de même rang, couleurs toutes différentes,
// au plus 1 Joker.
function isValidSet(cards) {
  if (cards.length < 3 || cards.length > 4) return false;
  const jokers = cards.filter((c) => c.isJoker);
  const reals = cards.filter((c) => !c.isJoker);
  if (jokers.length > 1 || reals.length === 0) return false;
  const rank = reals[0].rank;
  if (!reals.every((c) => c.rank === rank)) return false;
  const suits = new Set(reals.map((c) => c.suit));
  return suits.size === reals.length;
}

// Tente de "résoudre" une séquence selon un ordre donné (As bas ou As haut) :
// place chaque carte réelle à son index, comble les trous avec le(s)
// Joker(s), et étend aux extrémités s'il reste un Joker après avoir comblé
// les trous. Retourne les cases ordonnées avec la valeur de chacune, ou null
// si ça ne correspond pas à cet ordre.
function resolveWithOrder(reals, jokers, order) {
  const idx = reals.map((c) => order.indexOf(c.rank));
  if (idx.some((i) => i === -1)) return null;
  if (new Set(idx).size !== idx.length) return null; // rang en double

  const min = Math.min(...idx);
  const max = Math.max(...idx);
  const span = max - min + 1;
  const gaps = span - idx.length;
  let extra = jokers.length - gaps;
  if (extra < 0) return null;

  let lo = min;
  let hi = max;
  while (extra > 0) {
    if (lo > 0) {
      lo -= 1;
    } else if (hi < order.length - 1) {
      hi += 1;
    } else {
      return null; // plus de place des deux côtés
    }
    extra -= 1;
  }
  if (hi - lo + 1 !== reals.length + jokers.length) return null;

  const realByIdx = new Map(reals.map((c, i) => [idx[i], c]));
  const jokerPool = [...jokers];
  const slots = [];
  for (let i = lo; i <= hi; i++) {
    const rank = order[i];
    const value = cardFaceValue(rank);
    if (realByIdx.has(i)) {
      slots.push({ card: realByIdx.get(i), rank, value, isJokerSlot: false });
    } else {
      slots.push({ card: jokerPool.shift() || null, rank, value, isJokerSlot: true });
    }
  }
  return slots;
}

// Séquence : au moins 3 cartes consécutives de même couleur, au plus 1
// Joker. Retourne les cases résolues (avec valeur par carte) ou null si
// invalide.
//
// Quand les cartes réelles forment déjà une suite sans trou et qu'il reste
// un Joker "en trop" (ni comblant un trou interne), il peut étendre la suite
// d'un côté OU de l'autre : les deux placements sont valides et changent le
// rang (donc la valeur) que représente le Joker. extendHint ('low' | 'high')
// permet de choisir explicitement ; sans hint, on garde le comportement
// historique = le premier trouvé (extension basse en priorité).
function resolveSequence(cards, extendHint) {
  if (cards.length < 3) return null;
  const jokers = cards.filter((c) => c.isJoker);
  const reals = cards.filter((c) => !c.isJoker);
  if (jokers.length > 1 || reals.length === 0) return null;

  const suit = reals[0].suit;
  if (!reals.every((c) => c.suit === suit)) return null;

  const distinct = new Map();
  for (let start = 0; start < RANK_CIRCLE.length; start++) {
    const result = resolveWithOrder(reals, jokers, rotate(RANK_CIRCLE, start));
    if (!result) continue;
    const key = result.map((s) => s.rank).join('-');
    if (!distinct.has(key)) distinct.set(key, result);
  }
  if (distinct.size === 0) return null;

  const options = [...distinct.values()];
  if (options.length === 1 || !extendHint) return options[0];

  for (const option of options) {
    const jokerIdx = option.findIndex((s) => s.isJokerSlot);
    const isLowEnd = jokerIdx === 0;
    if ((extendHint === 'low') === isLowEnd) return option;
  }
  return options[0];
}

function isValidSequence(cards) {
  return resolveSequence(cards) !== null;
}

// Type d'une combinaison ('set' | 'sequence' | null si invalide).
function classifyMeld(cards) {
  if (isValidSet(cards)) return 'set';
  if (isValidSequence(cards)) return 'sequence';
  return null;
}

// Valeur totale d'une combinaison déjà validée (type connu). extendHint est
// transmis tel quel à resolveSequence (voir son commentaire) pour rester
// cohérent avec le placement du Joker réellement choisi à la pose.
function meldPoints(cards, type, extendHint) {
  if (type === 'set') {
    const reals = cards.filter((c) => !c.isJoker);
    return cardFaceValue(reals[0].rank) * cards.length;
  }
  if (type === 'sequence') {
    const slots = resolveSequence(cards, extendHint);
    return slots ? slots.reduce((sum, s) => sum + s.value, 0) : 0;
  }
  return 0;
}

const WILDCARD_HAND_PENALTY = 25;

// Valeur d'une carte encore en main (hors combinaison) en fin de partie :
// le 2 de cœur (joker) coûte cher s'il n'a pas été utilisé.
function handCardValue(card) {
  return card.isJoker ? WILDCARD_HAND_PENALTY : cardFaceValue(card.rank);
}

// Contrat des 30 points pour la première pose : la somme de toutes les
// combinaisons proposées doit atteindre 30 (le 2 de cœur peut y participer).
// extendHints (parallèle à melds) est transmis à meldPoints pour rester
// cohérent avec le placement du Joker réellement choisi à la pose.
function canInitialMeld(melds, extendHints = []) {
  let total = 0;
  for (let i = 0; i < melds.length; i++) {
    const cards = melds[i];
    const type = classifyMeld(cards);
    if (!type) return false;
    total += meldPoints(cards, type, extendHints[i]);
  }
  return total >= 30;
}

module.exports = {
  SUITS,
  RANKS,
  shuffle,
  createDeck,
  dealHands,
  isValidSet,
  isValidSequence,
  resolveSequence,
  classifyMeld,
  cardFaceValue,
  meldPoints,
  handCardValue,
  canInitialMeld,
};
