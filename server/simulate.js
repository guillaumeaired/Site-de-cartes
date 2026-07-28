const { dealHands, shuffle, buryUpToN } = require('./game');

// Reproduit la logique de resolution multijoueur (2 a 4) de facon synchrone,
// pour verifier que les regles sont saines avant de les brancher sur le
// serveur : la partie se termine toujours et le nombre de cartes en
// circulation ne varie jamais (sauf le tres rare cas d'egalite totale ou
// plusieurs joueurs se vident en meme temps pendant une bataille, auquel cas
// le pli abandonne est explicitement compte a part).
function playFullGame(playerCount) {
  const hands = dealHands(playerCount);
  const players = hands.map((hand, id) => ({ id, hand }));
  const activeIds = () => players.filter((p) => p.hand.length > 0).map((p) => p.id);

  let pile = [];
  let contenders = activeIds();
  const revealed = {};
  let rounds = 0;
  let discarded = 0;

  while (activeIds().length > 1) {
    rounds++;
    if (rounds > 200000) {
      throw new Error('trop de tours, boucle infinie probable');
    }

    for (const id of contenders) {
      const card = players[id].hand.shift();
      pile.push(card);
      revealed[id] = card;
    }

    const max = Math.max(...contenders.map((id) => revealed[id].value));
    const winners = contenders.filter((id) => revealed[id].value === max);
    for (const id of contenders) delete revealed[id];

    if (winners.length === 1) {
      players[winners[0]].hand.push(...shuffle(pile));
      pile = [];
      contenders = activeIds();
    } else {
      const n = 3;
      for (const id of winners) {
        const hand = players[id].hand;
        // On garde toujours au moins 1 carte pour le tirage decisif.
        const burySize = Math.min(n, Math.max(hand.length - 1, 0));
        pile.push(...buryUpToN(hand, burySize));
      }
      const stillIn = winners.filter((id) => players[id].hand.length > 0);
      if (stillIn.length >= 2) {
        contenders = stillIn;
      } else {
        if (stillIn.length === 1) {
          players[stillIn[0]].hand.push(...shuffle(pile));
        } else {
          discarded += pile.length; // egalite totale : cas rarissime, pli abandonne
        }
        pile = [];
        contenders = activeIds();
      }
    }

    const inHands = players.reduce((sum, p) => sum + p.hand.length, 0);
    const total = inHands + pile.length + discarded;
    if (total !== 52) {
      throw new Error(`total de cartes = ${total} au lieu de 52 (tour ${rounds})`);
    }
  }

  return { rounds, winner: activeIds()[0], players, discarded };
}

for (const playerCount of [2, 3, 4]) {
  console.log(`--- ${playerCount} joueurs ---`);
  for (let i = 0; i < 5; i++) {
    const { rounds, winner, players, discarded } = playFullGame(playerCount);
    const counts = players.map((p) => p.hand.length).join('/');
    console.log(
      `Partie terminee en ${rounds} tours. Gagnant : joueur ${winner}. Mains finales : ${counts}` +
        (discarded ? ` (cartes abandonnees: ${discarded})` : '')
    );
  }
}
