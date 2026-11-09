// Suite de tests des comptes et de l'Elo : le calcul de cote, le code à
// quatre chiffres, le frein des essais, les routes /api/* (montées sur un vrai
// serveur Express, base en mémoire) et le classement d'une fin de partie.

const express = require('express');
const { createServer } = require('http');
const { computeEloChanges, ELO_INITIAL } = require('./elo');
const { createComptes, createMemoryStore, LoginLimiter, hashPin, verifyPin, readCookie, pseudoKey } = require('./comptes');
const { rateGame, setComptesAdapter } = require('./skullking-room');

let ok = 0;
let ko = 0;
function check(label, cond) {
  if (cond) ok += 1;
  else {
    ko += 1;
    console.error('ÉCHEC :', label);
  }
}

async function main() {
  // --- Elo ---------------------------------------------------------------
  {
    const [a, b] = computeEloChanges([
      { userId: 1, elo: 1200, score: 100 },
      { userId: 2, elo: 1200, score: 50 },
    ]);
    check('duel à cotes égales : +16 / -16', a.delta === 16 && b.delta === -16);
    check('le vainqueur monte', a.after === 1216 && b.after === 1184);
  }
  {
    const [a, b] = computeEloChanges([
      { userId: 1, elo: 1200, score: 80 },
      { userId: 2, elo: 1200, score: 80 },
    ]);
    check('égalité à cotes égales : rien ne bouge', a.delta === 0 && b.delta === 0);
  }
  {
    const [fort, faible] = computeEloChanges([
      { userId: 1, elo: 1600, score: 100 },
      { userId: 2, elo: 1200, score: 0 },
    ]);
    check('le favori qui gagne prend peu', fort.delta > 0 && fort.delta < 4);
    check('somme nulle en duel', fort.delta + faible.delta === 0);
  }
  {
    const changes = computeEloChanges([
      { userId: 1, elo: 1200, score: 300 },
      { userId: 2, elo: 1200, score: 200 },
      { userId: 3, elo: 1200, score: 100 },
      { userId: 4, elo: 1200, score: -50 },
    ]);
    check('à quatre : le premier ne prend pas plus qu’un duel gagné', changes[0].delta === 16);
    check('à quatre : le dernier perd autant', changes[3].delta === -16);
    check('à quatre : les places du milieu se répartissent', changes[1].delta > 0 && changes[2].delta < 0);
  }
  check('un joueur seul : rien', computeEloChanges([{ userId: 1, elo: 1200, score: 9 }])[0].delta === 0);

  // --- Code et pseudo ------------------------------------------------------
  {
    const h = await hashPin('0420');
    check('le code haché se vérifie', await verifyPin('0420', h));
    check('un autre code est refusé', !(await verifyPin('0421', h)));
    check('le hachage est salé', h !== (await hashPin('0420')));
    check('pseudo : casse et espaces ignorés', pseudoKey('Barbe  Noire') === pseudoKey('barbe noire'));
    check('cookie relu', readCookie('a=1; sk_session=xyz; b=2', 'sk_session') === 'xyz');
  }

  // --- Frein -------------------------------------------------------------
  {
    const lim = new LoginLimiter({ perPseudo: 3, perIp: 5 });
    const t = 1_000_000;
    lim.fail('Jack', '1.1.1.1', t);
    lim.fail('jack', '1.1.1.1', t + 1);
    check('deux échecs : encore permis', lim.blockedFor('Jack', '1.1.1.1', t + 2) === 0);
    lim.fail('JACK', '1.1.1.1', t + 2);
    check('trois échecs : pseudo fermé', lim.blockedFor('Jack', '2.2.2.2', t + 3) > 0);
    check('un autre pseudo reste ouvert', lim.blockedFor('Anne', '2.2.2.2', t + 3) === 0);
    check('rouvert après la fenêtre', lim.blockedFor('Jack', '2.2.2.2', t + 16 * 60_000) === 0);
    lim.fail(null, '1.1.1.1', t + 4);
    lim.fail(null, '1.1.1.1', t + 5);
    check('cinq échecs d’une adresse : adresse fermée', lim.blockedFor('Anne', '1.1.1.1', t + 6) > 0);
    check('sans pseudo, le frein par pseudo ne compte pas', lim.blockedFor(null, '3.3.3.3', t + 6) === 0);
  }

  // --- Routes HTTP ----------------------------------------------------------
  const comptes = createComptes({ store: createMemoryStore(), site: 'skullking' });
  await comptes.init();
  const app = express();
  comptes.registerRoutes(app, express);
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body || {}),
    });
  const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

  try {
    let res = await fetch(`${base}/api/me`);
    let body = await res.json();
    check('/api/me sans session : invité', body.user === null && body.site === 'skullking');

    res = await post('/api/register', { pseudo: 'barbe noire', pin: '12a4' });
    check('code non numérique refusé', res.status === 400);
    res = await post('/api/register', { pseudo: 'x', pin: '1234' });
    check('pseudo trop court refusé', res.status === 400);

    res = await post('/api/register', { pseudo: 'barbe noire', pin: '1234' });
    body = await res.json();
    check('inscription', res.status === 201 && body.user.pseudo === 'Barbe noire' && body.user.elo === ELO_INITIAL);
    const cookie = cookieOf(res);
    check('cookie de session posé, HttpOnly', cookie.startsWith('sk_session=') && /HttpOnly/.test(res.headers.get('set-cookie')));
    check('pseudo réservé aux invités', comptes.isReservedPseudo('BARBE NOIRE'));

    res = await post('/api/register', { pseudo: 'Barbe Noire', pin: '9999' });
    check('pseudo déjà pris (autre casse)', res.status === 409);

    res = await fetch(`${base}/api/me`, { headers: { cookie } });
    body = await res.json();
    check('/api/me avec session', body.user && body.user.pseudo === 'Barbe noire');

    res = await post('/api/login', { pseudo: 'barbe noire', pin: '0000' });
    check('mauvais code', res.status === 401);
    res = await post('/api/login', { pseudo: 'personne', pin: '0000' });
    check('pseudo inconnu', res.status === 404);
    res = await post('/api/login', { pseudo: 'Barbe Noire', pin: '1234' });
    check('connexion', res.status === 200 && cookieOf(res).startsWith('sk_session='));

    res = await post('/api/logout', {}, cookie);
    res = await fetch(`${base}/api/me`, { headers: { cookie } });
    body = await res.json();
    check('déconnexion : la session ne vaut plus', body.user === null);

    for (let i = 0; i < 5; i++) await post('/api/login', { pseudo: 'Barbe Noire', pin: '0000' });
    res = await post('/api/login', { pseudo: 'Barbe Noire', pin: '1234' });
    check('cinq codes faux : même le bon est refusé un moment', res.status === 429);

    // Le middleware Socket.io lit le même cookie.
    await post('/api/register', { pseudo: 'Anne', pin: '4321' }).then(async (r) => {
      const fakeSocket = { handshake: { headers: { cookie: cookieOf(r) } }, data: {} };
      await new Promise((done) => comptes.socketMiddleware(fakeSocket, done));
      check('socket reconnue', fakeSocket.data.user && fakeSocket.data.user.pseudo === 'Anne');
    });
    const anonSocket = { handshake: { headers: {} }, data: {} };
    await new Promise((done) => comptes.socketMiddleware(anonSocket, done));
    check('socket sans cookie : invitée', !anonSocket.data.user);
  } finally {
    server.close();
  }

  // --- Classement d'une fin de partie --------------------------------------
  {
    const writes = [];
    setComptesAdapter({
      isReservedPseudo: () => false,
      applyGameResult: async (game) => {
        writes.push(game);
        return {};
      },
    });
    const io = { sockets: { sockets: new Map() } };
    const room = {
      roundSequence: [1, 2, 3],
      players: [
        { id: 's1', nickname: 'Anne', userId: 1, elo: 1200, totalScore: 120 },
        { id: 's2', nickname: 'Jack', userId: 2, elo: 1200, totalScore: 40 },
        { id: 's3', nickname: 'Invité', userId: null, elo: null, totalScore: 200 },
      ],
    };
    const ranking = room.players.map((p) => ({ id: p.id, nickname: p.nickname, total: p.totalScore }));
    check('deux comptes : partie classée', rateGame(io, room, ranking) === true);
    const anne = ranking.find((r) => r.id === 's1');
    const invite = ranking.find((r) => r.id === 's3');
    check('le récap porte la cote', anne.elo && anne.elo.delta === 16 && anne.elo.after === 1216);
    check('l’invité n’a pas de cote', !invite.elo);
    check('la cote à table suit', room.players[0].elo === 1216);
    await new Promise((r) => setImmediate(r));
    check('écrit en base, sans l’invité', writes.length === 1 && writes[0].results.length === 2);
    check('le vainqueur de la table est l’invité : aucun compte ne gagne', writes[0].results.every((r) => !r.won));

    const seule = {
      roundSequence: [1],
      players: [
        { id: 'a', userId: 1, elo: 1200, totalScore: 10 },
        { id: 'b', userId: null, elo: null, totalScore: 0 },
      ],
    };
    check('un seul compte : non classée', rateGame(io, seule, []) === false);
    const parti = {
      roundSequence: [1],
      players: [
        { id: 'a', userId: 1, elo: 1200, totalScore: 10 },
        { id: 'b', userId: 2, elo: 1200, totalScore: 0, gone: true },
      ],
    };
    check('un compte parti ne compte pas', rateGame(io, parti, []) === false);
    setComptesAdapter(null);
  }

  // --- Pièces à code : sans limite, sans égard à la casse --------------
  {
    const store = createMemoryStore();
    const comptes = createComptes({ store });
    const a = await store.createUser('Alice', 'x');
    const b = await store.createUser('Bob', 'x');
    const r1 = await comptes.redeemCode(a.id, 'RoDi', '1.1.1.1');
    check('le code RODI, en casse mêlée, donne la pièce Apple', r1.piece === 'pomme');
    const r2 = await comptes.redeemCode(b.id, 'rodi', '2.2.2.2');
    check('le même code marche aussi pour un autre compte', r2.piece === 'pomme');
    const r3 = await comptes.redeemCode(a.id, 'RODI', '1.1.1.1');
    check('un compte qui a déjà la pièce le sait', !r3.piece && /déjà/.test(r3.error));
    check('chacun garde sa pièce', JSON.stringify(await store.piecesOf(a.id)) === '["pomme"]'
      && JSON.stringify(await store.piecesOf(b.id)) === '["pomme"]');
    check('POLZ donne la pieuvre', (await comptes.redeemCode(a.id, 'PolZ', '1.1.1.1')).piece === 'pieuvre');
    check('un code inconnu est refusé', !(await comptes.redeemCode(b.id, 'zzzz', '2.2.2.2')).piece);
    check('trois lettres ne font pas un code', /quatre/.test((await comptes.redeemCode(b.id, 'abc', '2.2.2.2')).error));
    check('un invité ne peut pas utiliser de code', !(await comptes.redeemCode(null, 'sput', '3.3.3.3')).piece);
    const codes = { sput: 'visa', belg: 'taureau', remz: 'viseur', toto: 'harvard', iqmm: 'surf' };
    for (const [code, piece] of Object.entries(codes)) {
      check(`le code ${code} donne ${piece}`, (await comptes.redeemCode(b.id, code.toUpperCase(), '2.2.2.2')).piece === piece);
    }
    // Le frein : huit essais faux d'affilée ferment le compte un moment.
    const c = await store.createUser('Chercheur', 'x');
    for (let i = 0; i < 8; i++) await comptes.redeemCode(c.id, 'qqq' + 'abcdefgh'[i], '4.4.4.4');
    check('les essais en série sont freinés', /Trop/.test((await comptes.redeemCode(c.id, 'qqqz', '4.4.4.4')).error));
  }

  // --- Pièces à code dans le salon --------------------------------------
  {
    const { giveFreePiece, PIECE_KEYS } = require('./skullking-room');
    check('les pièces à code sont dans le lot', ['pomme', 'visa', 'taureau', 'viseur', 'harvard', 'surf'].every((k) => PIECE_KEYS.includes(k)));
    check('sans doublon (la pieuvre y était déjà)', new Set(PIECE_KEYS).size === PIECE_KEYS.length);
    const hote = { id: 'h', piece: null, userId: 1, accountPseudo: 'Hote', ownedPieces: [] };
    giveFreePiece({ hostId: 'h', players: [hote] }, hote, 'pomme');
    check("l'hôte n'a pas une pièce à code qu'il n'a pas gagnée", hote.piece !== 'pomme');
    const gagnant = { id: 'g', piece: null, userId: 2, accountPseudo: 'G', ownedPieces: ['pomme'] };
    giveFreePiece({ hostId: 'h', players: [gagnant] }, gagnant, 'pomme');
    check('son propriétaire la retrouve', gagnant.piece === 'pomme');
    for (let i = 0; i < 40; i++) {
      const x = { id: 'x' + i, piece: null };
      giveFreePiece({ hostId: 'h', players: [x] }, x);
      if (['pieuvre', 'pomme', 'visa', 'taureau', 'viseur', 'harvard', 'surf'].includes(x.piece)) {
        check('le hasard ne donne jamais une pièce à code', false);
        break;
      }
    }
  }

  // --- Profil : courbe de la cote, némésis, sous-fifres, pièce -----------
  {
    const store = createMemoryStore();
    const comptes = createComptes({ store });
    const moi = await store.createUser('Moi', 'x');
    const anne = await store.createUser('Anne', 'x');
    const jack = await store.createUser('Jack', 'x');
    const zoe = await store.createUser('Zoé', 'x');
    const ligne = (u, total, before, after, extra = {}) => ({
      userId: u.id, nickname: u.pseudo, account: u.pseudo, total, left: false,
      elo: { before, after, delta: after - before }, ...extra,
    });
    const partie = (lignes) => store.applyGameResult({
      rounds: 1,
      results: lignes.filter((l) => l.userId).map((l) => ({ userId: l.userId, delta: l.elo.delta, won: false })),
      summary: lignes,
    });
    // 1. Anne me bat, je bats Jack.
    await partie([ligne(anne, 90, 1200, 1216), ligne(moi, 50, 1200, 1200), ligne(jack, 10, 1200, 1184)]);
    // 2. Jack me bat — résumé ancien, sans userId : retrouvé par le pseudo.
    await partie([
      { nickname: 'jack', account: 'JACK', total: 80, left: false, elo: { before: 1184, after: 1200, delta: 16 } },
      { nickname: 'Moi', account: 'Moi', total: 20, left: false, elo: { before: 1200, after: 1184, delta: -16 } },
      { nickname: 'Invité', account: null, total: 300, left: false, elo: null },
    ]);
    // 3. Je bats Zoé, qui a quitté la table, malgré son score.
    await partie([ligne(zoe, 500, 1200, 1180, { left: true }), ligne(moi, 10, 1184, 1204)]);
    // 4. Je bats encore Zoé.
    await partie([ligne(moi, 60, 1204, 1220), ligne(zoe, 30, 1180, 1164)]);
    // 5. Égalité avec Anne.
    await partie([ligne(moi, 40, 1220, 1220), ligne(anne, 40, 1216, 1216)]);

    const profil = await comptes.profilDe(await store.findUserById(moi.id));
    check('profil : la courbe part de la cote de départ', profil.courbe[0].elo === 1200 && profil.courbe[0].at === null);
    check('profil : un point par partie classée', profil.courbe.length === 6);
    check('profil : un invité n’est pas un adversaire', profil.adversaires.every((a) => a.pseudo !== 'Invité'));
    const contre = (nom) => profil.adversaires.find((a) => a.pseudo === nom);
    check('profil : contre Anne, une défaite et un nul', contre('Anne').defaites === 1 && contre('Anne').nuls === 1);
    check('profil : un vieux résumé retrouve son compte', contre('Jack').victoires === 1 && contre('Jack').defaites === 1);
    check('profil : qui quitte la table perd', contre('Zoé').victoires === 2 && contre('Zoé').defaites === 0);
    check('profil : deux némésis ex aequo', profil.nemesis.map((a) => a.pseudo).sort().join() === 'Anne,Jack');
    check('profil : le premier sous-fifre est Zoé', profil.sousFifres[0].pseudo === 'Zoé' && profil.sousFifres.length === 2);
    const zoeVue = await comptes.profilDe(await store.findUserById(zoe.id));
    check('profil : Zoé a pour némésis Moi', zoeVue.nemesis.length === 1 && zoeVue.nemesis[0].pseudo === 'Moi');
    check('profil : sans sous-fifre, la liste est vide', zoeVue.sousFifres.length === 0);
    const neuf = await store.createUser('Neuf', 'x');
    const vide = await comptes.profilDe(await store.findUserById(neuf.id));
    check('profil vierge : un seul point, à la cote de départ', vide.courbe.length === 1 && vide.courbe[0].elo === ELO_INITIAL);

    check('pièce commune choisie', (await comptes.choisirPiece(moi.id, 'canon')).piece === 'canon');
    check('la pièce paraît au classement', (await store.leaderboard(10)).find((u) => u.id === moi.id).piece === 'canon');
    check('jeton personnel non gagné refusé', Boolean((await comptes.choisirPiece(moi.id, 'pomme')).error));
    await comptes.redeemCode(moi.id, 'rodi', '9.9.9.9');
    check('jeton personnel gagné accepté', (await comptes.choisirPiece(moi.id, 'pomme')).piece === 'pomme');
    check('pièce inconnue refusée', Boolean((await comptes.choisirPiece(moi.id, 'licorne')).error));
    check('profil : la pièce de l’adversaire suit', (await comptes.profilDe(await store.findUserById(zoe.id))).nemesis[0].piece === 'pomme');
  }

  console.log(`\ncomptes-simulate.js : ${ok}/${ok + ko} assertions passées.`);
  if (ko) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
