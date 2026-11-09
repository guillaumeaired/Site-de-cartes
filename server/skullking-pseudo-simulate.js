// Le pseudo de table d'un compte : un joueur connecté s'assied sous le nom de
// son compte, peut en prendre un autre au salon, et sa cote reste celle de
// son compte quoi qu'il affiche. Monté sur les vrais gestionnaires de salon
// et le vrai service de comptes (base en mémoire), avec de fausses sockets.

const { registerSkullKingHandlers, setComptesAdapter, rateGame } = require('./skullking-room');
const { createComptes, createMemoryStore } = require('./comptes');

let ok = 0;
let ko = 0;
function check(label, cond) {
  if (cond) ok += 1;
  else {
    ko += 1;
    console.error('ÉCHEC :', label);
  }
}

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
    last: {},
    on(ev, fn) {
      (this.handlers[ev] = this.handlers[ev] || []).push(fn);
    },
    trigger(ev, d) {
      (this.handlers[ev] || []).forEach((f) => f(d));
    },
    emit(ev, d) {
      this.last[ev] = d;
    },
  };
  sockets.set(id, s);
  registerSkullKingHandlers(io, s);
  return s;
}

async function main() {
  const store = createMemoryStore();
  const comptes = createComptes({ store });
  const anneU = await store.createUser('Anne', 'x');
  const jackU = await store.createUser('Jack', 'x');
  await comptes.init();
  const writes = [];
  setComptesAdapter({
    isReservedPseudo: comptes.isReservedPseudo,
    applyGameResult: async (game) => {
      writes.push(game);
      return {};
    },
  });

  const anne = makeSocket('A', { id: anneU.id, pseudo: 'Anne', elo: 1200 });
  const jack = makeSocket('J', { id: jackU.id, pseudo: 'Jack', elo: 1200 });
  const lou = makeSocket('L', undefined);

  const moi = (s) => s.last['skullking-lobby-update'].players.find((p) => p.id === s.id);

  // Le navigateur a beau envoyer un autre nom, on s'assied sous celui du compte.
  anne.trigger('skullking-create-room', { token: 'tA', nickname: 'Pirate' });
  const code = anne.last['skullking-room-created'].code;
  check('par défaut, le pseudo du compte', moi(anne).nickname === 'Anne' && moi(anne).accountPseudo === 'Anne');

  anne.trigger('skullking-set-nickname', { nickname: 'capitaine nemo' });
  check('un compte se renomme pour la table', moi(anne).nickname === 'Capitaine nemo');
  check('la cote reste celle du compte', moi(anne).elo === 1200 && moi(anne).accountPseudo === 'Anne');

  jack.trigger('skullking-join-room', { code, token: 'tJ' });
  anne.last['skullking-error'] = null;
  anne.trigger('skullking-set-nickname', { nickname: 'JACK' });
  check('pas le nom d’un autre compte', moi(anne).nickname === 'Capitaine nemo' && anne.last['skullking-error']);

  anne.trigger('skullking-set-nickname', { nickname: 'anne' });
  check('reprendre son propre nom est permis', moi(anne).nickname === 'Anne');

  lou.trigger('skullking-join-room', { code, token: 'tL', nickname: 'Lou' });
  lou.last['skullking-error'] = null;
  lou.trigger('skullking-set-nickname', { nickname: 'Anne' });
  check('un invité ne prend pas le nom d’un compte', moi(lou).nickname === 'Lou' && lou.last['skullking-error']);
  check('l’invité n’a pas de compte derrière lui', moi(lou).accountPseudo === null && moi(lou).isGuest);

  anne.trigger('skullking-set-nickname', { nickname: 'Barbe Rousse' });
  anne.trigger('skullking-start-game');
  const vue = jack.last['skullking-state'];
  check('la partie démarre', vue && vue.phase === 'bidding');
  const siege = vue.players.find((p) => p.nickname === 'Barbe Rousse');
  check('à table, le pseudo choisi et le compte derrière', siege && siege.accountPseudo === 'Anne' && siege.elo === 1200);

  // La fin de partie classe le compte, et l'archive garde les deux noms.
  {
    const room = {
      roundSequence: [1, 2],
      players: [
        { id: 's1', nickname: 'Barbe Rousse', userId: anneU.id, accountPseudo: 'Anne', elo: 1200, totalScore: 90 },
        { id: 's2', nickname: 'Jack', userId: jackU.id, accountPseudo: 'Jack', elo: 1200, totalScore: 10 },
      ],
    };
    const ranking = room.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      total: p.totalScore,
      accountPseudo: p.accountPseudo,
    }));
    check('partie classée', rateGame(io, room, ranking) === true);
    const ecrit = writes[writes.length - 1];
    const anneLigne = ecrit.results.find((r) => r.userId === anneU.id);
    check('la cote gagnée va au compte d’Anne', anneLigne && anneLigne.delta === 16 && anneLigne.won);
    const resume = ecrit.summary.find((r) => r.nickname === 'Barbe Rousse');
    check('l’archive garde le pseudo de table et le compte', resume && resume.account === 'Anne');
  }

  console.log(`\nskullking-pseudo-simulate.js : ${ok}/${ok + ko} assertions passées.`);
  process.exit(ko ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
