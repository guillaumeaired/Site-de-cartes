// Le paquet de 52 cartes classique et son mélange, partagés par les jeux qui
// s'en servent : L'Ascenseur (createDeck + shuffle) et le Skull King (shuffle
// seul, ses cartes lui étant propres). L'as y vaut 14, il bat le roi — c'est
// la convention des jeux de plis. Le 24 a son propre paquet, où l'as vaut 1.
//
// Ce fichier servait d'abord la Bataille, d'où son nom : il portait aussi
// dealHands et buryUpToN, partis avec elle le 31 août 2026.

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

module.exports = { createDeck, shuffle };
