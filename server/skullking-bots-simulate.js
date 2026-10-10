// Tests des bots à niveaux (voir briefs/bots-skullking.md). Les parties
// passent par l'arène, donc par la vraie salle : un coup refusé par le
// serveur y est un échec.

const assert = require('assert');
// Le Loup de mer calcule tant que son budget le lui permet : au plus court
// ici, une partie de test n'a pas à durer.
process.env.SK_BOT_BUDGET_MS = '1';
const { jouerPartie } = require('./skullking-arena');
const { NIVEAUX, niveauValide } = require('./skullking-bots');
const { nouvelleMemoire, observer, cartesInconnues, meilleureAnnonce, loiDesPlis } = require('./skullking-bots/commun');
const { EXTENSION_KEYS } = require('./skullking');
const salle = require('./skullking-room');
const bots = require('./skullking-bot');

let n = 0;
function check(label, actual, expected) {
  n += 1;
  assert.deepStrictEqual(actual, expected, `${label}\nattendu: ${JSON.stringify(expected)}\nreçu: ${JSON.stringify(actual)}`);
}

// --- Chaque niveau joue sans un seul coup refusé --------------------------

const tous = NIVEAUX.map((s) => s.niveau);
for (const [label, niveaux, extensions, manches] of [
  ['jeu de base, 4 joueurs', tous, [], 10],
  ['toutes les extensions, 7 joueurs', [...tous, 1, 2, 3, 3], EXTENSION_KEYS, 10],
  ['toutes les extensions, 3 joueurs', tous.slice(-3), EXTENSION_KEYS, 6],
]) {
  for (let essai = 0; essai < 2; essai++) {
    const partie = jouerPartie({ niveaux, manches, extensions });
    check(`${label} : aucun coup refusé`, partie.erreurs, []);
    check(`${label} : chaque siège a joué toutes les manches`, partie.sieges.map((s) => s.manches.length), niveaux.map(() => manches));
  }
}

// --- La mémoire de manche ------------------------------------------------------

function etat(extra) {
  return {
    phase: 'playing',
    roundNumber: 3,
    totalRounds: 10,
    cardsInRound: 3,
    myId: 'moi',
    extensions: {},
    hand: [{ id: 's0', kind: 'number', suit: 'vert', value: 1 }],
    players: [{ id: 'moi' }, { id: 'a' }, { id: 'b' }],
    currentTrick: [],
    ...extra,
  };
}

{
  const memoire = nouvelleMemoire();
  observer(memoire, etat({ currentTrick: [{ playerId: 'a', card: { id: 's20', kind: 'number', suit: 'jaune', value: 7 } }] }));
  observer(memoire, etat({
    currentTrick: [
      { playerId: 'a', card: { id: 's20', kind: 'number', suit: 'jaune', value: 7 } },
      { playerId: 'b', card: { id: 's30', kind: 'number', suit: 'violet', value: 3 } },
    ],
  }));
  check('une numérotée hors couleur prouve la coupe', [...(memoire.coupes.get('b') || [])], ['jaune']);
  check("l'entameur n'a rien coupé", memoire.coupes.has('a'), false);

  observer(memoire, etat({
    currentTrick: [
      { playerId: 'a', card: { id: 's28', kind: 'number', suit: 'violet', value: 1 } },
      { playerId: 'moi', card: { id: 's60', kind: 'pirate', name: 'Rosie la Douce' } },
    ],
  }));
  check('une carte spéciale ne prouve aucune coupe', memoire.coupes.has('moi'), false);

  const inconnues = cartesInconnues(etat({}), memoire).map((c) => c.id);
  check('les cartes tombées ne sont plus inconnues', ['s20', 's30', 's28', 's60', 's0'].some((id) => inconnues.includes(id)), false);
  check('sans mémoire, seules la main et le pli en cours sont connus', cartesInconnues(etat({}), memoire, false).some((c) => c.id === 's20'), true);

  observer(memoire, etat({ phase: 'bidding', roundNumber: 4 }));
  check('une nouvelle manche efface la mémoire', [memoire.vues.size, memoire.coupes.size], [0, 0]);
}

// --- L'annonce au meilleur gain espéré ----------------------------------------

check('la loi des plis somme à 1', Math.abs(loiDesPlis([0.3, 0.8, 0.5]).reduce((a, b) => a + b, 0) - 1) < 1e-12, true);
check('une main sans force annonce 0 en fin de partie', meilleureAnnonce([0.02, 0.03, 0.05, 0.01, 0, 0, 0, 0, 0], 9, 9), 0);
check('trois cartes maîtresses annoncent 3', meilleureAnnonce([0.97, 0.97, 0.97, 0, 0, 0], 6, 6), 3);

// --- Le salon : seul l'hôte change un niveau, et seulement celui d'un bot ----

{
  const lobbies = [];
  const io = {
    to(id) {
      return { emit(event, data) { if (event === 'skullking-lobby-update' && id === hote.id) lobbies.push(data); } };
    },
  };
  const { EventEmitter } = require('events');
  const socket = (id) => {
    const s = new EventEmitter();
    s.id = id;
    s.data = {};
    salle.registerSkullKingHandlers(io, s);
    return s;
  };
  const hote = socket('hote');
  const invite = socket('invite');
  let code;
  hote.on('skullking-room-created', (d) => { code = d.code; });
  hote.emit('skullking-create-room', { nickname: 'Hôte' });
  invite.emit('skullking-join-room', { code, nickname: 'Invité' });
  hote.emit('skullking-add-bot', { level: 3 });
  const dernier = () => lobbies[lobbies.length - 1];
  const bot = dernier().players.find((p) => p.isBot);
  check('le bot arrive au niveau demandé', bot.botLevel, 3);
  check('le salon publie les niveaux, dans l\'ordre', dernier().botLevels.map((l) => l.niveau), tous);
  check('les trois niveaux et leur difficulté', dernier().botLevels.map((l) => `${l.nom} : ${l.description}`), ['Mousse : Facile', 'Matelot : Intermédiaire', 'Loup de mer : Expert']);

  invite.emit('skullking-set-bot-level', { playerId: bot.id, level: 1 });
  check("un invité ne change pas le niveau d'un bot", bots.botLevel(bot.id), 3);
  hote.emit('skullking-set-bot-level', { playerId: 'invite', level: 1 });
  check("un humain n'a pas de niveau", bots.botLevel('invite'), null);
  hote.emit('skullking-set-bot-level', { playerId: bot.id, level: 99 });
  check('un niveau inconnu est refusé', bots.botLevel(bot.id), 3);
  hote.emit('skullking-set-bot-level', { playerId: bot.id, level: 4 });
  check('le niveau 4 n\'existe plus', bots.botLevel(bot.id), 3);
  hote.emit('skullking-set-bot-level', { playerId: bot.id, level: 1 });
  check("l'hôte change le niveau", dernier().players.find((p) => p.id === bot.id).botLevel, 1);
  hote.emit('skullking-add-bot', { level: 'n\'importe quoi' });
  check('un niveau illisible retombe sur le défaut', dernier().players.filter((p) => p.isBot).map((p) => p.botLevel), [1, niveauValide(2)]);
  for (const s of [hote, invite]) s.emit('skullking-leave-room');
}

console.log(`skullking-bots-simulate.js : ${n}/${n} assertions passées.`);
