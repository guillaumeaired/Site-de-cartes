// Quitter en pleine partie : un bot reprend le siège, le partant passe au
// bord de la table en spectateur, et le classement le compte dernier. Monté
// sur les vrais gestionnaires de salon, avec de fausses sockets et le vrai
// module de bots.

const { registerSkullKingHandlers, setBotAdapter, setComptesAdapter, rateGame } = require('./skullking-room');
const bots = require('./skullking-bot');

let ok = 0;
let ko = 0;
function check(label, cond) {
  if (cond) ok += 1;
  else {
    ko += 1;
    console.error('ÉCHEC :', label);
  }
}

setBotAdapter(bots);
const writes = [];
setComptesAdapter({
  isReservedPseudo: () => false,
  applyGameResult: async (game) => {
    writes.push(game);
    return {};
  },
});

const sockets = new Map();
const io = {
  to: (id) => ({ emit: (ev, d) => sockets.get(id) && sockets.get(id).emit(ev, d) }),
  sockets: { sockets },
};

function makeSocket(id, user) {
  const s = {
    id,
    data: { user },
    handlers: {},
    events: [],
    last: {},
    on(ev, fn) {
      (this.handlers[ev] = this.handlers[ev] || []).push(fn);
    },
    trigger(ev, d) {
      (this.handlers[ev] || []).forEach((f) => f(d));
    },
    emit(ev, d) {
      this.events.push(ev);
      this.last[ev] = d;
    },
  };
  sockets.set(id, s);
  registerSkullKingHandlers(io, s);
  return s;
}

const anne = makeSocket('A', { id: 1, pseudo: 'Anne', elo: 1200 });
const jack = makeSocket('J', { id: 2, pseudo: 'Jack', elo: 1200 });
const mary = makeSocket('M', { id: 3, pseudo: 'Mary', elo: 1200 });

anne.trigger('skullking-create-room', { token: 'tA' });
const code = anne.last['skullking-room-created'].code;
jack.trigger('skullking-join-room', { code, token: 'tJ' });
mary.trigger('skullking-join-room', { code, token: 'tM' });
anne.trigger('skullking-start-game');
check('la partie démarre', anne.last['skullking-state'].phase === 'bidding');

// L'hôte s'en va en pleine annonce.
anne.trigger('skullking-leave-room');
const vueAnne = anne.last['skullking-state'];
check('le partant n’est pas renvoyé à l’accueil', !anne.events.includes('skullking-left'));
check('le partant regarde la partie en spectateur', vueAnne.spectator === true && vueAnne.phase === 'bidding');
check('il voit encore les trois sièges', vueAnne.players.length === 3);
check('sa main ne lui est plus montrée', vueAnne.hand.length === 0);
const vueJack = jack.last['skullking-state'];
check('la partie continue pour les autres', vueJack.phase === 'bidding' && !jack.last['skullking-player-left']);
const siege = vueJack.players.find((p) => p.nickname === 'Anne');
check('le siège d’Anne est tenu par un bot', siege && bots.isBot(siege.id));
check('la barre passe à un humain', vueJack.isHost === true || mary.last['skullking-state'].isHost === true);
check('les autres sont prévenus', jack.last['skullking-player-replaced'].nickname === 'Anne');
const jackVu = vueJack.players.find((p) => p.nickname === 'Jack');
check('l’état de partie donne la cote de chaque compte', jackVu && jackVu.elo === 1200 && !jackVu.isGuest && !jackVu.isBot);
check('le siège repris garde la cote du partant', siege && siege.elo === 1200 && !siege.isBot);

// Un joueur seul face aux bots qui s'en va : la partie s'arrête, retour à
// l'accueil (pas de spectateur d'une partie entre bots).
jack.trigger('skullking-leave-room');
check('Jack aussi devient spectateur (Mary joue encore)', jack.last['skullking-state'].spectator === true);
mary.trigger('skullking-leave-room');
check('la dernière humaine sort vraiment', mary.events.includes('skullking-left'));

// Le classement : le partant est dernier, quoi qu'ait fait le bot.
{
  const room = {
    roundSequence: [1, 2, 3],
    spectators: [{ id: 'X', userId: 9, account: { id: 9, elo: 1200 } }],
    players: [
      { id: 'bot:1', nickname: 'Paul', userId: null, leaver: { userId: 9, elo: 1200 }, totalScore: 300 },
      { id: 's2', nickname: 'Lou', userId: 10, elo: 1200, totalScore: 50 },
      { id: 's3', nickname: 'Max', userId: 11, elo: 1200, totalScore: 10 },
    ],
  };
  const ranking = room.players.map((p) => ({ id: p.id, nickname: p.nickname, total: p.totalScore, left: Boolean(p.leaver) }));
  check('partie classée avec un partant', rateGame(io, room, ranking) === true);
  const paul = ranking.find((r) => r.id === 'bot:1');
  const lou = ranking.find((r) => r.id === 's2');
  const max = ranking.find((r) => r.id === 's3');
  check('le partant perd, même si son bot finit premier', paul.elo.delta < 0);
  check('le partant perd le plus', paul.elo.delta < max.elo.delta && max.elo.delta < lou.elo.delta);
  check('sa chaise de spectateur garde la nouvelle cote', room.spectators[0].account.elo === paul.elo.after);
  const ecrit = writes[writes.length - 1].results.find((r) => r.userId === 9);
  check('écrit en base sans victoire', ecrit && ecrit.won === false && ecrit.delta === paul.elo.delta);
  const gagnants = writes[writes.length - 1].results.filter((r) => r.won).map((r) => r.userId);
  check('le meilleur de ceux qui sont restés gagne, pas le siège du bot', gagnants.length === 1 && gagnants[0] === 10);
}

console.log(`\nskullking-depart-simulate.js : ${ok}/${ok + ko} assertions passées.`);
// Les bots encore assis ont des minuteurs de réflexion en cours.
process.exit(ko ? 1 : 0);
