// Le profil d'un compte du Skull King : un cadre posé par-dessus la page
// (« Profil » dans le menu du compte), tout simple — la pièce qui représente
// le joueur au-dessus de son pseudo, sa cote, son bilan. « Changer de pièce »
// ouvre par-dessus un second cadre, la Collection (jetons communs, jetons
// personnels), où l'on choisit celle qui le représente — au classement, et
// chez ceux dont il est la némésis ou le sous-fifre.
//
// Chargé par skullking.html et classement.html, sans rien imposer à l'un ni
// à l'autre : il n'expose que des fonctions préfixées `profil`, et prévient la
// page quand la pièce ou sa couleur change (événement `profil:piece` sur
// window, avec { piece, couleur }).
//
// PROFIL_PIECES suit PIECES de skullking.js (même ordre, mêmes noms) et
// server/pieces.js (mêmes clés) ; PROFIL_COULEURS suit COULEURS de
// skullking.js et server/couleurs.js. Les listes doivent rester alignées.

const PROFIL_PIECES_COMMUNES = [
  ['crane', 'Crâne'], ['ancre', 'Ancre'], ['voilier', 'Voilier'], ['sabre', 'Sabre'],
  ['boussole', 'Boussole'], ['coffre', 'Coffre'], ['barre', 'Barre'], ['bouteille', 'Bouteille'],
  ['crochet', 'Crochet'], ['ivrogne', 'Ivrogne'], ['poison', 'Poison'], ['canon', 'Canon'],
].map(([key, label]) => ({ key, label }));

// Les jetons personnels : gagnés un par un avec un code, dans le salon.
const PROFIL_PIECES_PERSONNELLES = [
  ['pieuvre', 'Pieuvre'], ['pomme', 'Apple'], ['visa', 'Visa'],
  ['taureau', 'Taureau'], ['viseur', 'Carbon Away'], ['harvard', 'Harvard'], ['surf', 'Surf'],
].map(([key, label]) => ({ key, label }));

const PROFIL_PIECE_PAR_CLE = Object.fromEntries(
  [...PROFIL_PIECES_COMMUNES, ...PROFIL_PIECES_PERSONNELLES].map((p) => [p.key, p]),
);

// Les quatorze couleurs d'émail : la pièce d'un compte est un motif dans l'une
// d'elles, comme à table.
const PROFIL_COULEURS = [
  ['rouge', 'Rouge', '#c4161c'], ['orange', 'Orange', '#f0701a'], ['jaune', 'Jaune', '#f4c81e'],
  ['anis', 'Anis', '#9ec21e'], ['vert', 'Vert', '#2f8a3a'], ['menthe', 'Menthe', '#62d6a6'],
  ['turquoise', 'Turquoise', '#0c9aa0'], ['ciel', 'Ciel', '#45b0ea'], ['marine', 'Marine', '#1f48a8'],
  ['violet', 'Violet', '#6d3fc4'], ['magenta', 'Magenta', '#c4207e'], ['rose', 'Rose', '#f4a8c8'],
  ['blanc', 'Blanc', '#ece8de'], ['noir', 'Noir', '#2c2c30'],
].map(([key, label, hex]) => ({ key, label, hex }));
const PROFIL_COULEUR_PAR_CLE = Object.fromEntries(PROFIL_COULEURS.map((c) => [c.key, c]));

// La couleur d'un motif tant que le compte n'en a pas choisi (même table que
// server/couleurs.js).
const PROFIL_COULEUR_PAR_DEFAUT = {
  crane: 'rouge', ancre: 'marine', voilier: 'vert', sabre: 'violet',
  boussole: 'jaune', coffre: 'turquoise', barre: 'orange', bouteille: 'anis',
  crochet: 'magenta',
  pieuvre: 'noir', ivrogne: 'rouge', poison: 'anis', canon: 'turquoise',
  pomme: 'ciel', visa: 'rose', taureau: 'blanc', viseur: 'vert', harvard: 'rouge', surf: 'violet',
};

// Un motif dans une couleur : l'image de la pièce et l'émail qui la peint.
function profilHabiller(motif, couleurCle) {
  const couleur =
    PROFIL_COULEUR_PAR_CLE[couleurCle] || PROFIL_COULEUR_PAR_CLE[PROFIL_COULEUR_PAR_DEFAUT[motif.key]] || PROFIL_COULEURS[0];
  return { ...motif, couleur: couleur.key, hex: couleur.hex, src: `assets/skin/pieces/${motif.key}-${couleur.key}.webp` };
}

