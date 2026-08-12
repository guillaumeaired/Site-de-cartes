// Petit module partage (pas de dependance circulaire avec server/index.js,
// qui require les 4 fichiers *-room.js) : sert a distinguer, quand un
// rejoin-room echoue, "ce salon n'a jamais existe" de "le serveur vient de
// redemarrer et a perdu tout son etat en memoire" (audit Backend, 12 aout
// 2026) - un rejoin (contrairement a un join avec code tape a la main) ne
// se declenche que pour un salon qui existait deja pour ce client, donc un
// echec juste apres un redemarrage est tres probablement du a ca.
const SERVER_STARTED_AT = Date.now();
const RESTART_WINDOW_MS = 90_000;

function likelyServerRestart() {
  return Date.now() - SERVER_STARTED_AT < RESTART_WINDOW_MS;
}

module.exports = { SERVER_STARTED_AT, likelyServerRestart };
