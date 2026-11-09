// Les comptes du Skull King : un pseudo, un code à quatre chiffres, une cote
// Elo. Tout ce qui touche à l'identité vit ici — le stockage, le hachage du
// code, la session par cookie, les routes /api/* et le middleware Socket.io
// qui dit aux salons qui est connecté. Les salons, eux, ne voient qu'un
// `socket.data.user` ({ id, pseudo, elo }) ou rien du tout pour un invité.
//
// Deux stockages derrière la même interface :
//   - Postgres (Neon en production) dès que DATABASE_URL est posé ;
//   - la mémoire sinon : en local et dans les tests, pour que `npm start` et
//     `npm test` marchent sans base. Tout y est perdu au redémarrage, ce qui
//     est annoncé au lancement.
//
// Un code à quatre chiffres ne fait que 10 000 possibilités : il ne tient que
// parce que les essais sont freinés (voir LoginLimiter). Il protège une cote
// de jeu entre amis, rien de plus — c'est le choix assumé de la simplicité.

const crypto = require('crypto');
const { promisify } = require('util');
const { sanitizeNickname } = require('./commun');
const { ELO_INITIAL } = require('./elo');

const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = 'sk_session';
const SESSION_DAYS = 180;
const PIN_RE = /^\d{4}$/;

// --- Pseudo et code -------------------------------------------------------

// La clé d'unicité : « Barbe Noire », « barbe noire » et « BARBE  NOIRE » sont
// le même pirate. Le pseudo affiché garde la casse choisie à l'inscription.
function pseudoKey(pseudo) {
  return String(pseudo).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanPseudo(raw) {
  const pseudo = sanitizeNickname(raw);
  if (!pseudo || pseudo.length < 2) return null;
  return pseudo.replace(/\s+/g, ' ');
}

async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPin(pin, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expectedHash = Buffer.from(hashHex, 'hex');
  const hash = await scrypt(pin, Buffer.from(saltHex, 'hex'), expectedHash.length);
  return crypto.timingSafeEqual(hash, expectedHash);
}

// Le cookie porte le jeton en clair, la base n'en garde que l'empreinte : une
// fuite de la table des sessions ne donne accès à aucun compte.
function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, pseudo: u.pseudo, elo: u.elo, gamesPlayed: u.gamesPlayed, wins: u.wins };
}

// --- Stockage en mémoire --------------------------------------------------

function createMemoryStore() {
  const users = new Map(); // id -> user
  const byKey = new Map(); // pseudoKey -> id
  const sessions = new Map(); // tokenHash -> { userId, expiresAt }
  const games = [];
  let nextId = 1;

  return {
    kind: 'memory',
    async init() {},
    async createUser(pseudo, pinHash) {
      const key = pseudoKey(pseudo);
      if (byKey.has(key)) return null;
      const user = { id: nextId++, pseudo, pinHash, elo: ELO_INITIAL, gamesPlayed: 0, wins: 0 };
      users.set(user.id, user);
      byKey.set(key, user.id);
      return { ...user };
    },
    async findUserByPseudo(pseudo) {
      const id = byKey.get(pseudoKey(pseudo));
      return id ? { ...users.get(id) } : null;
    },
    async findUserById(id) {
      const u = users.get(id);
      return u ? { ...u } : null;
    },
    async allPseudoKeys() {
      return [...byKey.keys()];
    },
    async createSession(hash, userId, expiresAt) {
      sessions.set(hash, { userId, expiresAt });
    },
    async findSessionUser(hash) {
      const s = sessions.get(hash);
      if (!s) return null;
      if (s.expiresAt < Date.now()) {
        sessions.delete(hash);
        return null;
      }
      return this.findUserById(s.userId);
    },
    async deleteSession(hash) {
      sessions.delete(hash);
    },
    // results : [{ userId, delta, won }] - renvoie { userId: nouvelleCote }
    async applyGameResult({ rounds, results, summary }) {
      const after = {};
      for (const r of results) {
        const u = users.get(r.userId);
        if (!u) continue;
        u.elo += r.delta;
        u.gamesPlayed += 1;
        if (r.won) u.wins += 1;
        after[r.userId] = u.elo;
      }
      games.push({ playedAt: Date.now(), rounds, results: summary });
      return after;
    },
    async leaderboard(limit) {
      return [...users.values()]
        .filter((u) => u.gamesPlayed > 0)
        .sort((a, b) => b.elo - a.elo || b.gamesPlayed - a.gamesPlayed)
        .slice(0, limit)
        .map(publicUser);
    },
  };
}