// La pièce d'un compte : son motif dans sa couleur. Qui n'a pas choisi de
// motif en a un tiré de son pseudo, donc stable, parmi les neuf premières —
// le même repli qu'à table (pieceFor).
function profilPieceDe(user) {
  let motif = user && user.piece && PROFIL_PIECE_PAR_CLE[user.piece];
  if (!motif) {
    const pseudo = (user && user.pseudo) || '';
    let hash = 0;
    for (let i = 0; i < pseudo.length; i++) hash = (hash * 31 + pseudo.charCodeAt(i)) >>> 0;
    motif = PROFIL_PIECES_COMMUNES[hash % 9];
  }
  return profilHabiller(motif, user && user.couleur);
}

function profilMedaillon(piece, classe = '') {
  const span = document.createElement('span');
  span.className = `sk-profil-medaillon ${classe}`.trim();
  const img = document.createElement('img');
  img.src = piece.src || profilHabiller(piece).src;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  span.appendChild(img);
  span.title = piece.label;
  return span;
}

const profilEtat = {
  fond: null,
  collection: null,
  donnees: null,
  envoi: false,
  retourFocus: null,
};

function profilCollectionOuverte() {
  return Boolean(profilEtat.collection && !profilEtat.collection.classList.contains('hidden'));
}

function profilFermer() {
  const fond = profilEtat.fond;
  if (!fond || fond.classList.contains('hidden')) return;
  profilFermerCollection(false);
  fond.classList.add('hidden');
  document.removeEventListener('keydown', profilClavier);
  // Le bouton d'origine a pu être redessiné (le menu reprend la pièce
  // choisie) : on revient alors sur la plaque du menu.
  let retour = profilEtat.retourFocus;
  if (!retour || !retour.isConnected) retour = document.querySelector('#sk-compte .sk-compte-plaque');
  if (retour && retour.focus) retour.focus();
}

// Échap referme d'abord la collection, puis le profil.
function profilClavier(e) {
  if (e.key !== 'Escape') return;
  if (profilCollectionOuverte()) profilFermerCollection(true);
  else profilFermer();
}

function profilCadre() {
  if (profilEtat.fond) return profilEtat.fond;
  const fond = document.createElement('div');
  fond.className = 'sk-profil-fond hidden';
  fond.innerHTML = `
    <section class="sk-profil" role="dialog" aria-modal="true" aria-labelledby="sk-profil-pseudo">
      <button type="button" class="sk-profil-fermer" aria-label="Fermer le profil">×</button>
      <p class="sk-profil-surtitre">Profil</p>
      <header class="sk-profil-tete" hidden>
        <div class="sk-profil-piece-ligne">
          <span class="sk-profil-portrait"></span>
          <button type="button" class="sk-compte-classement sk-profil-changer">Changer de pièce</button>
        </div>
        <h2 id="sk-profil-pseudo" class="sk-profil-pseudo"></h2>
        <p class="sk-profil-cote"><b></b><small>Elo</small></p>
        <p class="sk-profil-bilan"></p>
      </header>
      <p class="sk-profil-erreur hidden" role="alert"></p>
    </section>`;
  fond.addEventListener('click', (e) => {
    if (e.target === fond) profilFermer();
  });
  fond.querySelector('.sk-profil-fermer').addEventListener('click', profilFermer);
  fond.querySelector('.sk-profil-changer').addEventListener('click', profilOuvrirCollection);
  document.body.appendChild(fond);
  profilEtat.fond = fond;
  return fond;
}

// La collection : un second cadre, posé par-dessus le profil.
function profilCadreCollection() {
  if (profilEtat.collection) return profilEtat.collection;
  const fond = document.createElement('div');
  fond.className = 'sk-profil-fond sk-collection-fond hidden';
  fond.innerHTML = `
    <section class="sk-profil sk-collection" role="dialog" aria-modal="true" aria-labelledby="sk-collection-titre">
      <button type="button" class="sk-profil-fermer" aria-label="Fermer la collection">×</button>
      <h2 id="sk-collection-titre" class="sk-collection-titre">Collection</h2>
      <p class="sk-profil-aide">Ta pièce te représente au classement, et chez ceux dont tu es la némésis ou le sous-fifre.</p>
      <h4 class="sk-profil-famille">Couleur</h4>
      <div class="sk-profil-couleurs" data-famille="couleurs"></div>
      <h4 class="sk-profil-famille">Jetons communs <small data-compte="communs"></small></h4>
      <div class="sk-profil-grille" data-famille="communs"></div>
      <h4 class="sk-profil-famille">Jetons personnels <small data-compte="personnels"></small></h4>
      <div class="sk-profil-grille" data-famille="personnels"></div>
      <p class="sk-profil-aide sk-profil-aide--pied">Les jetons personnels se débloquent avec un code, dans le salon.</p>
      <p class="sk-profil-erreur hidden" role="alert"></p>
    </section>`;
  fond.addEventListener('click', (e) => {
    if (e.target === fond) profilFermerCollection(true);
  });
  fond.querySelector('.sk-profil-fermer').addEventListener('click', () => profilFermerCollection(true));
  document.body.appendChild(fond);
  profilEtat.collection = fond;
  return fond;
}

