// Le classement Elo : tous les comptes, même sans partie (ils sont à leur
// cote de départ, 1200), du plus haut au plus bas, chacun avec sa pièce de
// profil. Sa propre ligne est surlignée.
//
// De part et d'autre : à gauche ses rivaux — sa némésis (celui contre qui il
// a le plus perdu, plusieurs s'ils sont ex aequo) et ses sous-fifres (ceux
// qu'il a le plus battus) ; à droite la courbe de sa cote, partie après
// partie. Tout vient de /api/profil (voir server/profil.js). Les cadres sont
// là pour tout le monde : tant qu'ils n'ont rien à montrer (invité, ou pas
// encore de partie classée), ils disent où l'on en est. Ce que montre chaque
// cadre, et le calcul de la cote, se lit dans les « ? » à côté des titres.

const lignes = document.getElementById('classement-lignes');
const vide = document.getElementById('classement-vide');
const retour = document.getElementById('classement-retour');

// --- Les « ? » des titres ---------------------------------------------
// Un clic ouvre la bulle, un autre la referme ; Échap ou un clic ailleurs
// referment celle qui est ouverte. Une seule à la fois.
function fermerAides(sauf) {
  document.querySelectorAll('.sk-aide[aria-expanded="true"]').forEach((b) => {
    if (b === sauf) return;
    b.setAttribute('aria-expanded', 'false');
    document.getElementById(b.getAttribute('aria-controls')).hidden = true;
  });
}
document.querySelectorAll('.sk-aide').forEach((bouton) => {
  bouton.addEventListener('click', (e) => {
    e.stopPropagation();
    const ouverte = bouton.getAttribute('aria-expanded') === 'true';
    fermerAides(bouton);
    bouton.setAttribute('aria-expanded', String(!ouverte));
    document.getElementById(bouton.getAttribute('aria-controls')).hidden = ouverte;
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.sk-aide-bulle')) fermerAides();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') fermerAides();
});

let joueurs = [];
let moi = null;

function pluriel(n, mot) {
  return `${n} ${mot}${n > 1 ? 's' : ''}`;
}

function dessinerClassement() {
  lignes.textContent = '';
  vide.classList.toggle('hidden', joueurs.length > 0);
  document.querySelector('.sk-classement').classList.toggle('hidden', joueurs.length === 0);
  joueurs.forEach((p, i) => {
    const tr = document.createElement('tr');
    if (p.id === moi) tr.className = 'sk-classement-moi';
    [i + 1, null, p.elo, p.gamesPlayed, p.wins].forEach((v) => {
      const td = document.createElement('td');
      if (v === null) {
        // Le pirate : sa pièce, puis son pseudo.
        const nom = document.createElement('span');
        nom.className = 'sk-classement-pirate';
        nom.appendChild(profilMedaillon(profilPieceDe(p), 'sk-classement-piece'));
        const texte = document.createElement('span');
        texte.className = 'sk-classement-pseudo';
        texte.textContent = p.pseudo;
        nom.appendChild(texte);
        td.appendChild(nom);
      } else {
        td.textContent = v;
      }
      tr.appendChild(td);
    });
    lignes.appendChild(tr);
  });
}

// --- La courbe de la cote ----------------------------------------------
// Une seule série : pas de légende, le titre du cadre la nomme. Le trait de
// laiton sur le bois sombre, une grille à peine marquée, et au survol une
// règle verticale qui dit la cote et ce que la partie lui a fait.

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(nom, attrs = {}) {
  const el = document.createElementNS(SVG_NS, nom);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function dateCourte(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// Des graduations rondes (5, 10, 20, 25, 50…) qui couvrent [min, max].
function graduations(min, max, voulues = 4) {
  const brut = (max - min) / voulues;
  const puissance = 10 ** Math.floor(Math.log10(brut));
  const pas = [1, 2, 2.5, 5, 10].map((m) => m * puissance).find((p) => p >= brut) || brut;
  const ticks = [];
  for (let v = Math.ceil(min / pas) * pas; v <= max + 1e-9; v += pas) ticks.push(Math.round(v));
  return ticks;
}

function dessinerCourbe(courbe) {
  const zone = document.getElementById('courbe');
  const bilan = document.getElementById('courbe-bilan');
  zone.textContent = '';

  if (courbe.length < 2) {
    const etat = document.createElement('p');
    etat.className = 'sk-rival-etat';
    etat.textContent = connecte
      ? 'Ta courbe démarrera à ta première partie classée.'
      : 'Connecte-toi pour suivre la tienne.';
    zone.appendChild(etat);
    bilan.textContent = '';
    return;
  }

  const L = 300;
  const H = 180;
  const marge = { haut: 12, droite: 12, bas: 22, gauche: 38 };
  const elos = courbe.map((p) => p.elo);
  let min = Math.min(...elos);
  let max = Math.max(...elos);
  // Une marge au-dessus et au-dessous, et jamais moins de 40 points d'écart :
  // trois parties à ±2 ne doivent pas ressembler à un krach.
  const ecart = Math.max(40, max - min);
  const milieu = (min + max) / 2;
  min = Math.floor(milieu - ecart * 0.6);
  max = Math.ceil(milieu + ecart * 0.6);

  const x = (i) => marge.gauche + (i / (courbe.length - 1)) * (L - marge.gauche - marge.droite);
  const y = (v) => marge.haut + (1 - (v - min) / (max - min)) * (H - marge.haut - marge.bas);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${L} ${H}`,
    class: 'sk-courbe-svg',
    role: 'img',
    'aria-label': `Ta cote, de ${elos[0]} à ${elos[elos.length - 1]} en ${pluriel(courbe.length - 1, 'partie')}`,
  });

  graduations(min, max).forEach((t) => {
    svg.appendChild(svgEl('line', { x1: marge.gauche, x2: L - marge.droite, y1: y(t), y2: y(t), class: 'sk-courbe-grille' }));
    const lab = svgEl('text', { x: marge.gauche - 6, y: y(t) + 3.5, class: 'sk-courbe-axe', 'text-anchor': 'end' });
    lab.textContent = t;
    svg.appendChild(lab);
  });

  const premier = svgEl('text', { x: x(0), y: H - 6, class: 'sk-courbe-axe', 'text-anchor': 'start' });
  premier.textContent = 'Départ';
  svg.appendChild(premier);
  const dernier = svgEl('text', { x: x(courbe.length - 1), y: H - 6, class: 'sk-courbe-axe', 'text-anchor': 'end' });
  dernier.textContent = pluriel(courbe.length - 1, 'partie');
  svg.appendChild(dernier);

  const points = courbe.map((p, i) => `${x(i).toFixed(1)},${y(p.elo).toFixed(1)}`);
  const bas = (H - marge.bas).toFixed(1);
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: 'sk-courbe-aire', x1: 0, x2: 0, y1: 0, y2: 1 });
  grad.appendChild(svgEl('stop', { offset: '0', 'stop-color': 'currentColor', 'stop-opacity': '0.22' }));
  grad.appendChild(svgEl('stop', { offset: '1', 'stop-color': 'currentColor', 'stop-opacity': '0' }));
  defs.appendChild(grad);
  svg.appendChild(defs);
  svg.appendChild(svgEl('path', {
    d: `M${x(0).toFixed(1)},${bas}L${points.join('L')}L${x(courbe.length - 1).toFixed(1)},${bas}Z`,
    class: 'sk-courbe-aire',
    fill: 'url(#sk-courbe-aire)',
  }));
  svg.appendChild(svgEl('polyline', { points: points.join(' '), class: 'sk-courbe-trait' }));

  // Le dernier point, marqué : c'est la cote d'aujourd'hui.
  const n = courbe.length - 1;
  svg.appendChild(svgEl('circle', { cx: x(n), cy: y(courbe[n].elo), r: 4, class: 'sk-courbe-point' }));

  // Le survol : une règle, un point, une bulle.
  const regle = svgEl('line', { y1: marge.haut, y2: H - marge.bas, class: 'sk-courbe-regle', visibility: 'hidden' });
  const repere = svgEl('circle', { r: 4, class: 'sk-courbe-point', visibility: 'hidden' });
  svg.appendChild(regle);
  svg.appendChild(repere);
  const cible = svgEl('rect', {
    x: marge.gauche - 6, y: 0, width: L - marge.gauche - marge.droite + 12, height: H, fill: 'transparent',
  });
  svg.appendChild(cible);

  const bulle = document.createElement('div');
  bulle.className = 'sk-courbe-bulle hidden';
  zone.appendChild(svg);
  zone.appendChild(bulle);

  const montrer = (clientX) => {
    const r = svg.getBoundingClientRect();
    const vx = ((clientX - r.left) / r.width) * L;
    const i = Math.max(0, Math.min(n, Math.round(((vx - marge.gauche) / (L - marge.gauche - marge.droite)) * n)));
    const p = courbe[i];
    const px = x(i);
    const py = y(p.elo);
    regle.setAttribute('x1', px);
    regle.setAttribute('x2', px);
    repere.setAttribute('cx', px);
    repere.setAttribute('cy', py);
    regle.setAttribute('visibility', 'visible');
    repere.setAttribute('visibility', 'visible');
    const delta = p.delta == null ? '' : p.delta > 0 ? ` (+${p.delta})` : p.delta < 0 ? ` (${p.delta})` : ' (=)';
    const quand = i === 0 ? 'Départ' : `Partie ${i}${p.at ? ' · ' + dateCourte(p.at) : ''}`;
    bulle.innerHTML = '';
    const v = document.createElement('b');
    v.textContent = p.elo;
    const d = document.createElement('span');
    d.textContent = delta;
    const q = document.createElement('small');
    q.textContent = quand;
    bulle.append(v, d, q);
    bulle.classList.remove('hidden');
    const gauche = (px / L) * r.width;
    bulle.style.left = `${gauche}px`;
    bulle.style.top = `${(py / H) * r.height}px`;
    bulle.classList.toggle('sk-courbe-bulle--gauche', gauche > r.width * 0.6);
  };
  const cacher = () => {
    regle.setAttribute('visibility', 'hidden');
    repere.setAttribute('visibility', 'hidden');
    bulle.classList.add('hidden');
  };
  cible.addEventListener('pointermove', (e) => montrer(e.clientX));
  cible.addEventListener('pointerdown', (e) => montrer(e.clientX));
  cible.addEventListener('pointerleave', cacher);

  const depart = elos[0];
  const actuelle = elos[n];
  const ecartDepart = actuelle - depart;
  bilan.textContent =
    `Plus haut ${Math.max(...elos)} · plus bas ${Math.min(...elos)} · ` +
    `${ecartDepart >= 0 ? '+' : ''}${ecartDepart} depuis le départ`;
}

// --- Les rivaux -----------------------------------------------------------

function bilanContre(a, premier) {
  const parts = premier === 'defaites'
    ? [pluriel(a.defaites, 'défaite'), a.victoires ? pluriel(a.victoires, 'victoire') : null]
    : [pluriel(a.victoires, 'victoire'), a.defaites ? pluriel(a.defaites, 'défaite') : null];
  if (a.nuls) parts.push(pluriel(a.nuls, 'nul'));
  return parts.filter(Boolean).join(' · ');
}

function dessinerRivaux(liste, ul, premier, etat) {
  ul.textContent = '';
  if (!liste.length) {
    const li = document.createElement('li');
    li.className = 'sk-rival-etat';
    li.textContent = etat;
    ul.appendChild(li);
    return;
  }
  liste.forEach((a) => {
    const li = document.createElement('li');
    li.className = 'sk-rival';
    li.appendChild(profilMedaillon(profilPieceDe(a), 'sk-rival-piece'));
    const texte = document.createElement('span');
    texte.className = 'sk-rival-texte';
    const nom = document.createElement('b');
    nom.className = 'sk-rival-nom';
    nom.textContent = a.pseudo;
    const bilan = document.createElement('small');
    bilan.className = 'sk-rival-bilan';
    bilan.textContent = bilanContre(a, premier);
    texte.append(nom, bilan);
    li.appendChild(texte);
    ul.appendChild(li);
  });
}

let connecte = false;

// Sans profil (invité, ou serveur qui n'a pas répondu), les cadres restent
// à « pas encore ».
const PROFIL_VIDE = { courbe: [], nemesis: [], sousFifres: [] };

function dessinerProfil(profil) {
  dessinerCourbe(profil.courbe);
  document.getElementById('nemesis-titre').textContent =
    profil.nemesis.length > 1 ? 'Tes némésis' : 'Ton némésis';
  document.getElementById('fifres-titre').textContent =
    profil.sousFifres.length > 1 ? 'Tes sous-fifres' : 'Ton sous-fifre';
  dessinerRivaux(profil.nemesis, document.getElementById('nemesis'), 'defaites',
    connecte ? 'Personne ne t’a encore battu.' : 'Connecte-toi pour démasquer le tien.');
  dessinerRivaux(profil.sousFifres, document.getElementById('sous-fifres'), 'victoires',
    connecte ? 'Personne n’est encore tombé sous ta lame.' : 'Connecte-toi pour compter les tiens.');
}

dessinerProfil(PROFIL_VIDE);

Promise.all([
  fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  fetch('/api/leaderboard').then((r) => (r.ok ? r.json() : { players: [] })),
])
  .then(([me, { players }]) => {
    if (me.site === 'skullking') retour.href = '/';
    moi = me.user ? me.user.id : null;
    joueurs = players;
    dessinerClassement();
    if (!me.user) return;
    connecte = true;
    dessinerProfil(PROFIL_VIDE);
    profilCharger()
      .then((profil) => profil && dessinerProfil(profil))
      .catch(() => {});
  })
  .catch(() => {
    vide.textContent = 'Le classement n’a pas pu être chargé. Réessaie dans un instant.';
    vide.classList.remove('hidden');
  });

// Une pièce changée dans le profil : sa ligne du classement la reprend.
window.addEventListener('profil:piece', (e) => {
  const ligne = joueurs.find((p) => p.id === moi);
  if (!ligne) return;
  ligne.piece = e.detail.piece;
  if ('couleur' in e.detail) ligne.couleur = e.detail.couleur;
  dessinerClassement();
});
