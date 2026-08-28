// Ce que les quatre jeux font exactement pareil côté navigateur. Chargé avant
// le script de chaque jeu (voir les <script> en bas des pages), sans étape de
// build : ce sont des scripts classiques, tout ce qui est déclaré ici est
// visible depuis client.js, rami.js, ascenseur.js et skullking.js.
//
// Pendant du server/commun.js côté serveur, et même raison d'être : une
// fonction recopiée dans quatre fichiers finit par n'être corrigée que dans
// trois. N'y mettre que ce qui est vraiment identique et sans attache au
// balisage d'un jeu — les fonctions qui vont chercher un élément par son id
// restent chez elles, leurs id diffèrent d'une page à l'autre.

// Identite persistante de cet ONGLET (survit a une reconnexion ou un
// rechargement, contrairement a socket.id qui change a chaque fois) + partie
// active pour pouvoir revenir automatiquement via le lien, le code, ou un
// retour en arriere. sessionStorage (pas localStorage) : chaque onglet doit
// avoir sa propre identite, sinon un 2e onglet du meme navigateur "vole"
// la session du 1er au lieu de pouvoir rejoindre en tant que 2e joueur.
// La clé est volontairement commune aux quatre jeux : c'est la même personne
// sur le même onglet, qu'elle passe de la Bataille au Skull King ou non.
function getPlayerToken() {
  let token = sessionStorage.getItem('cardGamesPlayerToken');
  if (!token) {
    token = crypto.randomUUID();
    sessionStorage.setItem('cardGamesPlayerToken', token);
  }
  return token;
}