function profilOuvrirCollection() {
  if (!profilEtat.donnees) return;
  const fond = profilCadreCollection();
  profilErreur('');
  profilDessinerCollection();
  fond.classList.remove('hidden');
  const focus = fond.querySelector('.sk-profil-case--portee') || fond.querySelector('.sk-profil-fermer');
  focus.focus();
}

function profilFermerCollection(rendreFocus) {
  if (!profilCollectionOuverte()) return;
  profilEtat.collection.classList.add('hidden');
  if (rendreFocus) profilEtat.fond.querySelector('.sk-profil-changer').focus();
}

// L'erreur s'affiche dans le cadre du dessus.
function profilErreur(texte) {
  [profilEtat.fond, profilEtat.collection].forEach((cadre) => {
    if (!cadre) return;
    const p = cadre.querySelector('.sk-profil-erreur');
    p.textContent = '';
    p.classList.add('hidden');
  });
  if (!texte) return;
  const cadre = profilCollectionOuverte() ? profilEtat.collection : profilEtat.fond;
  const p = cadre.querySelector('.sk-profil-erreur');
  p.textContent = texte;
  p.classList.remove('hidden');
}

function profilCase(piece, { possedee, portee }) {
  if (!possedee) {
    const vide = document.createElement('span');
    vide.className = 'sk-profil-case sk-profil-case--verrou';
    vide.title = 'À débloquer';
    vide.setAttribute('aria-label', 'Jeton à débloquer');
    vide.textContent = '?';
    return vide;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sk-profil-case' + (portee ? ' sk-profil-case--portee' : '');
  // Chaque motif se montre dans la couleur du compte : on voit la pièce
  // qu'on portera.
  piece = profilHabiller(piece, profilEtat.donnees && profilPieceDe(profilEtat.donnees.user).couleur);
  btn.title = portee ? `${piece.label} — ta pièce` : piece.label;
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', String(portee));
  btn.appendChild(profilMedaillon(piece));
  const nom = document.createElement('span');
  nom.className = 'sk-profil-case-nom';
  nom.textContent = piece.label;
  btn.appendChild(nom);
  btn.addEventListener('click', () => profilChoisir(piece.key));
  return btn;
}

function profilDessiner() {
  const fond = profilCadre();
  const d = profilEtat.donnees;
  // Tant que le profil n'est pas chargé, la tête reste vide plutôt que
  // de montrer un « Elo » sans chiffre.
  fond.querySelector('.sk-profil-tete').hidden = !d;
  if (!d) return;
  const u = d.user;
  const portee = profilPieceDe(u);

  const portrait = fond.querySelector('.sk-profil-portrait');
  portrait.textContent = '';
  portrait.appendChild(profilMedaillon(portee, 'sk-profil-medaillon--grand'));
  fond.querySelector('.sk-profil-pseudo').textContent = u.pseudo;
  fond.querySelector('.sk-profil-cote b').textContent = u.elo;
  const parties = u.gamesPlayed || 0;
  const victoires = u.wins || 0;
  fond.querySelector('.sk-profil-bilan').textContent =
    `${parties} partie${parties > 1 ? 's' : ''} classée${parties > 1 ? 's' : ''} · ` +
    `${victoires} victoire${victoires > 1 ? 's' : ''}`;
  if (profilCollectionOuverte()) profilDessinerCollection();
}

function profilDessinerCollection() {
  const fond = profilCadreCollection();
  const d = profilEtat.donnees;
  if (!d) return;
  const portee = profilPieceDe(d.user);
  const miennes = new Set(d.pieces || []);

  // Les quatorze couleurs, celle du compte marquée. Toutes se choisissent :
  // deux comptes peuvent avoir la même pièce de profil, c'est à table
  // seulement que deux joueurs ne partagent jamais une couleur.
  const couleurs = fond.querySelector('[data-famille="couleurs"]');
  couleurs.textContent = '';
  PROFIL_COULEURS.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const portee_ = c.key === portee.couleur;
    btn.className = 'sk-profil-couleur' + (portee_ ? ' sk-profil-couleur--portee' : '');
    btn.style.setProperty('--sk-couleur', c.hex);
    btn.title = portee_ ? `${c.label} — ta couleur` : c.label;
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(portee_));
    btn.addEventListener('click', () => profilChoisirCouleur(c.key));
    couleurs.appendChild(btn);
  });

  const communs = fond.querySelector('[data-famille="communs"]');
  communs.textContent = '';
  PROFIL_PIECES_COMMUNES.forEach((p) =>
    communs.appendChild(profilCase(p, { possedee: true, portee: p.key === portee.key })),
  );
  fond.querySelector('[data-compte="communs"]').textContent = PROFIL_PIECES_COMMUNES.length;

  // Les jetons gagnés d'abord, puis autant de cases fermées qu'il en reste à
  // trouver : la collection dit combien il en manque, pas lesquels.
  const perso = fond.querySelector('[data-famille="personnels"]');
  perso.textContent = '';
  const gagnes = PROFIL_PIECES_PERSONNELLES.filter((p) => miennes.has(p.key));
  gagnes.forEach((p) => perso.appendChild(profilCase(p, { possedee: true, portee: p.key === portee.key })));
  for (let i = gagnes.length; i < PROFIL_PIECES_PERSONNELLES.length; i++) {
    perso.appendChild(profilCase(null, { possedee: false }));
  }
  fond.querySelector('[data-compte="personnels"]').textContent =
    `${gagnes.length} / ${PROFIL_PIECES_PERSONNELLES.length}`;
}

