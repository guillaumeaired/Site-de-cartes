// La porte du Skull King : se connecter, créer son compte, ou entrer en
// invité. Elle renvoie ensuite là d'où l'on venait (paramètre `next`), lien
// d'invitation compris, pour qu'un ami qui clique sur le lien d'un salon y
// arrive après s'être identifié.

const INVITE_KEY = 'skullking:invite';

const form = document.getElementById('porte-form');
const inputPseudo = document.getElementById('porte-pseudo');
const inputCode = document.getElementById('porte-code');
const aide = document.getElementById('porte-aide');
const btnValider = document.getElementById('porte-valider');
const erreur = document.getElementById('porte-erreur');
const btnInvite = document.getElementById('porte-invite');
const onglets = [...document.querySelectorAll('.sk-porte-onglets button')];

let mode = 'login';
let site = null;

// Seulement un chemin de ce site : un `next` vers ailleurs ferait de cette
// page un tremplin pour renvoyer quelqu'un sur un site piégé.
function destination() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) return next;
  return site === 'skullking' ? '/' : 'skullking.html';
}

function partir() {
  window.location.replace(destination());
}

function choisirMode(m) {
  mode = m;
  onglets.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  btnValider.textContent = m === 'login' ? 'Se connecter' : 'Créer mon compte';
  inputCode.autocomplete = m === 'login' ? 'current-password' : 'new-password';
  aide.classList.toggle('hidden', m !== 'register');
  erreur.textContent = '';
  inputPseudo.focus();
dessinerPin();
// Un remplissage automatique au chargement arrive parfois après le script.
setTimeout(dessinerPin, 600);
}

onglets.forEach((b) => b.addEventListener('click', () => choisirMode(b.dataset.mode)));

// Les quatre cases du code : un point par chiffre tapé, et la case où ira
// le prochain chiffre marquée tant que le champ a le focus.
const casesPin = [...document.querySelectorAll('.sk-pin-case')];
function dessinerPin() {
  const n = inputCode.value.length;
  casesPin.forEach((c, i) => {
    c.textContent = i < n ? '•' : '';
    c.classList.toggle('sk-pin-case--pleine', i < n);
    c.classList.toggle('sk-pin-case--courante', i === Math.min(n, casesPin.length - 1));
  });
}

// Le champ du code n'accepte que des chiffres, même collés.
inputCode.addEventListener('input', () => {
  const propre = inputCode.value.replace(/\D/g, '').slice(0, 4);
  if (propre !== inputCode.value) inputCode.value = propre;
  dessinerPin();
});
// Le gestionnaire de mots de passe peut remplir le champ sans « input ».
inputCode.addEventListener('change', dessinerPin);
// Le curseur reste toujours en bout de code : les cases se remplissent
// dans l'ordre, on ne corrige qu'en effaçant.
inputCode.addEventListener('focus', () => {
  const fin = inputCode.value.length;
  requestAnimationFrame(() => inputCode.setSelectionRange && inputCode.setSelectionRange(fin, fin));
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pseudo = inputPseudo.value.trim();
  const pin = inputCode.value;
  if (!pseudo) {
    erreur.textContent = 'Entre ton pseudo.';
    inputPseudo.focus();
dessinerPin();
// Un remplissage automatique au chargement arrive parfois après le script.
setTimeout(dessinerPin, 600);
    return;
  }
  if (!/^\d{4}$/.test(pin)) {
    erreur.textContent = 'Le code fait 4 chiffres.';
    inputCode.focus();
    return;
  }
  erreur.textContent = '';
  btnValider.disabled = true;
  try {
    const res = await fetch(mode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pseudo, pin }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      erreur.textContent = body.error || 'Ça n’a pas marché, réessaie.';
      // Pseudo inconnu à la connexion : on propose directement de le créer.
      if (res.status === 404 && mode === 'login') {
        choisirMode('register');
        inputPseudo.value = pseudo;
        erreur.textContent = 'Aucun compte à ce pseudo : crée-le avec ce code.';
        inputCode.value = pin;
        dessinerPin();
        btnValider.focus();
      } else {
        inputCode.value = '';
        dessinerPin();
        inputCode.focus();
      }
      return;
    }
    try {
      localStorage.removeItem(INVITE_KEY);
    } catch {}
    partir();
  } catch {
    erreur.textContent = 'Le serveur ne répond pas — il se réveille peut-être, réessaie dans quelques secondes.';
  } finally {
    btnValider.disabled = false;
  }
});

btnInvite.addEventListener('click', () => {
  try {
    localStorage.setItem(INVITE_KEY, '1');
  } catch {}
  partir();
});

// Déjà connecté : rien à faire ici.
fetch('/api/me', { credentials: 'same-origin' })
  .then((res) => (res.ok ? res.json() : null))
  .then((me) => {
    if (!me) return;
    site = me.site;
    if (me.user) partir();
  })
  .catch(() => {});

inputPseudo.focus();
dessinerPin();
// Un remplissage automatique au chargement arrive parfois après le script.
setTimeout(dessinerPin, 600);
