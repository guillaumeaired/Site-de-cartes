// Niveau 3 — le Loup de mer (expert). Monte-Carlo par donnes imaginées : à chaque
// décision, il distribue les cartes qu'il ne voit pas entre les mains
// adverses, de toutes les façons compatibles avec ce qu'il a observé (nombre
// de cartes de chacun, couleurs coupées), joue la fin de la manche pour
// chaque coup possible, et garde celui qui lui rapporte le plus en moyenne.
//
// Il ne lit rien de caché (R1) : les donnes sont inventées, à partir de la
// même vue qu'un humain. Son calcul est borné dans le temps (R3) — un serveur
// Node n'a qu'un fil, et un bot qui réfléchit fige toutes les salles.

const {
  coupsLegaux,
  cartesInconnues,
  forceStatique,
  chanceManche1,
  rang,
} = require('./commun');
const { tirerDonne, derouler, scoreDe } = require('./simulation');
const matelot = require('./matelot');

// Le budget de calcul d'une décision, en millisecondes : lu à chaque appel,
// pour que l'arène puisse le réduire et jouer vite.
function budget() {
  return Number(process.env.SK_BOT_BUDGET_MS) || 50;
}
// Au-delà, plus de donnes n'apportent plus grand-chose : inutile de brûler
// tout le budget sur une décision déjà tranchée.
const DONNES_MAX = 400;

function adversaires(state, memoire) {
  return state.players
    .filter((p) => p.id !== state.myId)
    .map((p) => ({ id: p.id, n: p.handCount, coupes: (memoire && memoire.coupes.get(p.id)) || new Set() }));
}

function play(state, memoire) {
  const coups = coupsLegaux(state);
  if (!coups.length) return null;
  if (coups.length === 1) return coups[0].payload;

  const inconnues = cartesInconnues(state, memoire, true);
  const autres = adversaires(state, memoire);
  const ordre = state.players.map((p) => p.id);
  const pli = state.currentTrick || [];
  const partie = {
    ordre,
    pli,
    meneur: pli.length ? pli[0].playerId : state.myId,
    plis: new Map(state.players.map((p) => [p.id, p.tricksWon || 0])),
    bonus: new Map([[state.myId, state.myPendingBonus || 0]]),
    annonces: new Map(state.players.map((p) => [p.id, p.bid == null ? 0 : p.bid])),
  };
  partie.annonces.set(state.myId, state.myBid);

  const sommes = new Array(coups.length).fill(0);
  let donnes = 0;
  const limite = Date.now() + budget();
  do {
    const mains = tirerDonne(inconnues, autres);
    mains.set(state.myId, state.hand);
    coups.forEach((coup, i) => {
      const issue = derouler({ ...partie, mains, force: { id: state.myId, posee: coup.posee } });
      sommes[i] += scoreDe(state.myId, state.myBid, issue, state.roundNumber);
    });
    donnes += 1;
  } while (donnes < DONNES_MAX && Date.now() < limite);

  // À espérance égale, la carte la moins précieuse : elle resservira moins.
  let meilleur = 0;
  for (let i = 1; i < coups.length; i++) {
    const ecart = sommes[i] - sommes[meilleur];
    if (ecart > 1e-9 || (Math.abs(ecart) <= 1e-9 && rang(coups[i].posee) < rang(coups[meilleur].posee))) meilleur = i;
  }
  return coups[meilleur].payload;
}

// L'annonce se décide comme un coup : pour chaque annonce possible, on joue
// la manche entière sur les mêmes donnes imaginées (les adversaires annonçant
// l'espérance arrondie de leur main), et on garde celle qui rapporte le plus. À l'arène, elle vaut 70 points par partie de
// plus que l'annonce du Matelot.
function bid(state, memoire) {
  if (state.cardsInRound === 1 && (state.hand || []).every((c) => c.kind === 'hidden')) {
    return chanceManche1(state) >= 0.5 ? 1 : 0;
  }
  const n = state.players.length;
  const inconnues = cartesInconnues(state, null, false);
  const autres = state.players
    .filter((p) => p.id !== state.myId)
    .map((p) => ({ id: p.id, n: state.cardsInRound, coupes: new Set() }));
  const ordre = state.players.map((p) => p.id);
  const zero = new Map(ordre.map((id) => [id, 0]));
  const annoncesPossibles = state.cardsInRound + 1;
  const sommes = new Array(annoncesPossibles).fill(0);
  let donnes = 0;
  // L'annonce n'arrive qu'une fois par manche : elle a droit au double.
  const limite = Date.now() + 2 * budget();
  do {
    const mains = tirerDonne(inconnues, autres);
    mains.set(state.myId, state.hand);
    const annonces = new Map();
    for (const [id, main] of mains) {
      const attendu = main.reduce((s, c) => s + forceStatique(c, n), 0);
      annonces.set(id, Math.max(0, Math.min(state.cardsInRound, Math.round(attendu))));
    }
    for (let b = 0; b < annoncesPossibles; b++) {
      annonces.set(state.myId, b);
      const issue = derouler({
        ordre,
        mains,
        pli: [],
        meneur: state.leaderPlayerId || ordre[0],
        plis: zero,
        bonus: zero,
        annonces,
      });
      sommes[b] += scoreDe(state.myId, b, issue, state.roundNumber);
    }
    donnes += 1;
  } while (donnes < DONNES_MAX && Date.now() < limite);
  let meilleure = 0;
  for (let b = 1; b < annoncesPossibles; b++) if (sommes[b] > sommes[meilleure]) meilleure = b;
  return meilleure;
}

function power(state, memoire) {
  return matelot.power(state, memoire);
}

module.exports = {
  key: 'loup',
  niveau: 3,
  nom: 'Loup de mer',
  description: 'Expert',
  bid,
  play,
  power,
};