// --- Stockage Postgres (Neon) ---------------------------------------------

// `PoolImpl` ne sert qu'à éprouver ce stockage contre une base factice.
function createPgStore(connectionString, PoolImpl = require('pg').Pool) {
  const pool = new PoolImpl({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  // Neon coupe les connexions inactives : une erreur sur un client au repos
  // ne doit pas faire tomber le serveur (voir crashSafely dans index.js).
  pool.on('error', (err) => console.error('[comptes] connexion Postgres perdue', err.message));

  const row = (r) =>
    r && {
      id: r.id,
      pseudo: r.pseudo,
      pinHash: r.pin_hash,
      elo: r.elo,
      gamesPlayed: r.games_played,
      wins: r.wins,
    };

  return {
    kind: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sk_users (
          id SERIAL PRIMARY KEY,
          pseudo TEXT NOT NULL,
          pseudo_key TEXT NOT NULL UNIQUE,
          pin_hash TEXT NOT NULL,
          elo INTEGER NOT NULL DEFAULT ${ELO_INITIAL},
          games_played INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS sk_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES sk_users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sk_games (
          id SERIAL PRIMARY KEY,
          played_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          rounds INTEGER NOT NULL,
          results JSONB NOT NULL
        );
      `);
      await pool.query('DELETE FROM sk_sessions WHERE expires_at < now()');
    },
    async createUser(pseudo, pinHash) {
      try {
        const { rows } = await pool.query(
          'INSERT INTO sk_users (pseudo, pseudo_key, pin_hash) VALUES ($1, $2, $3) RETURNING *',
          [pseudo, pseudoKey(pseudo), pinHash],
        );
        return row(rows[0]);
      } catch (err) {
        // 23505 : violation d'unicité — le pseudo est déjà pris.
        if (err && err.code === '23505') return null;
        throw err;
      }
    },
    async findUserByPseudo(pseudo) {
      const { rows } = await pool.query('SELECT * FROM sk_users WHERE pseudo_key = $1', [pseudoKey(pseudo)]);
      return row(rows[0]) || null;
    },
    async findUserById(id) {
      const { rows } = await pool.query('SELECT * FROM sk_users WHERE id = $1', [id]);
      return row(rows[0]) || null;
    },
    async allPseudoKeys() {
      const { rows } = await pool.query('SELECT pseudo_key FROM sk_users');
      return rows.map((r) => r.pseudo_key);
    },
    async createSession(hash, userId, expiresAt) {
      await pool.query('INSERT INTO sk_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
        hash,
        userId,
        new Date(expiresAt),
      ]);
    },
    async findSessionUser(hash) {
      const { rows } = await pool.query(
        `SELECT u.* FROM sk_sessions s JOIN sk_users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hash],
      );
      return row(rows[0]) || null;
    },
    async deleteSession(hash) {
      await pool.query('DELETE FROM sk_sessions WHERE token_hash = $1', [hash]);
    },
    // Une seule transaction : une partie compte pour tout le monde ou pour
    // personne. On ajoute le delta à la cote du moment plutôt que d'écrire la
    // cote calculée : deux parties finies en même temps ne s'écrasent pas.
    async applyGameResult({ rounds, results, summary }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const after = {};
        for (const r of results) {
          const { rows } = await client.query(
            `UPDATE sk_users SET elo = elo + $2, games_played = games_played + 1, wins = wins + $3
             WHERE id = $1 RETURNING elo`,
            [r.userId, r.delta, r.won ? 1 : 0],
          );
          if (rows[0]) after[r.userId] = rows[0].elo;
        }
        await client.query('INSERT INTO sk_games (rounds, results) VALUES ($1, $2)', [rounds, JSON.stringify(summary)]);
        await client.query('COMMIT');
        return after;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async leaderboard(limit) {
      const { rows } = await pool.query(
        'SELECT * FROM sk_users WHERE games_played > 0 ORDER BY elo DESC, games_played DESC LIMIT $1',
        [limit],
      );
      return rows.map(row).map(publicUser);
    },
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return createPgStore(process.env.DATABASE_URL);
  return createMemoryStore();
}

// --- Freins contre les essais en série ------------------------------------

// Cinq codes faux d'affilée sur un pseudo le ferment un quart d'heure, et une
// même adresse ne peut pas en tenter plus de trente par heure, tous pseudos
// confondus. 10 000 codes à ce rythme, c'est des semaines d'essais : assez
// pour une cote de jeu.
class LoginLimiter {
  constructor({ perPseudo = 5, pseudoWindowMs = 15 * 60_000, perIp = 30, ipWindowMs = 60 * 60_000 } = {}) {
    Object.assign(this, { perPseudo, pseudoWindowMs, perIp, ipWindowMs });
    this.pseudos = new Map();
    this.ips = new Map();
  }
  _recent(map, key, windowMs, now) {
    const list = (map.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) map.set(key, list);
    else map.delete(key);
    return list;
  }
  // Renvoie le nombre de minutes à attendre, ou 0 si l'essai est permis.
  blockedFor(pseudo, ip, now = Date.now()) {
    // pseudo à null : seul le frein par adresse compte (inscription).
    const p = pseudo == null ? [] : this._recent(this.pseudos, pseudoKey(pseudo), this.pseudoWindowMs, now);
    const i = this._recent(this.ips, ip, this.ipWindowMs, now);
    let until = 0;
    if (p.length >= this.perPseudo) until = Math.max(until, p[p.length - this.perPseudo] + this.pseudoWindowMs);
    if (i.length >= this.perIp) until = Math.max(until, i[i.length - this.perIp] + this.ipWindowMs);
    return until > now ? Math.ceil((until - now) / 60_000) : 0;
  }
  fail(pseudo, ip, now = Date.now()) {
    if (pseudo != null) {
      const key = pseudoKey(pseudo);
      this.pseudos.set(key, [...this._recent(this.pseudos, key, this.pseudoWindowMs, now), now]);
    }
    this.ips.set(ip, [...this._recent(this.ips, ip, this.ipWindowMs, now), now]);
  }
  succeed(pseudo) {
    this.pseudos.delete(pseudoKey(pseudo));
  }
}

// --- Cookies ---------------------------------------------------------------

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sessionCookie(token, secure, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// --- Le service : routes HTTP, middleware Socket.io, pseudos réservés -------

function createComptes({ store = createStore(), limiter = new LoginLimiter(), site = null } = {}) {
  // Les pseudos qui ont un compte, gardés en mémoire : un invité ne doit pas
  // pouvoir s'asseoir sous le nom d'un joueur classé, et cette vérification
  // se fait dans les gestionnaires de salon, qui sont synchrones.
  const reserved = new Set();

  async function init() {
    await store.init();
    for (const key of await store.allPseudoKeys()) reserved.add(key);
  }

  function isReservedPseudo(nickname) {
    return reserved.has(pseudoKey(nickname));
  }

  async function openSession(res, req, user) {
    const token = newSessionToken();
    const expiresAt = Date.now() + SESSION_DAYS * 86_400_000;
    await store.createSession(tokenHash(token), user.id, expiresAt);
    res.setHeader('Set-Cookie', sessionCookie(token, req.secure, SESSION_DAYS * 86_400));
  }

  async function userFromCookieHeader(header) {
    const token = readCookie(header, SESSION_COOKIE);
    if (!token) return null;
    return store.findSessionUser(tokenHash(token));
  }

  function registerRoutes(app, express) {
    const json = express.json({ limit: '2kb' });
    const wrap = (fn) => (req, res) =>
      fn(req, res).catch((err) => {
        console.error('[comptes]', req.path, err);
        res.status(500).json({ error: 'Le serveur n’a pas pu répondre, réessaie dans un instant.' });
      });

    app.get(
      '/api/me',
      wrap(async (req, res) => {
        const user = await userFromCookieHeader(req.headers.cookie);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ user: publicUser(user), site });
      }),
    );

    app.post(
      '/api/register',
      json,
      wrap(async (req, res) => {
        const pseudo = cleanPseudo(req.body && req.body.pseudo);
        const pin = String((req.body && req.body.pin) || '');
        if (!pseudo) return res.status(400).json({ error: 'Choisis un pseudo d’au moins 2 caractères.' });
        if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'Le code doit faire exactement 4 chiffres.' });
        // L'inscription passe par le même frein que la connexion, compté par
        // adresse : sans lui, on remplirait la base de comptes à la chaîne.
        const wait = limiter.blockedFor(null, req.ip);
        if (wait) return res.status(429).json({ error: `Trop d’essais, réessaie dans ${wait} min.` });
        const user = await store.createUser(pseudo, await hashPin(pin));
        if (!user) {
          limiter.fail(null, req.ip);
          return res.status(409).json({ error: 'Ce pseudo a déjà un compte. Connecte-toi, ou choisis-en un autre.' });
        }
        reserved.add(pseudoKey(user.pseudo));
        // Une inscription réussie compte aussi : trente comptes à l'heure par
        // adresse, c'est large pour une soirée et court pour un robot.
        limiter.fail(null, req.ip);
        await openSession(res, req, user);
        res.status(201).json({ user: publicUser(user) });
      }),
    );

    app.post(
      '/api/login',
      json,
      wrap(async (req, res) => {
        const pseudo = cleanPseudo(req.body && req.body.pseudo);
        const pin = String((req.body && req.body.pin) || '');
        if (!pseudo || !PIN_RE.test(pin)) {
          return res.status(400).json({ error: 'Entre ton pseudo et ton code à 4 chiffres.' });
        }
        const wait = limiter.blockedFor(pseudo, req.ip);
        if (wait) return res.status(429).json({ error: `Trop de codes faux, réessaie dans ${wait} min.` });
        const user = await store.findUserByPseudo(pseudo);
        if (!user) return res.status(404).json({ error: 'Aucun compte à ce pseudo. Crée-le !' });
        if (!(await verifyPin(pin, user.pinHash))) {
          limiter.fail(pseudo, req.ip);
          return res.status(401).json({ error: 'Code incorrect.' });
        }
        limiter.succeed(pseudo);
        await openSession(res, req, user);
        res.json({ user: publicUser(user) });
      }),
    );

    app.post(
      '/api/logout',
      wrap(async (req, res) => {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        if (token) await store.deleteSession(tokenHash(token));
        res.setHeader('Set-Cookie', sessionCookie(null, req.secure, 0));
        res.json({ ok: true });
      }),
    );

    app.get(
      '/api/leaderboard',
      wrap(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ players: await store.leaderboard(100) });
      }),
    );
  }

  // Chaque socket sait à sa connexion qui est derrière. Une base injoignable
  // ne bloque pas la connexion : on joue alors en invité, plutôt que pas du
  // tout.
  function socketMiddleware(socket, next) {
    userFromCookieHeader(socket.handshake.headers.cookie)
      .then((user) => {
        if (user) socket.data.user = { id: user.id, pseudo: user.pseudo, elo: user.elo };
      })
      .catch((err) => console.error('[comptes] session illisible', err.message))
      .finally(() => next());
  }

  return {
    store,
    init,
    isReservedPseudo,
    registerRoutes,
    socketMiddleware,
    applyGameResult: (game) => store.applyGameResult(game),
  };
}

module.exports = {
  createComptes,
  createMemoryStore,
  createPgStore,
  LoginLimiter,
  hashPin,
  verifyPin,
  pseudoKey,
  cleanPseudo,
  readCookie,
};