// Choisir une pièce la porte aussitôt, referme la collection et la montre
// dans le profil, au-dessus du pseudo.
function profilChoisir(cle) {
  const d = profilEtat.donnees;
  if (!d || profilEtat.envoi) return;
  if (d.user.piece === cle || profilPieceDe(d.user).key === cle) {
    profilFermerCollection(true);
    return;
  }
  profilEtat.envoi = true;
  profilErreur('');
  fetch('/api/profil/piece', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ piece: cle }),
  })
    .then((r) => r.json().then((corps) => ({ ok: r.ok, corps })))
    .then(({ ok, corps }) => {
      if (!ok) throw new Error(corps.error || 'La pièce n’a pas pu être changée.');
      d.user.piece = corps.piece;
      profilFermerCollection(true);
      profilDessiner();
      window.dispatchEvent(new CustomEvent('profil:piece', { detail: { piece: corps.piece, couleur: d.user.couleur || null } }));
    })
    .catch((err) => profilErreur(err.message || 'La pièce n’a pas pu être changée.'))
    .finally(() => {
      profilEtat.envoi = false;
    });
}

// Choisir une couleur la porte aussitôt ; la collection reste ouverte, ses
// motifs se repeignent dans la nouvelle couleur.
function profilChoisirCouleur(cle) {
  const d = profilEtat.donnees;
  if (!d || profilEtat.envoi) return;
  if (profilPieceDe(d.user).couleur === cle) return;
  profilEtat.envoi = true;
  profilErreur('');
  fetch('/api/profil/couleur', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ couleur: cle }),
  })
    .then((r) => r.json().then((corps) => ({ ok: r.ok, corps })))
    .then(({ ok, corps }) => {
      if (!ok) throw new Error(corps.error || 'La couleur n’a pas pu être changée.');
      d.user.couleur = corps.couleur;
      profilDessiner();
      window.dispatchEvent(new CustomEvent('profil:piece', { detail: { piece: d.user.piece || null, couleur: corps.couleur } }));
    })
    .catch((err) => profilErreur(err.message || 'La couleur n’a pas pu être changée.'))
    .finally(() => {
      profilEtat.envoi = false;
    });
}

// Le profil complet, tel que le donne le serveur (voir server/profil.js) :
// la page du classement s'en sert aussi pour la courbe et les duels.
function profilCharger() {
  return fetch('/api/profil', { credentials: 'same-origin' }).then((r) => {
    if (r.status === 401) return null;
    if (!r.ok) throw new Error('profil');
    return r.json();
  });
}

function profilOuvrir() {
  const fond = profilCadre();
  profilEtat.retourFocus = document.activeElement;
  profilErreur('');
  fond.classList.remove('hidden');
  document.addEventListener('keydown', profilClavier);
  fond.querySelector('.sk-profil-fermer').focus();
  profilDessiner();
  profilCharger()
    .then((d) => {
      if (!d) return profilErreur('Connecte-toi pour voir ton profil.');
      profilEtat.donnees = d;
      profilDessiner();
    })
    .catch(() => profilErreur('Le profil n’a pas pu être chargé. Réessaie dans un instant.'));
}
