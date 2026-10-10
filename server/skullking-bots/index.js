// Registre des niveaux de bots Skull King, du plus faible au plus fort (voir
// briefs/bots-skullking.md). L'indice + 1 est le niveau affiché dans le salon.

const NIVEAUX = [
  require('./mousse'),
  require('./matelot'),
  require('./loup'),
];

// Le Matelot : l'intermédiaire, un adversaire qui joue juste sans écraser
// personne.
const NIVEAU_PAR_DEFAUT = 2;

function niveauValide(niveau) {
  const n = Number(niveau);
  return Number.isInteger(n) && n >= 1 && n <= NIVEAUX.length ? n : null;
}

function strategie(niveau) {
  return NIVEAUX[(niveauValide(niveau) || NIVEAU_PAR_DEFAUT) - 1];
}

// Ce que le salon a besoin de savoir pour dessiner le choix : le niveau, son
// nom et sa difficulté, dans l'ordre.
function catalogue() {
  return NIVEAUX.map((s) => ({ niveau: s.niveau, nom: s.nom, description: s.description }));
}

module.exports = { NIVEAUX, NIVEAU_PAR_DEFAUT, niveauValide, strategie, catalogue };
