// Niveau 2 — le Matelot (intermédiaire). Ce qui le fait gagner, l'arène l'a
// montré, c'est surtout son ANNONCE : il ne joue pas l'espérance arrondie de
// ses plis, mais l'annonce qui rapporte le plus en moyenne (un 0 tenu en fin
// de partie vaut bien plus qu'un 1). En jeu, il applique la règle de base de
// tout jeu de plis — gagner avec la plus petite carte qui tient quand il lui
// manque des plis, perdre avec la plus grosse carte qui perd quand il a son
// compte — et en plus :
//
// - il se souvient des cartes tombées depuis le début de la manche et de qui
//   a coupé quelle couleur — peu de chose à Skull King, où le reliquat est
//   énorme, mais pas rien ;
// - il lit les annonces : un adversaire qui a son compte ne prendra pas le
//   pli s'il peut l'éviter, celui à qui il en manque le prendra ;
// - quand il faut tout gagner, il joue sa meilleure chance ;
// - entre deux coups qui gagnent, il prend celui qui ramasse des bonus ;
// - quand il veut perdre, et à rang de carte presque égal, il préfère le
//   coup qui colle le pli à quelqu'un qui n'en voulait pas ;
// - ses pouvoirs servent sa manche (Rosie le met en dernière main, Rascal
//   mise quand le contrat est tenu, Mary Thorne vise le joueur de tête).

const { resolveTrick, trickBonusForWinner } = require('../skullking');
const {
  forceStatique,
  chanceManche1,
  meilleureAnnonce,
  plisManquants,
  plisRestants,
  moi,
} = require('./commun');
const tactique = require('./tactique');

const OPTIONS = { avecMemoire: true, intentions: true };
const { TIENT } = tactique;
const RATTRAPAGE = 0.8;
// Le poids de la nuisance quand le bot veut perdre : un simple départage
// entre coups de rang voisin. Plus fort, elle passait avant le fait de se
// défaire de ses grosses cartes, et coûtait 5 points par partie à l'arène.
const POIDS_NUISANCE = 3;

function bid(state) {
  if (state.cardsInRound === 1 && (state.hand || []).every((c) => c.kind === 'hidden')) {
    return chanceManche1(state) >= 0.5 ? 1 : 0;
  }
  // Pas l'espérance arrondie : l'annonce au meilleur gain espéré (voir
  // meilleureAnnonce). Le rattrapage de 0,8 est celui qui gagnait le plus à
  // l'arène, à 3, 4 et 6 joueurs.
  const n = state.players.length;
  const ps = (state.hand || []).map((c) => forceStatique(c, n));
  return meilleureAnnonce(ps, state.cardsInRound, state.roundNumber, { rattrapage: RATTRAPAGE });
}

// Ce que le pli rapporterait de bonus à celui qui le prend avec ce coup
// (14 capturés, Sirènes sous un Pirate, Pirates sous le Skull King,
// Skull King sous la Sirène…).
function bonusDuCoup(state, coup) {
  const cartes = [...(state.currentTrick || []).map((t) => t.card), coup.posee];
  const r = resolveTrick(cartes);
  if (r.destroyed || r.winnerIdx !== cartes.length - 1) return 0;
  return trickBonusForWinner(cartes, r.winnerIdx, r.excludedIdx);
}

// Si je perds ce pli avec ce coup, à qui il reviendrait à l'instant — et cela
// arrange-t-il le bot ? Un pli imposé à quelqu'un qui a déjà son compte lui
// fait rater son annonce ; un pli détruit sous le nez de qui en avait besoin
// aussi.
function nuisance(state, coup) {
  const pli = state.currentTrick || [];
  if (!pli.length) return 0;
  const cartes = [...pli.map((t) => t.card), coup.posee];
  const avant = resolveTrick(pli.map((t) => t.card));
  const apres = resolveTrick(cartes);
  const joueur = (idx) => (idx == null || idx >= pli.length ? null : state.players.find((p) => p.id === pli[idx].playerId));
  const besoin = (p) => (p && p.bid != null ? p.bid - (p.tricksWon || 0) : 0);
  let score = 0;
  if (apres.destroyed && !avant.destroyed && besoin(joueur(avant.winnerIdx)) > 0) score += 1;
  if (!apres.destroyed && besoin(joueur(apres.winnerIdx)) <= 0 && joueur(apres.winnerIdx)) score += 1;
  return score;
}

