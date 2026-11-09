// Les pièces de joueur, côté serveur : seulement les clés. Le dessin et les
// noms vivent côté client (voir PIECES dans public/skullking.js et
// PROFIL_PIECES dans public/profil.js) ; les trois listes doivent rester
// alignées.
//
// Deux familles :
//   - les jetons COMMUNS, que tout le monde a d'office (à table, les quatre
//     derniers restent réservés à l'hôte, voir skullking-room.js) ;
//   - les jetons PERSONNELS, gagnés un par un avec un code (pieces-a-code.js).

const { PIECES_A_CODE } = require('./pieces-a-code');

const PIECES_DE_BASE = [
  'crane', 'ancre', 'voilier', 'sabre', 'boussole',
  'coffre', 'barre', 'bouteille', 'crochet',
  'pieuvre', 'ivrogne', 'poison', 'canon',
];

// Puis les pièces à code qui n'y sont pas déjà — la pieuvre garde son rang
// d'origine.
const PIECE_KEYS = [...PIECES_DE_BASE, ...PIECES_A_CODE.filter((k) => !PIECES_DE_BASE.includes(k))];

const PIECES_COMMUNES = PIECES_DE_BASE.filter((k) => !PIECES_A_CODE.includes(k));

module.exports = { PIECES_DE_BASE, PIECE_KEYS, PIECES_COMMUNES, PIECES_A_CODE };