// Le serveur borne les pseudos et leur retire les chevrons (sanitizeNickname,
// server/commun.js), mais il ne les échappe pas : tout pseudo inséré dans un
// innerHTML doit passer par ici, sinon un pseudo contenant du HTML s'exécute
// chez tous les autres joueurs de la table. Deux failles XSS ont déjà été
// trouvées dans ce projet par ce chemin exact — le nettoyage côté serveur est
// une seconde ligne de défense, pas un remplacement de celle-ci.
// Le plus sûr reste de poser le texte en textContent quand c'est possible :
// c'est ce que font le Rami et la Bataille, qui n'ont donc pas besoin d'appeler
// cette fonction.
function escapeHTML(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Un joueur peut avoir quitté la table entre-temps : on affiche '?' plutôt
// que de laisser passer un undefined jusqu'à l'écran.
function nicknameOf(state, id) {
  const p = state.players.find((pp) => pp.id === id);
  return p ? p.nickname : '?';
}

// Les cartes classiques (Bataille, Rami, Ascenseur). Le Skull King a ses
// propres familles et n'utilise donc rien de tout ceci.
const RED_SUITS = new Set(['coeur', 'carreau']);

function cardColorClass(card) {
  return RED_SUITS.has(card.suit) ? 'card-red' : 'card-black';
}

// --- Le chat de salon, pour les jeux qui en ont un -----------------------
// Le Rami et le Skull King affichent la même conversation, servie par le même
// schéma d'événements côté serveur. Leurs deux versions avaient divergé en se
// recopiant : le Skull King avait gagné trois vues, la couleur de l'auteur et
// l'insertion chronologique, le Rami gardait l'heure du message. Cette fabrique
// tient les quatre différences en paramètres plutôt qu'en deux fichiers.
//
// Ce qui est PARTAGÉ ici : le texte est posé en textContent, jamais en
// innerHTML. Le message vient d'un autre joueur et le serveur le stocke tel
// quel (il ne fait que borner la longueur) — c'est au rendu que se joue la
// sécurité, et deux failles XSS ont déjà été trouvées dans ce projet par ce
// chemin exact. Une seule copie de cette règle, c'est une règle qu'on ne peut
// plus oublier de la moitié des jeux.
//
//   prefixe   racine des classes CSS ('rami-chat' -> .rami-chat-line, -who,
//             -text, -time, et -line--me)
//   vues      [{ log, form, input }] — le Skull King en a trois (la table, le
//             salon, la planche agrandie), le Rami une seule. Les entrées
//             incomplètes sont écartées : toutes les pages n'ont pas tout.
//   moi       () => l'id du joueur local ; une fonction, pas une valeur : il
//             n'est pas encore connu au chargement du script
//   envoyer   (texte) => l'émission socket propre au jeu
//   avecHeure pose l'heure du message à côté du nom
//   couleurDe (playerId) => couleur du nom, ou rien pour le laisser au CSS
function creerChat({ prefixe, vues, moi, envoyer, avecHeure = false, couleurDe = null }) {
  const utiles = (vues || []).filter((v) => v && v.log && v.form && v.input);
  const vus = new Set();
  let salon = null;

  // Le fil appartient au SALON, pas à l'onglet : en enchaînant deux parties
  // sans recharger la page, la conversation de la précédente restait affichée
  // sous la nouvelle. On repart d'une page blanche dès qu'on change de salon
  // (ou qu'on rentre à l'accueil). Vider `vus` fait partie du reset : les
  // numéros repartent de `c1` quand le serveur redémarre, et les nouveaux
  // messages passeraient sinon pour des doublons déjà vus.
  function suivreSalon(code) {
    const suivant = code ? String(code).toUpperCase() : null;
    if (suivant === salon) return;
    salon = suivant;
    vus.clear();
    utiles.forEach((v) => v.log.replaceChildren());
  }

  // Ne recolle en bas que si on y était déjà : sinon on arrache la lecture à
  // quelqu'un en train de remonter l'historique.
  function auBas(log) {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  }

  function heureDe(at) {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // Le rang du message dans le fil. Le serveur numérote en continu (`c1`,
  // `c2`…), ce qui donne un ordre sûr là où l'heure d'arrivée ne dit rien.
  function rangDe(m) {
    const n = Number(String(m.id).slice(1));
    return Number.isFinite(n) ? n : 0;
  }

  // Une ligne neuve par vue : un même nœud ne peut pas être à deux endroits
  // du document à la fois.
  function ligne(m) {
    const el = document.createElement('div');
    el.className = `${prefixe}-line` + (m.playerId === moi() ? ` ${prefixe}-line--me` : '');

    const tete = document.createElement('span');
    tete.className = `${prefixe}-who`;
    tete.textContent = m.playerId === moi() ? 'Toi' : m.nickname;
    // L'auteur reste inscrit sur la ligne : c'est ce qui permet de la
    // repeindre plus tard, quand sa couleur change (voir repeindre).
    if (m.playerId) tete.dataset.joueur = m.playerId;
    const couleur = couleurDe && couleurDe(m.playerId);
    if (couleur) tete.style.color = couleur;

    if (avecHeure) {
      const heure = document.createElement('span');
      heure.className = `${prefixe}-time`;
      heure.textContent = heureDe(m.at);
      tete.appendChild(heure);
    }

    const corps = document.createElement('span');
    corps.className = `${prefixe}-text`;
    corps.textContent = m.text;

    el.append(tete, corps);
    return el;
  }

  function ajouter(m) {
    if (!m || vus.has(m.id)) return;
    vus.add(m.id);
    const rang = rangDe(m);
    utiles.forEach((vue) => {
      const colle = auBas(vue.log);
      const el = ligne(m);
      el.dataset.rang = String(rang);
      // Le fil est chronologique, or l'ordre d'ARRIVÉE ne l'est pas : en
      // rejoignant un salon on reçoit d'abord la diffusion en direct de sa
      // propre arrivée, et seulement ensuite l'historique qui la précède —
      // « Untel a rejoint » se posait donc avant « Untel a ouvert le salon ».
      // On insère à sa place plutôt qu'en fin de liste ; à l'usage courant le
      // message est le plus récent et la recherche s'arrête tout de suite.
      const suivant = [...vue.log.children].find((n) => Number(n.dataset.rang) > rang);
      vue.log.insertBefore(el, suivant || null);
      while (vue.log.childElementCount > 80) vue.log.removeChild(vue.log.firstChild);
      if (colle) vue.log.scrollTop = vue.log.scrollHeight;
    });
  }

  // Repeint les noms déjà posés. Le sélecteur balaie le document entier :
  // la même conversation est écrite dans chaque vue, avec ses propres nœuds.
  // Sans couleur connue on efface le style en ligne plutôt que d'en poser
  // une, pour retomber sur la couleur par défaut de la feuille de style.
  function repeindre() {
    if (!couleurDe) return;
    document.querySelectorAll(`.${prefixe}-who[data-joueur]`).forEach((tete) => {
      tete.style.color = couleurDe(tete.dataset.joueur) || '';
    });
  }

  utiles.forEach((vue) => {
    vue.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const texte = vue.input.value.trim();
      if (!texte) return;
      envoyer(texte);
      vue.input.value = '';
    });
  });

  return {
    suivreSalon,
    ajouter,
    repeindre,
    rendre: (state) => (state.chat || []).forEach(ajouter),
  };
}
