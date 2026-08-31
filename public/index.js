// Trie les cartes du hub par nombre de parties lancees (la plus jouee en
// premier), recupere aupres du serveur. En cas d'echec (offline, serveur
// qui se reveille) ou d'egalite, l'ordre de depart dans le HTML est
// conserve (tri stable) - jamais d'ecran vide/casse si /play-counts echoue.
const GAME_ORDER_KEY = { rami: 0, ascenseur: 1, skullking: 2, vingtquatre: 3 };

fetch('/play-counts')
  .then((res) => (res.ok ? res.json() : Promise.reject(new Error('play-counts indisponible'))))
  .then((counts) => {
    const grid = document.querySelector('.game-grid');
    if (!grid) return;
    const cards = [...grid.children];
    const gameOf = (card) =>
      Object.keys(GAME_ORDER_KEY).find((g) => card.classList.contains(`game-preview-card--${g}`));

    cards
      .map((card, index) => ({ card, index, game: gameOf(card) }))
      .sort((a, b) => {
        const diff = (counts[b.game] || 0) - (counts[a.game] || 0);
        return diff !== 0 ? diff : a.index - b.index; // egalite -> ordre HTML d'origine
      })
      .forEach(({ card }, i) => {
        card.style.setProperty('--stagger', i);
        grid.appendChild(card); // reinsere dans le nouvel ordre
      });
  })
  .catch(() => {
    // Silencieux : le hub reste dans son ordre par defaut, deja fonctionnel.
  });
