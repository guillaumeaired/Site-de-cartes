// Arène des bots Skull King : fait jouer des milliers de parties entre bots,
// sans navigateur ni socket, et mesure chaque niveau (voir
// briefs/bots-skullking.md, § 3).
//
//   node server/skullking-arena.js --table 1,2,3,4 --parties 400
//   node server/skullking-arena.js --table 2,2,3,3 --extensions toutes --graine 7
//
// Rien n'y est réimplémenté : c'est la VRAIE salle (skullking-room.js) qui
// arbitre, avec ses pouvoirs, ses extensions et ses refus. Deux choses
// seulement sont remplacées :
//
// - l'horloge. Les pauses de pli, les minuteurs de pouvoir et la réflexion
//   des bots passent par setTimeout ; une horloge virtuelle les déclenche dans
//   l'ordre de leurs échéances, mais sans attendre — une partie de dix
//   manches dure une fraction de seconde au lieu d'un quart d'heure ;
// - le compteur de parties du hub, sinon chaque partie simulée y compterait.
//
// Toute erreur renvoyée par le serveur à un bot est un coup illégal, donc un
// bug de stratégie : elle est comptée et affichée.

const path = require('path');

// --- Horloge virtuelle -------------------------------------------------------

const file = [];
let maintenant = 0;
let numero = 0;

function inserer(t) {
  let bas = 0;
  let haut = file.length;
  while (bas < haut) {
    const mil = (bas + haut) >> 1;
    const m = file[mil];
    if (m.at < t.at || (m.at === t.at && m.id < t.id)) bas = mil + 1;
    else haut = mil;
  }
  file.splice(bas, 0, t);
}

global.setTimeout = (fn, ms, ...args) => {
  const t = {
    id: ++numero,
    at: maintenant + Math.max(0, Number(ms) || 0),
    fn,
    args,
    annule: false,
    unref() { return t; },
    ref() { return t; },
    hasRef() { return true; },
  };
  inserer(t);
  return t;
};
global.clearTimeout = (t) => {
  if (t && typeof t === 'object') t.annule = true;
};

// Déroule l'horloge jusqu'à ce que `fini()` soit vrai ou que plus rien ne
// soit programmé. Renvoie false si la file s'est vidée avant : la partie est
// bloquée (un bot n'a pas répondu).
function derouler(fini) {
  while (!fini()) {
    const t = file.shift();
    if (!t) return false;
    if (t.annule) continue;
    maintenant = t.at;
    t.fn(...t.args);
  }
  return true;
}

function viderHorloge() {
  for (const t of file) t.annule = true;
  file.length = 0;
}

// --- Hasard reproductible ----------------------------------------------------

