// Les couleurs de joueur. La pièce d'un joueur, c'est un MOTIF (pieces.js) dans
// une COULEUR d'émail : le motif dit qui l'on est pour soi, la couleur dit qui
// l'on est pour la table — c'est elle qui peint le secteur de la roue, la
// ligne de la courbe, la pastille de la légende. Il y a donc plus de motifs
// que de couleurs possible, mais jamais deux joueurs de la même couleur à une
// table.
//
// Quatorze couleurs, une table en compte neuf au plus (voir maxPlayersFor) : il
// en reste toujours cinq à choisir. Le dessin et le code hexadécimal vivent
// côté client (COULEURS dans public/skullking.js et public/profil.js) ; les
// images, dans public/assets/skin/pieces/<motif>-<couleur>.webp
// (briefs/composer-pieces-couleur.py). Les trois listes doivent rester
// alignées.

const COULEURS = [
  'rouge', 'orange', 'jaune', 'anis', 'vert', 'menthe',
  'turquoise', 'ciel', 'marine', 'violet', 'magenta', 'rose',
  'blanc', 'noir',
];

// La couleur d'un motif tant que son joueur n'en a pas choisi : la plus
// proche de l'émail de son médaillon d'origine. Les neuf de la vitrine ont
// chacune la leur, pour qu'une table où personne ne choisit reste lisible.
const COULEUR_PAR_DEFAUT = {
  crane: 'rouge', ancre: 'marine', voilier: 'vert', sabre: 'violet',
  boussole: 'jaune', coffre: 'turquoise', barre: 'orange', bouteille: 'anis',
  crochet: 'magenta',
  pieuvre: 'ciel', ivrogne: 'rouge', poison: 'anis', canon: 'turquoise',
  pomme: 'ciel', visa: 'rose', taureau: 'rose', viseur: 'menthe', harvard: 'rouge',
};

function couleurValide(couleur) {
  return typeof couleur === 'string' && COULEURS.includes(couleur);
}

function couleurParDefaut(piece) {
  return COULEUR_PAR_DEFAUT[piece] || COULEURS[0];
}

module.exports = { COULEURS, COULEUR_PAR_DEFAUT, couleurValide, couleurParDefaut };
