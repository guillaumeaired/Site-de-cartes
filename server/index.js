// Serveur Express + Socket.io de Guimams. Il ne contient plus aucune règle de
// jeu : chaque jeu vit dans son propre couple `<jeu>.js` (les règles pures) et
// `<jeu>-room.js` (les salons), et vient simplement brancher ses gestionnaires
// ici. Ce fichier ne garde que ce qui est commun à tous : servir les pages,
// les trois routes techniques, et le filet de sécurité du process.
//
// Ça n'a pas toujours été le cas : la Bataille, premier jeu du site, avait ses
// salons écrits directement ici. Elle a été retirée le 31 août 2026 et
// remplacée par Le 24 dans la vitrine ; l'occasion de ramener ce fichier à son
// seul rôle d'infrastructure.

const path = require('path');
const os = require('os');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { SERVER_STARTED_AT } = require('./server-start');
const { getPlayCounts } = require('./play-counts');
const { registerRamiHandlers, getStats: getRamiStats } = require('./rami-room');
const { registerAscenseurHandlers, getStats: getAscenseurStats } = require('./ascenseur-room');
const { registerVingtquatreHandlers, getStats: getVingtquatreStats } = require('./vingtquatre-room');
const {
  registerSkullKingHandlers,
  setBotAdapter: setSkullKingBotAdapter,
  getStats: getSkullKingStats,
} = require('./skullking-room');
// Bots Skull King : branchés ici pour que le module de salle n'en dépende pas.
setSkullKingBotAdapter(require('./skullking-bot'));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Retire l'en-tete qui annonce la stack technique (Express), et ajoute les
// protections HTTP standards (aucune n'a de cout fonctionnel ici : pas
// d'iframe, pas d'upload de fichiers a sniffer).
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

// Adresse IP locale de la machine sur le reseau Wi-Fi, pour que le lien
// partage fonctionne meme si l'hote a ouvert la page via "localhost".
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const LAN_IP = getLanIp();

// Health check applicatif (pas juste TCP) : a declarer comme healthCheckPath
// cote dashboard Render. Repond tant que la boucle d'evenements tourne.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000) });
});

// Observabilite minimale : combien de salons/parties tournent par jeu, sans
// avoir a depouiller les logs Render. Pas d'auth ici (aucune donnee
// personnelle exposee, juste des compteurs), a revisiter si le trafic
// justifie de le proteger.
app.get('/stats', (req, res) => {
  res.json({
    uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    rami: getRamiStats(),
    ascenseur: getAscenseurStats(),
    skullking: getSkullKingStats(),
    vingtquatre: getVingtquatreStats(),
  });
});

// Nombre de parties lancees par jeu (persiste entre reveils, pas entre
// redeploiements) - consomme par le hub pour trier les jeux du plus au
// moins joue.
app.get('/play-counts', (req, res) => {
  res.json(getPlayCounts());
});

io.on('connection', (socket) => {
  registerRamiHandlers(io, socket);
  registerAscenseurHandlers(io, socket);
  registerSkullKingHandlers(io, socket);
  registerVingtquatreHandlers(io, socket);
});

// Filet de securite process : l'etat de toutes les parties (4 jeux) ne vit
// qu'en memoire (pas de BDD). Apres une exception non prevue, cet etat peut
// etre partiellement mute et incoherent - continuer a servir des requetes
// dessus risquerait de propager la corruption a d'autres salons plutot que
// de la contenir. On logue puis on arrete proprement le process pour laisser
// Render en relancer un neuf, plutot que logguer-et-continuer indefiniment
// (audit Backend, 12 aout 2026).
function crashSafely(kind, err) {
  console.error(`[${kind}]`, new Date().toISOString(), err);
  httpServer.close(() => process.exit(1));
  // Filet de secours si close() reste bloque (ex. sockets qui ne se
  // terminent jamais) : on force la sortie plutot que de rester zombie.
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('uncaughtException', (err) => crashSafely('uncaughtException', err));
process.on('unhandledRejection', (reason) => crashSafely('unhandledRejection', reason));

httpServer.listen(PORT, () => {
  console.log(`Serveur lancé : http://localhost:${PORT} (réseau local : http://${LAN_IP}:${PORT})`);
});
