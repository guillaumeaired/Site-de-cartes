// Tactique commune aux bots qui réfléchissent (Matelot, Loup de mer) : évaluer
// chaque coup légal par sa chance de prendre le pli, choisir selon ce qu'il
// manque à l'annonce, et répondre aux pouvoirs qui touchent la main ou
// l'annonce du bot. Voir briefs/bots-skullking.md.

const { resolveTrick } = require('../skullking');
const {
  coupsLegaux,
  chanceDeGain,
  forceStatique,
  plisManquants,
  plisRestants,
  rang,
  moi,
} = require('./commun');

// Au-dessus de ce seuil, un coup « tient » : on peut compter sur lui pour
// prendre le pli.
const TIENT = 0.6;

// Chaque coup légal, avec sa chance de prendre le pli.
function evaluer(state, memoire, options) {
  return coupsLegaux(state).map((coup) => ({
    ...coup,
    p: chanceDeGain(state, memoire, coup.posee, options),
    r: rang(coup.posee),
  }));
}

function choisir(coups, veutGagner) {
  if (veutGagner) {
    // La plus petite carte qui tient ; à défaut, si quelque chose a une
    // vraie chance, la meilleure ; sinon on ne gaspille rien et on lâche la
    // plus petite.
    const tiennent = coups.filter((c) => c.p >= TIENT);
    if (tiennent.length) return tiennent.reduce((a, b) => (b.r < a.r ? b : a));
    const meilleur = coups.reduce((a, b) => (b.p > a.p ? b : a));
    if (meilleur.p >= 0.3) return meilleur;
    return coups.reduce((a, b) => (b.r < a.r ? b : a));
  }
  // Perdre : parmi les coups qui perdent le plus sûrement, se défaire du plus
  // gros — c'est lui qui risquerait de prendre un pli plus tard.
  const pMin = Math.min(...coups.map((c) => c.p));
  const surs = coups.filter((c) => c.p <= pMin + 0.05);
  return surs.reduce((a, b) => (b.r > a.r ? b : a));
}

// Combien de plis le bot pense finir par faire : ceux déjà pris, plus ce que
// sa main promet encore.
function plisAttendus(state) {
  const n = state.players.length;
  const restants = Math.max(0, plisRestants(state) - (state.phase === 'power' ? 1 : 0));
  const promis = (state.hand || []).reduce((s, c) => s + forceStatique(c, n), 0);
  return (moi(state).tricksWon || 0) + Math.min(restants, promis);
}

// La Planche : retirer le Pirate qui arrange le bot — lui donner le pli s'il
// en veut, le lui ôter sinon.
function ciblePlanche(state, ids) {
  const pli = state.currentTrick || [];
  const veut = plisManquants(state) > 0;
  const planche = pli.findIndex((t) => t.card.kind === 'plank' && t.playerId === state.myId);
  if (planche === -1) return ids[0];
  for (const id of ids) {
    const cartes = pli.map((t, i) => (i === planche ? { ...t.card, removesId: id } : t.card));
    const r = resolveTrick(cartes);
    const gagne = !r.destroyed && pli[r.winnerIdx].playerId === state.myId;
    if (gagne === veut) return id;
  }
  return ids[0];
}

// Will le Bandit : garder ce qui rapproche de l'annonce. S'il manque des
// plis, on jette les plus petites cartes ; sinon les plus grosses.
function defausseWill(state) {
  const main = [...(state.hand || [])];
  const veut = plisManquants(state) > 0;
  main.sort((a, b) => (veut ? rang(a) - rang(b) : rang(b) - rang(a)));
  return main.slice(0, 2).map((c) => c.id);
}

// Harry le Géant : déplacer l'annonce d'un cran vers les plis attendus.
function ajustementHarry(state) {
  const annonce = state.pendingPower.currentBid != null ? state.pendingPower.currentBid : state.myBid;
  const ecart = plisAttendus(state) - annonce;
  let delta = 0;
  if (ecart >= 0.5) delta = 1;
  else if (ecart <= -0.5) delta = -1;
  if (annonce + delta < 0 || annonce + delta > state.cardsInRound) delta = 0;
  return delta;
}

module.exports = {
  TIENT,
  evaluer,
  choisir,
  plisAttendus,
  ciblePlanche,
  defausseWill,
  ajustementHarry,
};