function graineAleatoire(graine) {
  let a = graine >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Modules du jeu ----------------------------------------------------------

// Le compteur du hub écrit dans data/ : on le remplace avant que la salle ne
// le charge.
require.cache[require.resolve('./play-counts')] = {
  id: require.resolve('./play-counts'),
  filename: require.resolve('./play-counts'),
  loaded: true,
  exports: { recordGameStarted() {}, getPlayCounts() { return {}; } },
};

const salle = require('./skullking-room');
const bots = require('./skullking-bot');
const { NIVEAUX } = require('./skullking-bots');
const { EXTENSION_KEYS } = require('./skullking');

salle.setBotAdapter(bots);

// Le temps de décision de chaque niveau, mesuré au vrai chronomètre (R3 : un
// bot ne doit pas geler le serveur).
const chronos = new Map();
for (const strat of NIVEAUX) {
  const c = { n: 0, total: 0, max: 0 };
  chronos.set(strat.niveau, c);
  for (const methode of ['bid', 'play', 'power']) {
    const original = strat[methode];
    if (typeof original !== 'function' || original.__chronometre) continue;
    const mesure = function (...args) {
      const debut = process.hrtime.bigint();
      try {
        return original.apply(this, args);
      } finally {
        const ms = Number(process.hrtime.bigint() - debut) / 1e6;
        c.n += 1;
        c.total += ms;
        if (ms > c.max) c.max = ms;
      }
    };
    mesure.__chronometre = true;
    strat[methode] = mesure;
  }
}

// --- Une partie ----------------------------------------------------------------

// Les messages que la salle adresse aux joueurs : seul l'état de fin de partie
// nous intéresse, le reste part dans le vide.
function fauxIo(boite) {
  return {
    to(id) {
      return {
        emit(event, data) {
          if (event === 'skullking-state' && data && data.phase === 'game-end') boite.fin = data;
        },
      };
    },
  };
}

// Joue une partie complète. `niveaux` : le niveau de chaque siège, dans
// l'ordre (le premier est l'hôte). Renvoie, par siège, son niveau, son score
// et l'historique de ses manches.
function jouerPartie({ niveaux, manches = 10, extensions = [] }) {
  const boite = { fin: null, histoire: null, erreurs: [] };
  const io = fauxIo(boite);
  const register = salle.registerSkullKingHandlers;

  const hote = bots.makeBotSocket(io, register);
  bots.setBotLevel(hote.id, niveaux[0]);
  let code = null;
  hote.on('skullking-room-created', (d) => { code = d.code; });
  hote.on('skullking-history', (d) => { boite.histoire = d; });
  hote.emit('skullking-create-room', { nickname: 'Hôte', token: hote.id });
  if (!code) throw new Error('la salle n\'a pas été créée');

  for (const key of extensions) hote.emit('skullking-toggle-extension-module', { module: key });
  hote.emit('skullking-set-rounds', { totalRounds: manches });

  // Les bots s'assoient comme le ferait addBot — faux socket, puis le vrai
  // handler d'entrée — mais on garde la main sur leur socket pour écouter
  // les refus du serveur.
  const sieges = [{ id: hote.id, niveau: niveaux[0], socket: hote }];
  niveaux.slice(1).forEach((niveau, i) => {
    const socket = bots.makeBotSocket(io, register);
    bots.setBotLevel(socket.id, niveau);
    socket.emit('skullking-join-room', { code, nickname: `Bot ${i + 1}`, token: socket.id });
    sieges.push({ id: socket.id, niveau, socket });
  });
  for (const s of sieges) {
    s.socket.on('skullking-error', (message) => boite.erreurs.push({ niveau: s.niveau, message }));
  }

  hote.emit('skullking-start-game');
  const termine = derouler(() => boite.fin !== null);
  if (!termine) {
    const err = new Error('partie bloquée : plus rien de programmé avant la fin');
    nettoyer(sieges);
    throw err;
  }
  hote.emit('skullking-request-history');
  const histoire = boite.histoire || { rounds: [] };
  const totaux = new Map(boite.fin.finalRanking.map((r) => [r.id, r.total]));
  const resultat = sieges.map((s) => ({
    id: s.id,
    niveau: s.niveau,
    total: totaux.get(s.id),
    manches: histoire.rounds.map((r) => {
      const ligne = r.rows.find((x) => x.id === s.id);
      return { manche: r.round, cartes: r.cards, bid: ligne.bid, made: ligne.made, delta: ligne.delta };
    }),
  }));
  nettoyer(sieges);
  return { sieges: resultat, erreurs: boite.erreurs };
}

function nettoyer(sieges) {
  for (const s of sieges) if (s.socket) s.socket.emit('skullking-leave-room');
  for (const s of sieges) bots.removeBot(s.id);
  viderHorloge();
}

// --- Une série ------------------------------------------------------------------

function moyenneEtErreur(valeurs) {
  const n = valeurs.length;
  if (!n) return { moyenne: NaN, erreur: NaN };
  const moyenne = valeurs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? valeurs.reduce((a, v) => a + (v - moyenne) ** 2, 0) / (n - 1) : 0;
  return { moyenne, erreur: Math.sqrt(variance / n) };
}

// Joue `parties` parties en faisant tourner les sièges (chaque niveau passe
// par chaque place) et agrège par niveau.
function serie({ table, parties, manches = 10, extensions = [], surPartie } = {}) {
  const parNiveau = new Map();
  const ecarts = new Map(); // "a>b" -> différences par partie
  const erreurs = [];
  let bloquees = 0;
  for (let g = 0; g < parties; g++) {
    const k = g % table.length;
    const niveaux = [...table.slice(k), ...table.slice(0, k)];
    let partie;
    try {
      partie = jouerPartie({ niveaux, manches, extensions });
    } catch (e) {
      bloquees += 1;
      erreurs.push({ niveau: '?', message: e.message });
      continue;
    }
    erreurs.push(...partie.erreurs);
    if (surPartie) surPartie(partie);
    const meilleur = Math.max(...partie.sieges.map((s) => s.total));
    const gagnants = partie.sieges.filter((s) => s.total === meilleur).length;
    const moyennes = new Map();
    for (const s of partie.sieges) {
      if (!parNiveau.has(s.niveau)) parNiveau.set(s.niveau, { scores: [], victoires: 0, manches: 0, tenues: 0, ecart: 0 });
      const agg = parNiveau.get(s.niveau);
      agg.scores.push(s.total);
      if (s.total === meilleur) agg.victoires += 1 / gagnants;
      for (const m of s.manches) {
        agg.manches += 1;
        if (m.bid === m.made) agg.tenues += 1;
        agg.ecart += Math.abs(m.bid - m.made);
      }
      if (!moyennes.has(s.niveau)) moyennes.set(s.niveau, []);
      moyennes.get(s.niveau).push(s.total);
    }
    const presents = [...moyennes.keys()].sort((a, b) => a - b);
    const moy = (l) => l.reduce((a, b) => a + b, 0) / l.length;
    for (let i = 0; i < presents.length; i++) {
      for (let j = i + 1; j < presents.length; j++) {
        const cle = `${presents[j]}>${presents[i]}`;
        if (!ecarts.has(cle)) ecarts.set(cle, []);
        ecarts.get(cle).push(moy(moyennes.get(presents[j])) - moy(moyennes.get(presents[i])));
      }
    }
  }
  return { parNiveau, ecarts, erreurs, bloquees, parties };
}

function rapport(res) {
  const lignes = [];
  const noms = new Map(NIVEAUX.map((s) => [s.niveau, s.nom]));
  lignes.push('niveau          sièges  score moyen       victoires  annonces tenues  écart moyen  décision (moy / max)');
  for (const niveau of [...res.parNiveau.keys()].sort((a, b) => a - b)) {
    const a = res.parNiveau.get(niveau);
    const { moyenne, erreur } = moyenneEtErreur(a.scores);
    const c = chronos.get(niveau);
    const decision = c && c.n ? `${(c.total / c.n).toFixed(2)} / ${c.max.toFixed(1)} ms` : '-';
    lignes.push(
      `${`${niveau} ${noms.get(niveau) || ''}`.padEnd(16)}${String(a.scores.length).padStart(6)}  `
      + `${moyenne.toFixed(1).padStart(7)} ± ${erreur.toFixed(1).padEnd(6)}  `
      + `${((100 * a.victoires) / a.scores.length).toFixed(1).padStart(7)} %  `
      + `${((100 * a.tenues) / a.manches).toFixed(1).padStart(13)} %  `
      + `${(a.ecart / a.manches).toFixed(2).padStart(11)}  ${decision}`
    );
  }
  if (res.ecarts.size) {
    lignes.push('');
    lignes.push('écart de score par partie (niveau fort − niveau faible, mêmes tables) :');
    for (const [cle, liste] of res.ecarts) {
      const { moyenne, erreur } = moyenneEtErreur(liste);
      const z = erreur > 0 ? moyenne / erreur : 0;
      const verdict = z >= 2 ? 'net' : z <= -2 ? 'INVERSÉ' : 'pas significatif';
      lignes.push(`  ${cle.replace('>', ' contre ')} : ${moyenne >= 0 ? '+' : ''}${moyenne.toFixed(1)} ± ${erreur.toFixed(1)} (${verdict})`);
    }
  }
  lignes.push('');
  lignes.push(`${res.parties} parties, ${res.bloquees} bloquée(s), ${res.erreurs.length} coup(s) refusé(s) par le serveur.`);
  const exemples = new Map();
  for (const e of res.erreurs) {
    const cle = `${e.niveau} : ${e.message}`;
    exemples.set(cle, (exemples.get(cle) || 0) + 1);
  }
  for (const [cle, n] of [...exemples].slice(0, 10)) lignes.push(`  niveau ${cle} (×${n})`);
  return lignes.join('\n');
}

// --- Ligne de commande --------------------------------------------------------

function lireOptions(argv) {
  const o = { table: [1, 1, 1, 1], parties: 100, manches: 10, extensions: [], graine: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--table') { o.table = v.split(',').map(Number); i++; }
    else if (a === '--parties') { o.parties = Number(v); i++; }
    else if (a === '--manches') { o.manches = Number(v); i++; }
    else if (a === '--graine') { o.graine = Number(v); i++; }
    else if (a === '--extensions') {
      o.extensions = v === 'toutes' ? [...EXTENSION_KEYS] : v === 'aucune' ? [] : v.split(',');
      i++;
    } else if (a === '--aide' || a === '-h') {
      console.log(`usage : node ${path.relative(process.cwd(), __filename)} --table 1,2,3,4 --parties 400 [--manches 10] [--extensions aucune|toutes|clé,clé] [--graine 42]`);
      process.exit(0);
    }
  }
  return o;
}

if (require.main === module) {
  const o = lireOptions(process.argv.slice(2));
  if (o.graine !== null) graineAleatoire(o.graine);
  const debut = Date.now();
  const res = serie(o);
  console.log(rapport(res));
  console.log(`(${((Date.now() - debut) / 1000).toFixed(1)} s)`);
  process.exitCode = res.erreurs.length || res.bloquees ? 1 : 0;
}

module.exports = { jouerPartie, serie, rapport, graineAleatoire, moyenneEtErreur };
