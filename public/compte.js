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
//     du classement et de quoi se connecter ou se déconnecter.

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
    const home = document.getElementById('sk-screen-home');
    (home || document.body).appendChild(bandeau);
  }
  bandeau.textContent = '';

  const nom = document.createElement('span');
  nom.className = 'sk-compte-nom';
  if (compte.user) {
    nom.textContent = compte.user.pseudo;
    const elo = document.createElement('span');
    elo.className = 'sk-compte-elo';
    elo.textContent = `${compte.user.elo} Elo`;
    elo.title = `${compte.user.gamesPlayed} partie(s) classée(s), ${compte.user.wins} victoire(s)`;
    nom.appendChild(elo);
  } else {
    nom.textContent = 'Invité';
  }
  bandeau.appendChild(nom);

  const classement = document.createElement('a');
  classement.href = 'classement.html';
  classement.className = 'sk-compte-lien';
  classement.textContent = 'Classement';
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
