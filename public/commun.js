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
