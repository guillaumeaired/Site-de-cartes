// Qui joue sur cette page du Skull King : un compte (pseudo + cote Elo) ou un
// invité. Chargé avant skullking.js, sans rien lui imposer : tant que
// /api/me n'a pas répondu, ou s'il ne répond pas (serveur qui se réveille),
// la page marche exactement comme en invité.
//
// Ce que ça change sur la page :
//   - au premier passage, ni connecté ni invité déclaré, on part sur la page
//     de connexion — elle revient ici ensuite, lien d'invitation compris ;
//   - connecté, le pseudo est celui du compte : les champs le portent déjà
//     et ne se modifient pas (le serveur l'impose de toute façon) ;
//   - un bandeau en haut à droite dit qui l'on est, avec sa cote, le lien
//     du classement et de quoi se connecter ou se déconnecter. Il reste à
//     l'accueil, au salon et au récap de fin (la feuille de style le retire
//     pendant la partie, où la table prend tout l'écran).

const COMPTE_INVITE_KEY = 'skullking:invite';

const compte = {
  user: null,
  site: null,
  pret: false,
};

function compteEstInvite() {
  try {
    return localStorage.getItem(COMPTE_INVITE_KEY) === '1';
  } catch {
    return true;
  }
}

// Remet le pseudo du compte dans les champs : appelé à la réponse de
// /api/me, puis par skullking.js chaque fois qu'il les vide (retour à
// l'accueil).
function compteAppliquerPseudo() {
  if (!compte.user) return;
  ['sk-input-nickname', 'sk-join-modal-nickname'].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.value = compte.user.pseudo;
    input.readOnly = true;
    input.title = 'Le pseudo de ton compte';
    input.classList.add('sk-pseudo-compte');
  });
}

function compteLienConnexion() {
  const next = window.location.pathname + window.location.search;
  return `connexion.html?next=${encodeURIComponent(next)}`;
}

function compteBandeau() {
  let bandeau = document.getElementById('sk-compte');
  if (!bandeau) {
    bandeau = document.createElement('nav');
    bandeau.id = 'sk-compte';
    bandeau.className = 'sk-compte';
    bandeau.setAttribute('aria-label', 'Ton compte');
    // Sur le corps de la page et pas dans l'accueil : le bandeau suit
    // l'accueil, le salon et le récap de fin.
    document.body.appendChild(bandeau);
  }
  bandeau.textContent = '';

  const nom = document.createElement('span');
  nom.className = 'sk-compte-nom';
  nom.textContent = compte.user ? compte.user.pseudo : 'Invité';
  bandeau.appendChild(nom);

  // La cote, en plaque de laiton : c'est le chiffre qu'on vient voir.
  if (compte.user) {
    const elo = document.createElement('span');
    elo.className = 'sk-compte-elo';
    elo.innerHTML = `<b>${Number(compte.user.elo)}</b><small>Elo</small>`;
    elo.title = `${compte.user.gamesPlayed} partie(s) classée(s), ${compte.user.wins} victoire(s)`;
    bandeau.appendChild(elo);
  }

  // Un vrai bouton de laiton, pas un lien de texte. Hors de l'accueil (salon,
  // récap), il ouvre un autre onglet : quitter la page ferait quitter la
  // table.
  const classement = document.createElement('a');
  classement.href = 'classement.html';
  classement.className = 'sk-compte-classement';
  classement.textContent = 'Classement';
  classement.addEventListener('click', (e) => {
    const home = document.getElementById('sk-screen-home');
    if (home && home.classList.contains('hidden')) {
      e.preventDefault();
      window.open(classement.href, '_blank', 'noopener');
    }
  });
  bandeau.appendChild(classement);

  if (compte.user) {
    const sortir = document.createElement('button');
    sortir.type = 'button';
    sortir.className = 'sk-compte-lien';
    sortir.textContent = 'Déconnexion';
    sortir.addEventListener('click', () => {
      fetch('/api/logout', { method: 'POST' })
        .catch(() => {})
        .finally(() => {
          try {
            localStorage.removeItem(COMPTE_INVITE_KEY);
          } catch {}
          window.location.href = compteLienConnexion();
        });
    });
    bandeau.appendChild(sortir);
  } else {
    const entrer = document.createElement('a');
    entrer.href = compteLienConnexion();
    entrer.className = 'sk-compte-lien sk-compte-lien--fort';
    entrer.textContent = 'Se connecter';
    bandeau.appendChild(entrer);
  }
}

// La cote a bougé (fin d'une partie classée, voir renderGameEnd) : le
// bandeau la reprend sans attendre un rechargement.
function compteMajCote(elo) {
  if (!compte.user || elo == null || compte.user.elo === elo) return;
  compte.user.elo = elo;
  compteBandeau();
}

fetch('/api/me', { credentials: 'same-origin' })
  .then((res) => (res.ok ? res.json() : Promise.reject(new Error('api/me'))))
  .then(({ user, site }) => {
    compte.user = user || null;
    compte.site = site || null;
    compte.pret = true;

    // Déploiement dédié : pas d'autre jeu vers lequel revenir.
    if (site === 'skullking') {
      document.title = 'Skull King';
      const retour = document.querySelector('.sk-hero-back');
      if (retour) retour.remove();
    }

    // Une partie déjà en cours dans cet onglet (rechargement) ne part jamais
    // vers la connexion : on la perdrait.
    let partieEnCours = false;
    try {
      partieEnCours = Boolean(sessionStorage.getItem('skullking:activeRoom'));
    } catch {}
    if (!compte.user && !compteEstInvite() && !partieEnCours) {
      window.location.replace(compteLienConnexion());
      return;
    }

    compteAppliquerPseudo();
    compteBandeau();
  })
  .catch(() => {
    // Silencieux : la page reste jouable en invité.
  });
