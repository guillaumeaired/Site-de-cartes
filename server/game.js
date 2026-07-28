const SUITS = ['coeur', 'carreau', 'trefle', 'pique'];
const RANKS = [
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
  { label: '9', value: 9 },
  { label: '10', value: 10 },
  { label: 'V', value: 11 },
  { label: 'D', value: 12 },
  { label: 'R', value: 13 },
  { label: 'A', value: 14 },
];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, label: rank.label, value: rank.value });
    }
  }
  return deck;
}

function shuffle(deck) {
  const cards = [...deck];
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

// Distribue le paquet en rotation entre playerCount joueurs (2 a 4), aussi
// equitablement que possible : ex. 3 joueurs -> 18/17/17. Retourne un tableau
// de mains, dans le meme ordre que les joueurs.
function dealHands(playerCount) {
  const deck = shuffle(createDeck());
  const hands = Array.from({ length: playerCount }, () => []);
  deck.forEach((card, i) => hands[i % playerCount].push(card));
  return hands;
}

// Retire et retourne jusqu'a n cartes du dessus d'une main (pour la bataille).
// Peut en retourner moins si la main est presque vide.
function buryUpToN(hand, n) {
  return hand.splice(0, Math.min(n, hand.length));
}

module.exports = { createDeck, shuffle, dealHands, buryUpToN };
