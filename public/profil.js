// Le profil d'un compte du Skull King : un cadre posé par-dessus la page (le
// bouton « Profil » du bandeau, ou celui du classement), qui montre le pseudo,
// la cote, et la collection des pièces pour choisir celle qui représente le
// joueur — au classement, et chez ceux dont il est la némésis ou le
// sous-fifre.
//
// Chargé par skullking.html et classement.html, sans rien imposer à l'un ni
// à l'autre : il n'expose que des fonctions préfixées `profil`, et prévient la
// page quand la pièce change (événement `profil:piece` sur window).
//
// PROFIL_PIECES suit PIECES de skullking.js (même ordre, mêmes noms) et
// server/pieces.js (mêmes clés) : les trois listes doivent rester alignées.

const PROFIL_PIECES_COMMUNES = [
  ['crane', 'Crâne'], ['ancre', 'Ancre'], ['voilier', 'Voilier'], ['sabre', 'Sabre'],
  ['boussole', 'Boussole'], ['coffre', 'Coffre'], ['barre', 'Barre'], ['bouteille', 'Bouteille'],
  ['crochet', 'Crochet'], ['ivrogne', 'Ivrogne'], ['poison', 'Poison'], ['canon', 'Canon'],
].map(([key, label]) => ({ key, label }));

// Les jetons personnels : gagnés un par un avec un code, dans le salon.
const PROFIL_PIECES_PERSONNELLES = [
  ['pieuvre', 'Pieuvre'], ['pomme', 'Apple'], ['visa', 'Visa'],
  ['taureau', 'Taureau'], ['viseur', 'Carbon Away'], ['harvard', 'Harvard'],
].map(([key, label]) => ({ key, label }));

const PROFIL_PIECE_PAR_CLE = Object.fromEntries(
  [...PROFIL_PIECES_COMMUNES, ...PROFIL_PIECES_PERSONNELLES].map((p) => [p.key, p]),
);

// La pièce d'un compte qui n'en a pas choisi : tirée de son pseudo, donc
// stable, parmi les neuf premières — le même repli qu'à table (pieceFor).
function profilPieceDe(user) {
  const choisie = user && user.piece && PROFIL_PIECE_PAR_CLE[user.piece];
  if (choisie) return choisie;
  const pseudo = (user && user.pseudo) || '';
  let hash = 0;
  for (let i = 0; i < pseudo.length; i++) hash = (hash * 31 + pseudo.charCodeAt(i)) >>> 0;
  return PROFIL_PIECES_COMMUNES[hash % 9];
}

function profilMedaillon(piece, classe = '') {
  const span = document.createElement('span');
  span.className = `sk-profil-medaillon ${classe}`.trim();
  const img = document.createElement('img');
  img.src = `assets/skin/piece-${piece.key}.webp`;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  span.appendChild(img);
  span.title = piece.label;
  return span;
}

const profilEtat = {
  fond: null,
  donnees: null,
  envoi: false,
  retourFocus: null,
};

function profilFermer() {
  const fond = profilEtat.fond;
  if (!fond || fond.classList.contains('hidden')) return;
  fond.classList.add('hidden');
  document.removeEventListener('keydown', profilClavier);
  if (profilEtat.retourFocus && profilEtat.retourFocus.focus) profilEtat.retourFocus.focus();
}

function profilClavier(e) {
  if (e.key === 'Escape') profilFermer();
}

function profilCadre() {
  if (profilEtat.fond) return profilEtat.fond;
  const fond = document.createElement('div');
  fond.className = 'sk-profil-fond hidden';
  fond.innerHTML = `
    <section class="sk-profil" role="dialog" aria-modal="true" aria-labelledby="sk-profil-pseudo">
      <button type="button" class="sk-profil-fermer" aria-label="Fermer le profil">×</button>
      <p class="sk-profil-surtitre">Profil</p>
      <header class="sk-profil-tete">
        <span class="sk-profil-portrait"></span>
        <div class="sk-profil-ident">
          <h2 id="sk-profil-pseudo" class="sk-profil-pseudo"></h2>
          <p class="sk-profil-cote"><b></b><small>Elo</small></p>
          <p class="sk-profil-bilan"></p>
        </div>
      </header>
      <h3 class="sk-profil-titre">Ta pièce</h3>
      <p class="sk-profil-aide">Elle te représente au classement, et chez ceux dont tu es la némésis ou le sous-fifre.</p>
      <div class="sk-profil-collection">
        <h4 class="sk-profil-famille">Jetons communs <small data-compte="communs"></small></h4>
        <div class="sk-profil-grille" data-famille="communs"></div>
        <h4 class="sk-profil-famille">Jetons personnels <small data-compte="personnels"></small></h4>
        <div class="sk-profil-grille" data-famille="personnels"></div>
        <p class="sk-profil-aide sk-profil-aide--pied">Les jetons personnels se débloquent avec un code, dans le salon.</p>
      </div>
      <p class="sk-profil-erreur hidden" role="alert"></p>
    </section>`;
  fond.addEventListener('click', (e) => {
    if (e.target === fond) profilFermer();
  });
  fond.querySelector('.sk-profil-fermer').addEventListener('click', profilFermer);
  document.body.appendChild(fond);
  profilEtat.fond = fond;
  return fond;
}

function profilErreur(texte) {
  const p = profilEtat.fond.querySelector('.sk-profil-erreur');
  p.textContent = texte || '';
  p.classList.toggle('hidden', !texte);
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

  const miennes = new Set(d.pieces || []);
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

function profilChoisir(cle) {
  const d = profilEtat.donnees;
  if (!d || profilEtat.envoi || d.user.piece === cle) return;
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
      profilDessiner();
      const focus = profilEtat.fond.querySelector('.sk-profil-case--portee');
      if (focus) focus.focus();
      window.dispatchEvent(new CustomEvent('profil:piece', { detail: { piece: corps.piece } }));
    })
    .catch((err) => profilErreur(err.message || 'La pièce n’a pas pu être changée.'))
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
  if (profilEtat.donnees) profilDessiner();
  profilCharger()
    .then((d) => {
      if (!d) return profilErreur('Connecte-toi pour voir ton profil.');
      profilEtat.donnees = d;
      profilDessiner();
    })
    .catch(() => profilErreur('Le profil n’a pas pu être chargé. Réessaie dans un instant.'));
}
