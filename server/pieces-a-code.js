// Les pièces à code : des médaillons qu'aucun joueur n'a d'office. Chacune se
// débloque avec un code de quatre lettres, SANS LIMITE : chaque compte qui le
// saisit gagne la pièce et la garde. Plusieurs comptes peuvent donc avoir la
// même ; à une table, elle ne se porte qu'une fois (règle commune à toutes
// les pièces).
//
// Les codes ne quittent jamais le serveur : le client n'envoie que ce qu'on a
// tapé et ne reçoit que la pièce gagnée. Ce fichier ne doit donc pas partir
// sur un dépôt public.
//
// La casse ne compte pas : « RODI », « rodi » et « RoDi » sont le même code.

const CODES = {
  polz: 'pieuvre',
  rodi: 'pomme',
  sput: 'visa',
  belg: 'taureau',
  remz: 'viseur',
  toto: 'harvard',
  iqmm: 'surf',
};

const PIECES_A_CODE = Object.values(CODES);

// Ce qu'on a tapé, ramené à sa forme canonique : quatre lettres minuscules,
// ou null si ce n'en est pas.
function normaliserCode(brut) {
  const code = String(brut == null ? '' : brut).trim().toLowerCase();
  return /^[a-z]{4}$/.test(code) ? code : null;
}

function pieceDuCode(brut) {
  const code = normaliserCode(brut);
  return code ? CODES[code] || null : null;
}

module.exports = { PIECES_A_CODE, normaliserCode, pieceDuCode };
