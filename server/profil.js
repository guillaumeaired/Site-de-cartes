// Le profil d'un compte, relu dans l'historique des parties classées
// (sk_games) : la courbe de sa cote et ses duels contre chacun des autres
// comptes. Rien n'est stocké en plus : chaque partie classée garde déjà, pour
// chaque compte à table, sa cote d'avant et d'après (voir rateGame dans
// skullking-room.js). Le profil se recalcule donc aussi sur les parties
// jouées avant qu'il n'existe.
//
// Un duel se lit comme au calcul de l'Elo (voir elo.js) : à la fin d'une
// partie, chaque paire de comptes compare son total. Plus de points, c'est
// une victoire ; autant, un nul ; celui qui a quitté la table perd contre
// tous ceux qui sont restés.
//
// Fonction pure, sans base ni réseau (testée dans comptes-simulate.js).

const SOUS_FIFRES_MAX = 3;

// Le compte d'une ligne de partie. Les parties récentes portent l'id du
// compte ; les plus anciennes seulement son pseudo (`account`), ou à défaut le
// pseudo de table. Seules les lignes qui ont une cote (`elo`) sont des comptes
// classés : invités et bots n'entrent pas dans les duels.
function compteDeLigne(ligne, idParCle, cle) {
  if (!ligne || !ligne.elo) return null;
  if (ligne.userId != null) return ligne.userId;
  const nom = ligne.account || ligne.nickname;
  return nom ? idParCle.get(cle(nom)) || null : null;
}

function issue(moi, autre) {
  if (moi.left && autre.left) return 'nul';
  if (moi.left) return 'defaite';
  if (autre.left) return 'victoire';
  if (moi.total > autre.total) return 'victoire';
  if (moi.total < autre.total) return 'defaite';
  return 'nul';
}

// Les meilleurs d'une liste selon `cle`, avec les ex aequo de la dernière
// place retenue : trois sous-fifres, ou quatre si le troisième et le
// quatrième ont autant de victoires.
function enTete(liste, cle, max) {
  const tries = liste.filter((x) => x[cle] > 0).sort((a, b) => b[cle] - a[cle]);
  if (tries.length <= max) return tries;
  const seuil = tries[max - 1][cle];
  return tries.filter((x) => x[cle] >= seuil);
}

// games : [{ playedAt, results: [{ userId?, account?, nickname, total, left, elo }] }]
//         dans l'ordre où elles ont été jouées
// users : [{ id, pseudo, piece }]
// cle   : la clé d'unicité d'un pseudo (pseudoKey de comptes.js, passée ici
//         pour ne pas lier les deux fichiers dans les deux sens)
function profilDepuisParties(userId, games, users, cle) {
  const idParCle = new Map(users.map((u) => [cle(u.pseudo), u.id]));
  const userParId = new Map(users.map((u) => [u.id, u]));

  const courbe = [];
  const duels = new Map(); // id adverse -> { victoires, defaites, nuls }

  for (const g of games) {
    const lignes = (g.results || []).map((l) => ({ ...l, compte: compteDeLigne(l, idParCle, cle) }));
    const moi = lignes.find((l) => l.compte === userId);
    if (!moi) continue;

    if (!courbe.length) courbe.push({ at: null, elo: moi.elo.before });
    courbe.push({ at: g.playedAt, elo: moi.elo.after, delta: moi.elo.delta });

    const vus = new Set([userId]);
    for (const autre of lignes) {
      if (autre.compte == null || vus.has(autre.compte)) continue;
      vus.add(autre.compte);
      const d = duels.get(autre.compte) || { victoires: 0, defaites: 0, nuls: 0 };
      const r = issue(moi, autre);
      if (r === 'victoire') d.victoires += 1;
      else if (r === 'defaite') d.defaites += 1;
      else d.nuls += 1;
      duels.set(autre.compte, d);
    }
  }

  const adversaires = [...duels.entries()]
    .filter(([id]) => userParId.has(id))
    .map(([id, d]) => {
      const u = userParId.get(id);
      return { id, pseudo: u.pseudo, piece: u.piece || null, ...d };
    })
    .sort((a, b) => a.pseudo.localeCompare(b.pseudo, 'fr'));

  const pireDefaites = Math.max(0, ...adversaires.map((a) => a.defaites));
  const nemesis = pireDefaites > 0 ? adversaires.filter((a) => a.defaites === pireDefaites) : [];
  const sousFifres = enTete(adversaires, 'victoires', SOUS_FIFRES_MAX);

  return { courbe, adversaires, nemesis, sousFifres };
}

module.exports = { profilDepuisParties };
