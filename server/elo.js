// Elo à plusieurs : une partie de Skull King à N joueurs classés se lit comme
// N(N-1)/2 duels. Chaque paire compare son total de fin de partie (victoire,
// nul à égalité de points, défaite) et rapporte l'écart à ce que les deux
// cotes laissaient prévoir. La somme est ramenée à un seul duel en divisant
// par N-1 : sans ça, une table de sept ferait bouger les cotes six fois plus
// qu'un duel, et le classement ne mesurerait plus que le nombre de parties
// jouées à grande table.
//
// Fonction pure, sans base ni réseau : c'est ce qui la rend testable seule
// (voir comptes-simulate.js).

const ELO_INITIAL = 1200;
const K = 32;

function expected(ra, rb) {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

// players : [{ userId, elo, score }] - renvoie [{ userId, before, after, delta }]
// dans le même ordre. Le delta est arrondi à l'entier, comme l'affichage.
function computeEloChanges(players) {
  const n = players.length;
  if (n < 2) return players.map((p) => ({ userId: p.userId, before: p.elo, after: p.elo, delta: 0 }));
  return players.map((p, i) => {
    let sum = 0;
    players.forEach((q, j) => {
      if (i === j) return;
      const actual = p.score > q.score ? 1 : p.score === q.score ? 0.5 : 0;
      sum += actual - expected(p.elo, q.elo);
    });
    const delta = Math.round((K / (n - 1)) * sum);
    return { userId: p.userId, before: p.elo, after: p.elo + delta, delta };
  });
}

module.exports = { ELO_INITIAL, computeEloChanges, expected };