function play(state, memoire) {
  const coups = tactique.evaluer(state, memoire, OPTIONS);
  if (!coups.length) return null;
  const manque = plisManquants(state);
  const restants = plisRestants(state);

  if (manque <= 0) {
    const pMin = Math.min(...coups.map((c) => c.p));
    const surs = coups.filter((c) => c.p <= pMin + 0.05);
    const note = (c) => nuisance(state, c) * POIDS_NUISANCE + c.r;
    return surs.reduce((a, b) => (note(b) > note(a) ? b : a)).payload;
  }

  if (manque >= restants) {
    const pMax = Math.max(...coups.map((c) => c.p));
    const meilleurs = coups.filter((c) => c.p >= pMax - 0.02);
    return meilleurs.reduce((a, b) => (b.r < a.r ? b : a)).payload;
  }

  const tiennent = coups.filter((c) => c.p >= TIENT);
  if (tiennent.length) {
    const cout = (c) => c.r - bonusDuCoup(state, c) / 5;
    return tiennent.reduce((a, b) => (cout(b) < cout(a) ? b : a)).payload;
  }
  return tactique.choisir(coups, true).payload;
}

function power(state, memoire) {
  const pending = state.pendingPower;
  switch (pending.kind) {
    case 'rosie': {
      // Le joueur juste après moi mène : je joue donc en dernier, en sachant
      // tout ce qui est tombé.
      const ordre = state.players;
      const i = ordre.findIndex((p) => p.id === state.myId);
      const suivant = ordre[(i + 1) % ordre.length];
      return ['skullking-power-rosie', { leaderId: (suivant || moi(state)).id }];
    }
    case 'marythorne': {
      const autres = (pending.options || []).filter((o) => o.handCount > 0 && o.id !== state.myId);
      if (!autres.length) return ['skullking-power-marythorne', { targetId: state.myId }];
      // D'abord qui a pile son compte : une carte imposée au hasard peut le
      // lui faire dépasser. Sinon le joueur en tête.
      const joueur = (id) => state.players.find((p) => p.id === id) || {};
      const total = (id) => ((state.scoreboard || []).find((s) => s.id === id) || {}).total || 0;
      const auCompte = autres.filter((o) => {
        const p = joueur(o.id);
        return p.bid != null && p.bid === (p.tricksWon || 0);
      });
      const pool = auCompte.length ? auCompte : autres;
      const cible = pool.reduce((a, b) => (total(b.id) > total(a.id) ? b : a));
      return ['skullking-power-marythorne', { targetId: cible.id }];
    }
    case 'will': {
      const ids = tactique.defausseWill(state);
      if (ids.length !== 2) return null;
      // Ce qu'on remet au reliquat n'est plus dans aucune main.
      if (memoire) for (const id of ids) memoire.horsJeu.add(id);
      return ['skullking-power-will', { discardIds: ids }];
    }
    case 'rascal': {
      const ecart = Math.abs(tactique.plisAttendus(state) - state.myBid);
      const stake = ecart < 0.25 ? 20 : ecart < 0.5 ? 10 : 0;
      return ['skullking-power-rascal', { stake }];
    }
    case 'harry':
      return ['skullking-power-harry', { delta: tactique.ajustementHarry(state) }];
    case 'juanita':
      // Le reliquat qu'elle montre est déjà retenu par la mémoire (observer).
      return ['skullking-power-juanita-done', undefined];
    case 'plank': {
      const ids = pending.plankTargetIds || [];
      return ids.length ? ['skullking-power-plank', { removesId: tactique.ciblePlanche(state, ids) }] : null;
    }
    default:
      return null;
  }
}

module.exports = {
  key: 'matelot',
  niveau: 2,
  nom: 'Matelot',
  description: 'Intermédiaire',
  bid,
  play,
  power,
};
