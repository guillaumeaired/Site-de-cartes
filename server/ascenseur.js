// Logique pure de L'Ascenseur (variante du Oh Hell!) : séquence de manches,
// donne + atout, validation des annonces, résolution de plis, score. Aucune
// dépendance à Socket.io, testable seule via ascenseur-simulate.js avant de
// brancher les vrais sockets.

const { createDeck, shuffle } = require('./game');

const SUIT_ORDER = ['coeur', 'carreau', 'trefle', 'pique'];

// Nombre max de cartes par joueur : on distribue le plus possible du paquet
// de 52 cartes, une carte étant ensuite retournée pour définir l'atout. Si
// la division tombe pile (ex: 52/4=13), il ne reste aucune carte à retourner
// : la manche au sommet de l'ascenseur se joue alors sans atout.
function maxCardsFor(playerCount) {
  return Math.floor(52 / playerCount);
}

// Séquence des manches : 1, 2, ..., max, ..., 2, 1 (montée puis descente).
function buildRoundSequence(playerCount) {
  const max = maxCardsFor(playerCount);
  const up = Array.from({ length: max }, (_, i) => i + 1);
  const down = up.slice(0, -1).reverse();
  return [...up, ...down];
}

// Distribue `cardsPerPlayer` cartes à chaque joueur et retourne la carte
// suivante comme atout (null si le paquet est épuisé pile).
function dealRound(playerCount, cardsPerPlayer) {
  const deck = shuffle(createDeck()).map((card, i) => ({ id: `a${i}`, ...card }));
  const hands = Array.from({ length: playerCount }, () => []);
  for (let i = 0; i < cardsPerPlayer * playerCount; i++) {
    hands[i % playerCount].push(deck[i]);
  }
  const rest = deck.slice(cardsPerPlayer * playerCount);
  const trumpCard = rest.length > 0 ? rest[0] : null;
  return { hands, trumpCard, trumpSuit: trumpCard ? trumpCard.suit : null };
}

// Un joueur (le donneur, dernier à annoncer) ne peut pas choisir la valeur
// qui ferait que la somme totale des annonces égale le nombre de plis en
// jeu. Les autres joueurs annoncent librement entre 0 et le nombre de plis.
function isValidBid(bid, cardsInRound, priorBidsSum, isLastBidder) {
  if (!Number.isInteger(bid) || bid < 0 || bid > cardsInRound) return false;
  if (isLastBidder && priorBidsSum + bid === cardsInRound) return false;
  return true;
}

// Détermine l'index (dans `cards`, un par joueur dans l'ordre de jeu) du
// gagnant du pli : la plus haute carte de la couleur demandée l'emporte,
// sauf si un ou plusieurs atouts ont été joués, auquel cas le plus haut
// atout l'emporte.
function resolveTrick(cards, ledSuit, trumpSuit) {
  const trumps = cards.filter((c) => c.suit === trumpSuit);
  const pool = trumps.length > 0 ? trumps : cards.filter((c) => c.suit === ledSuit);
  const best = pool.reduce((a, b) => (b.value > a.value ? b : a));
  return cards.indexOf(best);
}

// Score d'un joueur pour une manche donnée.
function computeRoundScore(bid, made, roundNumber) {
  if (bid === 0) {
    return made === 0 ? 5 * roundNumber : -5 * roundNumber;
  }
  if (made === bid) return 10 * bid;
  return -10 * Math.abs(bid - made);
}

module.exports = {
  SUIT_ORDER,
  maxCardsFor,
  buildRoundSequence,
  dealRound,
  isValidBid,
  resolveTrick,
  computeRoundScore,
};
