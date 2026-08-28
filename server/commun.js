// Ce que les quatre salons font exactement pareil. Ces deux fonctions étaient
// recopiées à l'identique dans index.js, rami-room.js, ascenseur-room.js et
// skullking-room.js : toute correction demandait quatre modifications, et
// deux d'entre elles s'étaient déjà croisées en conflit de fusion (le
// durcissement des pseudos contre la majuscule d'office, 28 août 2026).
// Le reste des fichiers *-room.js reste séparé : les règles diffèrent d'un
// jeu à l'autre, seul ce socle-là est commun.

// Le salon détenteur passe sa propre table de salons : le code doit être
// unique dans SON jeu, pas entre les jeux. Deux parties de Rami ne peuvent
// pas partager un code, une partie de Rami et une de Bataille si (elles
// n'entrent jamais en contact). Les caractères ambigus sont écartés du
// tirage : un code se lit à voix haute ou se recopie d'un téléphone à
// l'autre, un O pour un 0 ou un I pour un 1 coûte une tentative pour rien.
function makeRoomCode(rooms) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Defense en profondeur : on retire les chevrons, seul vecteur d'injection
// HTML dans les pseudos (les clients les affichent en contexte texte, jamais
// dans un attribut). On les *supprime* au lieu de les echapper : les clients
// echappent deja a l'insertion, un pseudo pre-echappe ici s'afficherait
// double-echappe. Le reste (& " ') est laisse tel quel, ces caracteres etant
// legitimes dans un pseudo et sans danger une fois echappes cote client.
// Cette couche ne dispense donc PAS d'echapper cote client.
function sanitizeNickname(nickname) {
  if (typeof nickname !== 'string') return null;
  const trimmed = nickname.replace(/[<>]/g, '').trim().slice(0, 16);
  if (!trimmed) return null;
  // Une majuscule d'office à l'initiale : le pseudo est affiché partout comme
  // un nom propre — au siège, au registre, dans le verdict de fin — et un
  // « hlo » en bas de casse au milieu de sept noms capitalisés se lit comme
  // une faute d'affichage. Le reste du pseudo n'est pas touché : « McGraw »
  // et « d'Aubigné » restent tels qu'ils ont été saisis.
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

module.exports = { makeRoomCode, sanitizeNickname };
