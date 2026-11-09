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
//   - un menu en haut à droite dit qui l'on est, avec sa cote, et déroule
//     Profil, Classement et Déconnexion. Il reste à l'accueil, au salon, au
//     récap de fin et sur la page du classement (la feuille de style le
//     retire pendant la partie, où la table prend tout l'écran).
//
// classement.html le charge aussi : là, ni renvoi vers la connexion ni
// changement de titre — seulement le menu.

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

// Le menu du compte, en haut à droite : une plaque (pièce, pseudo, cote)
// et dessous, les uns sous les autres et déroulés d'office, Profil,
// Classement et Déconnexion. Un clic sur la plaque les replie (ou les
// redéroule) ; le navigateur s'en souvient. Il suit l'accueil, le salon, le
// récap de fin et la page du classement ; pendant la partie, la table a
// besoin de tout l'écran.
const COMPTE_MENU_PLIE_KEY = 'skullking:menuPlie';

function compteMenuPlie() {
  try {
    return localStorage.getItem(COMPTE_MENU_PLIE_KEY) === '1';
  } catch {
    return false;
  }
}

// À table (salon, récap), quitter la page ferait quitter la partie.
function compteEstATable() {
  const home = document.getElementById('sk-screen-home');
  return Boolean(home && home.classList.contains('hidden'));
}

function compteDeroulerMenu(ouvert) {
  const bandeau = document.getElementById('sk-compte');
  if (!bandeau) return;
  bandeau.classList.toggle('sk-compte--ouvert', ouvert);
  bandeau.querySelector('.sk-compte-plaque').setAttribute('aria-expanded', String(ouvert));
  bandeau.querySelector('.sk-compte-menu').hidden = !ouvert;
}

function compteItem(texte, { href, onClick, courant } = {}) {
  const el = document.createElement(href ? 'a' : 'button');
  el.className = 'sk-compte-item';
  el.textContent = texte;
  if (href) el.href = href;
  else el.type = 'button';
  if (courant) {
    el.setAttribute('aria-current', 'page');
    el.classList.add('sk-compte-item--courant');
  }
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

function compteDeconnecter() {
  if (compteEstATable() && !window.confirm('Te déconnecter te fera quitter la table. Continuer ?')) return;
  fetch('/api/logout', { method: 'POST' })
    .catch(() => {})
    .finally(() => {
      try {
        localStorage.removeItem(COMPTE_INVITE_KEY);
      } catch {}
      window.location.href = compteLienConnexion();
    });
}

function compteBandeau() {
  let bandeau = document.getElementById('sk-compte');
  if (!bandeau) {
    bandeau = document.createElement('nav');
    bandeau.id = 'sk-compte';
    bandeau.className = 'sk-compte';
    bandeau.setAttribute('aria-label', 'Ton compte');
    // Sur le corps de la page et pas dans l'accueil : le menu suit
    // l'accueil, le salon et le récap de fin.
    document.body.appendChild(bandeau);
  }
  bandeau.textContent = '';

  // La plaque : ce qu'on voit tout le temps, et ce qui replie le menu.
  const plaque = document.createElement('button');
  plaque.type = 'button';
  plaque.className = 'sk-compte-plaque';
  plaque.setAttribute('aria-expanded', 'true');
  plaque.setAttribute('aria-controls', 'sk-compte-menu');

  if (compte.user && typeof profilPieceDe === 'function') {
    plaque.appendChild(profilMedaillon(profilPieceDe(compte.user), 'sk-compte-piece'));
  }

  const nom = document.createElement('span');
  nom.className = 'sk-compte-nom';
  nom.textContent = compte.user ? compte.user.pseudo : 'Invité';
  plaque.appendChild(nom);

  // La cote, en plaque de laiton : c'est le chiffre qu'on vient voir.
  if (compte.user) {
    const elo = document.createElement('span');
    elo.className = 'sk-compte-elo';
    elo.innerHTML = `<b>${Number(compte.user.elo)}</b><small>Elo</small>`;
    plaque.appendChild(elo);
  }

  const chevron = document.createElement('span');
  chevron.className = 'sk-compte-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  plaque.appendChild(chevron);

  plaque.title = 'Replier ou déplier le menu';
  plaque.addEventListener('click', () => {
    const ouvrir = !bandeau.classList.contains('sk-compte--ouvert');
    compteDeroulerMenu(ouvrir);
    try {
      localStorage.setItem(COMPTE_MENU_PLIE_KEY, ouvrir ? '0' : '1');
    } catch {}
  });
  bandeau.appendChild(plaque);

  const menu = document.createElement('div');
  menu.id = 'sk-compte-menu';
  menu.className = 'sk-compte-menu';

  if (compte.user && typeof profilOuvrir === 'function') {
    menu.appendChild(
      compteItem('Profil', {
        onClick: () => {
          plaque.focus();
          profilOuvrir();
        },
      }),
    );
  }

  // Le classement : à table, il s'ouvre dans un autre onglet.
  const surClassement = /classement\.html$/.test(window.location.pathname);
  menu.appendChild(
    compteItem('Classement', {
      href: 'classement.html',
      courant: surClassement,
      onClick: (e) => {
        if (surClassement) {
          e.preventDefault();
        } else if (compteEstATable()) {
          e.preventDefault();
          window.open('classement.html', '_blank', 'noopener');
        }
      },
    }),
  );

  if (compte.user) {
    menu.appendChild(compteItem('Déconnexion', { onClick: compteDeconnecter }));
  } else {
    menu.appendChild(compteItem('Se connecter', { href: compteLienConnexion() }));
  }

  bandeau.appendChild(menu);
  compteDeroulerMenu(!compteMenuPlie());
}

// La pièce du profil a changé : le médaillon du bandeau la reprend.
window.addEventListener('profil:piece', (e) => {
  if (!compte.user) return;
  compte.user.piece = e.detail.piece;
  if ('couleur' in e.detail) compte.user.couleur = e.detail.couleur;
  compteBandeau();
});

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
    const pageDuJeu = Boolean(document.getElementById('sk-screen-home'));
    if (site === 'skullking' && pageDuJeu) {
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
    if (pageDuJeu && !compte.user && !compteEstInvite() && !partieEnCours) {
      window.location.replace(compteLienConnexion());
      return;
    }

    compteAppliquerPseudo();
    compteBandeau();
  })
  .catch(() => {
    // Silencieux : la page reste jouable en invité.
  });
