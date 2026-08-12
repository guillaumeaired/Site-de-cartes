// Compteur "parties lancees" par jeu, pour trier le hub par popularite
// reelle. Persiste dans un petit fichier JSON (pas de vraie base de
// donnees sur ce projet) - survit a une mise en veille/reveil de
// l'hebergement gratuit, mais PAS a un redeploiement (disque efface a
// chaque nouveau build sur Render free tier) : les compteurs repartent
// donc de zero apres chaque push, ce qui est un compromis assume plutot
// qu'un vrai historique permanent.
const fs = require('fs');
const path = require('path');

const GAMES = ['bataille', 'rami', 'ascenseur', 'skullking'];
const COUNTS_FILE = path.join(__dirname, '..', 'data', 'play-counts.json');

function loadCounts() {
  try {
    const raw = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8'));
    const counts = {};
    for (const game of GAMES) counts[game] = Number(raw[game]) || 0;
    return counts;
  } catch {
    return Object.fromEntries(GAMES.map((g) => [g, 0]));
  }
}

const counts = loadCounts();

function persist() {
  try {
    fs.mkdirSync(path.dirname(COUNTS_FILE), { recursive: true });
    fs.writeFileSync(COUNTS_FILE, JSON.stringify(counts));
  } catch (err) {
    // Perte du compteur si l'ecriture echoue (disque en lecture seule,
    // etc.) - pas grave, ce n'est qu'un tri d'affichage, pas une donnee
    // critique. On logue pour information seulement.
    console.error('[play-counts] echec ecriture', err.message);
  }
}

function recordGameStarted(game) {
  if (!(game in counts)) return;
  counts[game] += 1;
  persist();
}

function getPlayCounts() {
  return { ...counts };
}

module.exports = { recordGameStarted, getPlayCounts };
