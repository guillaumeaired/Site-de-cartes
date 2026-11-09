// Le classement Elo : les comptes qui ont au moins une partie classée, du
// plus haut au plus bas. Sa propre ligne est surlignée.

const lignes = document.getElementById('classement-lignes');
const vide = document.getElementById('classement-vide');
const retour = document.getElementById('classement-retour');

Promise.all([
  fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  fetch('/api/leaderboard').then((r) => (r.ok ? r.json() : { players: [] })),
])
  .then(([me, { players }]) => {
    if (me.site === 'skullking') retour.href = '/';
    const moi = me.user ? me.user.id : null;
    lignes.textContent = '';
    vide.classList.toggle('hidden', players.length > 0);
    document.querySelector('.sk-classement').classList.toggle('hidden', players.length === 0);
    players.forEach((p, i) => {
      const tr = document.createElement('tr');
      if (p.id === moi) tr.className = 'sk-classement-moi';
      [i + 1, p.pseudo, p.elo, p.gamesPlayed, p.wins].forEach((v) => {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      lignes.appendChild(tr);
    });
  })
  .catch(() => {
    vide.textContent = 'Le classement n’a pas pu être chargé. Réessaie dans un instant.';
    vide.classList.remove('hidden');
  });
