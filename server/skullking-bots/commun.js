// Outils partagés par les stratégies de bots Skull King (voir
// briefs/bots-skullking.md). Tout ici travaille sur la VUE d'un joueur —
// `stateFor(room, bot)`, exactement ce que recevrait le client d'un humain
// assis à sa place — et sur ce que le bot en a retenu d'un état à l'autre.
// Jamais sur la salle elle-même : un bot ne lit pas la main des autres.

const { createDeck, ledSuitOf, isCardPlayable, resolveTrick, effectiveKind } = require('../skullking');

// --- Ce que le bot peut poser ---------------------------------------------

// Les cartes que le serveur accepterait, dans l'ordre de la main. Mary Thorne
// prime sur tout : la carte imposée est alors la seule jouable.
function cartesJouables(state) {
  const main = state.hand || [];
  const pli = state.currentTrick || [];
  if (state.forcedCardId) {
    const imposee = main.find((c) => c.id === state.forcedCardId);
    if (imposee) return [imposee];
  }
  const jouables = main.filter((c) => isCardPlayable(c, main, pli));
  return jouables.length ? jouables : main.slice(0, 1);
}

// Toutes les façons de poser une carte : la Tigresse et le 0/14 se déclarent
// à la pose, ce sont donc deux coups différents pour la même carte. Chaque
// variante porte le payload attendu par `skullking-play-card` et la carte
// telle qu'elle tombera sur le tapis — c'est cette dernière qu'on donne au
// moteur pour savoir si elle gagne.
function variantesDePose(carte, pli) {
  if (carte.kind === 'tigress') {
    return ['pirate', 'escape'].map((chosenAs) => ({
      payload: { cardId: carte.id, chosenAs },
      posee: { ...carte, chosenAs },
    }));
  }
  if (carte.kind === 'number' && carte.wild14 && carte.value == null) {
    return [14, 0].map((declaredValue) => ({
      payload: { cardId: carte.id, declaredValue },
      posee: { ...carte, value: declaredValue },
    }));
  }
  if (carte.kind === 'wild15') {
    // Le serveur impose la couleur demandée si c'est une couleur ordinaire,
    // et laisse le Joker sans couleur face au noir : seul le cas « rien
    // d'imposé » demande un choix, et chaque couleur est alors un coup.
    const demandee = ledSuitOf(pli);
    if (demandee === null) {
      return ['vert', 'jaune', 'violet'].map((chosenSuit) => ({
        payload: { cardId: carte.id, chosenSuit },
        posee: { ...carte, kind: 'number', suit: chosenSuit, value: 15, wild15: true },
      }));
    }
    const suit = demandee === 'noir' ? undefined : demandee;
    return [{ payload: { cardId: carte.id }, posee: { ...carte, kind: 'number', suit, value: 15, wild15: true } }];
  }
  return [{ payload: { cardId: carte.id }, posee: carte }];
}

function coupsLegaux(state) {
  const pli = state.currentTrick || [];
  return cartesJouables(state).flatMap((c) => variantesDePose(c, pli));
}

// --- Qui gagne ---------------------------------------------------------------

// Le pli tel qu'il serait si l'on y ajoutait ces cartes, résolu par le vrai
// moteur : true si la carte d'indice `monIdx` le remporte.
function gagnerait(cartes, monIdx) {
  const r = resolveTrick(cartes);
  return !r.destroyed && r.winnerIdx === monIdx;
}

// Les joueurs qui poseront encore une carte après moi dans ce pli, dans
// l'ordre. Le pli part du meneur et suit l'ordre des sièges : ceux qui
// viennent après moi sont exactement ceux qui n'ont pas encore posé. Une main
// vide veut dire qu'on passe ce pli (Dernière Salve) ; la carte de rab de la
// Salve, elle, est trop rare pour compliquer l'estimation.
function suivants(state) {
  const ordre = state.players;
  const pli = state.currentTrick || [];
  const ont = new Set(pli.map((t) => t.playerId));
  const i = ordre.findIndex((p) => p.id === state.myId);
  const liste = [];
  for (let k = 1; k < ordre.length; k++) {
    const p = ordre[(i + k) % ordre.length];
    if (!ont.has(p.id) && p.handCount > 0) liste.push(p);
  }
  return liste;
}

function joueursApresMoi(state) {
  return suivants(state).length;
}

// --- Le contrat ---------------------------------------------------------------

function moi(state) {
  return state.players.find((p) => p.id === state.myId);
}

// Plis encore à jouer dans la manche, celui en cours compris.
function plisRestants(state) {
  return Math.max(0, state.cardsInRound - (state.trickNumber || 1) + 1);
}

// Combien de plis il me manque pour tenir mon annonce (négatif : j'en ai trop).
function plisManquants(state) {
  const bid = state.myBid == null ? 0 : state.myBid;
  return bid - (moi(state).tricksWon || 0);
}

// --- Rang d'une carte ---------------------------------------------------------

// Une échelle grossière de « valeur » d'une carte, pour départager deux coups
// équivalents : qui garder pour plus tard, de quoi se débarrasser. Ce n'est
// PAS la hiérarchie du pli (elle n'est pas transitive) — le moteur s'en
// charge ; ceci dit seulement ce qu'il coûte de lâcher une carte.
function rang(carte) {
  const k = effectiveKind(carte);
  switch (k) {
    case 'escape': return 0;
    case 'loot': return 0.5;
    case 'lastvolley':
    case 'plank':
    case 'davyjones': return 1;
    case 'kraken': return 2;
    case 'whale':
    case 'stingray': return 2.5;
    case 'siren': return 27;
    case 'firstmate': return 29;
    case 'pirate': return 30;
    case 'skullking': return 34;
    case 'number': {
      const v = carte.value == null ? 14 : carte.value;
      return 3 + v + (carte.suit === 'noir' ? 10 : 0);
    }
    default: return 1;
  }
}

// --- Mémoire de manche --------------------------------------------------------
//
// `stateFor` ne montre que le pli en cours. Mais `driveBots` est appelé à
// chaque diffusion d'état, donc après chaque carte posée : en retenant ce qui
// passe, le bot sait tout ce qu'un joueur attentif saurait.

function nouvelleMemoire() {
  // horsJeu : des cartes dont le bot sait qu'elles ne sont dans AUCUNE main
  // (le reliquat que Juanita Jade lui a montré, ce que Will le Bandit y a
  // remis).
  return { manche: null, vues: new Map(), coupes: new Map(), horsJeu: new Set() };
}

function observer(memoire, state) {
  if (!state || state.roundNumber == null) return;
  const enManche = state.phase === 'bidding' || state.phase === 'playing' || state.phase === 'power';
  if (!enManche) return;
  // Une nouvelle manche se reconnaît à son numéro ; une revanche repart à 1,
  // mais elle repasse d'abord par une phase sans manche, d'où le second test.
  const cle = `${state.roundNumber}/${state.totalRounds}`;
  if (memoire.manche !== cle || (state.phase === 'bidding' && memoire.dernierePhase !== 'bidding')) {
    memoire.manche = cle;
    memoire.vues = new Map();
    memoire.coupes = new Map();
    memoire.horsJeu = new Set();
  }
  const pouvoir = state.pendingPower;
  if (pouvoir && pouvoir.mine && pouvoir.revealCards) {
    for (const c of pouvoir.revealCards) memoire.horsJeu.add(c.id);
  }
  memoire.dernierePhase = state.phase;
  const pli = state.currentTrick || [];
  pli.forEach((t, i) => {
    if (memoire.vues.has(t.card.id)) return;
    memoire.vues.set(t.card.id, { ...t.card, playerId: t.playerId });
    // Une numérotée d'une autre couleur que celle demandée prouve que son
    // poseur n'en a plus. Une carte spéciale ne prouve rien (toujours
    // jouable), le Joker non plus (il prend la couleur qu'on lui donne).
    const demandee = ledSuitOf(pli.slice(0, i));
    if (demandee !== null && t.card.kind === 'number' && !t.card.wild15 && t.card.suit !== demandee) {
      if (!memoire.coupes.has(t.playerId)) memoire.coupes.set(t.playerId, new Set());
      memoire.coupes.get(t.playerId).add(demandee);
    }
  });
}

function aCoupe(memoire, playerId, suit) {
  const s = memoire && memoire.coupes.get(playerId);
  return Boolean(s && s.has(suit));
}

// Les cartes dont le bot ignore où elles sont : le paquet de la partie
// (les identifiants sont déterministes, voir createDeck), moins sa main, moins
// ce qu'il a vu tomber. Elles sont dans les mains adverses ou dans le
// reliquat, sans qu'il sache lesquelles.
//
// `avecMemoire` à false : un joueur distrait qui ne se souvient que du pli
// sous ses yeux.
function cartesInconnues(state, memoire, avecMemoire = true) {
  const connues = new Set((state.hand || []).map((c) => c.id));
  for (const t of state.currentTrick || []) connues.add(t.card.id);
  if (avecMemoire && memoire) {
    for (const id of memoire.vues.keys()) connues.add(id);
    for (const id of memoire.horsJeu) connues.add(id);
  }
  return createDeck(state.extensions).filter((c) => !connues.has(c.id));
}


// --- Chance de remporter le pli --------------------------------------------
//
// La probabilité que `posee`, ajoutée maintenant au pli, le remporte. Le vrai
// moteur dit, pour chaque carte inconnue, si elle me battrait en tombant
// après moi ; on en déduit, joueur suivant par joueur suivant, la chance
// qu'il en tienne une (tirage sans remise dans les cartes inconnues) et qu'il
// la pose.
//
// Options :
// - avecMemoire : le bot se souvient des plis précédents de la manche (les
//   cartes tombées ne sont plus inconnues) et des coupes observées ;
// - intentions : il lit les annonces — un joueur qui a déjà son compte évite
//   de prendre le pli, celui à qui il manque des plis le prend s'il peut.

// Une carte inconnue telle qu'un adversaire la poserait pour me battre : la
// Tigresse en Pirate, le 0/14 à 14, le Joker dans la couleur demandée.
function commeAdversaire(c, demandee, repli) {
  if (c.kind === 'tigress') return { ...c, chosenAs: 'pirate' };
  if (c.kind === 'number' && c.wild14 && c.value == null) return { ...c, value: 14 };
  if (c.kind === 'wild15') {
    const suit = demandee === null ? repli : demandee === 'noir' ? undefined : demandee;
    return { ...c, kind: 'number', suit, value: 15, wild15: true };
  }
  return c;
}

// P(aucune des `b` cartes visées parmi `u` inconnues dans une main de `h`).
function aucuneParmi(u, b, h) {
  if (b <= 0) return 1;
  let p = 1;
  for (let k = 0; k < h; k++) {
    const reste = u - k;
    if (reste <= 0) return 0;
    p *= Math.max(0, (reste - b) / reste);
  }
  return p;
}

function chanceDeGain(state, memoire, posee, { avecMemoire = true, intentions = true } = {}) {
  const pli = (state.currentTrick || []).map((t) => t.card);
  const cartes = [...pli, posee];
  const monIdx = cartes.length - 1;
  if (!gagnerait(cartes, monIdx)) return 0;
  const apres = suivants(state);
  if (!apres.length) return 1;

  const inconnues = cartesInconnues(state, memoire, avecMemoire);
  const u = inconnues.length;
  if (!u) return 1;
  const demandee = ledSuitOf(state.currentTrick ? [...state.currentTrick, { card: posee }] : [{ card: posee }]);
  const repli = posee.kind === 'number' && posee.suit ? posee.suit : 'vert';

  // Les cartes qui me battraient, rangées selon qui peut les poser :
  // toujours (cartes spéciales, ou rien n'est encore demandé), dans la
  // couleur demandée, ou hors couleur (seulement pour qui n'en a plus).
  let toujours = 0;
  let horsCouleur = 0;
  let dansLaCouleur = 0;
  let cartesDeLaCouleur = 0;
  for (const c of inconnues) {
    const estNumerotee = c.kind === 'number';
    if (estNumerotee && demandee !== null && c.suit === demandee) cartesDeLaCouleur += 1;
    if (gagnerait([...cartes, commeAdversaire(c, demandee, repli)], monIdx)) continue;
    if (!estNumerotee || demandee === null) toujours += 1;
    else if (c.suit === demandee) dansLaCouleur += 1;
    else horsCouleur += 1;
  }

  let survie = 1;
  for (const j of apres) {
    const h = j.handCount;
    let sansCouleur = 1;
    if (demandee !== null) {
      sansCouleur = avecMemoire && aCoupe(memoire, j.id, demandee) ? 1 : aucuneParmi(u, cartesDeLaCouleur, h);
    }
    const menaces = toujours + dansLaCouleur + horsCouleur * sansCouleur;
    const tient = 1 - aucuneParmi(u, menaces, h);
    let envie = 0.85;
    if (intentions && j.bid != null) envie = (j.bid - (j.tricksWon || 0)) > 0 ? 0.95 : 0.35;
    survie *= 1 - envie * tient;
  }
  return survie;
}

// --- Force d'une carte à l'annonce -------------------------------------------

// Ce qu'une carte rapporte de plis, en moyenne, sans rien savoir de la donne :
// la table de force de la spec (§ 4.2). Les numérotées perdent de leur
// force quand la table s'agrandit — plus de joueurs, plus de chances qu'un
// atout ou une carte spéciale passe derrière.
function forceStatique(carte, nbJoueurs) {
  const facteur = Math.max(0.6, Math.min(1.1, 1.25 - 0.08 * nbJoueurs));
  switch (carte.kind) {
    case 'skullking': return 0.9;
    case 'pirate': return 0.75;
    case 'tigress': return 0.7;
    case 'firstmate': return 0.6;
    case 'siren': return 0.5;
    case 'wild15': return 0.5;
    case 'number': {
      const v = carte.value == null ? 14 : carte.value;
      if (carte.suit === 'noir') {
        const base = v >= 12 ? 0.8 : v >= 9 ? 0.5 : v >= 5 ? 0.25 : 0.1;
        return base * facteur;
      }
      const base = v >= 14 ? 0.55 : v >= 13 ? 0.45 : v >= 12 ? 0.3 : v >= 10 ? 0.15 : 0.03;
      return base * facteur * (carte.wild14 ? 0.8 : 1);
    }
    default: return 0;
  }
}

// --- L'annonce qui rapporte le plus -------------------------------------------
//
// Annoncer l'espérance arrondie n'est pas annoncer ce qui rapporte : un 0
// tenu en manche 9 vaut 90 points, un 1 tenu en vaut 20. On reconstruit la
// loi du nombre de plis (chaque carte gagne ou non, indépendamment, avec sa
// probabilité), on tient compte de ce que le joueur RATTRAPE en jouant —
// d'un pli de trop ou de moins, il peut souvent revenir à son annonce — et
// on garde l'annonce au meilleur gain espéré.

function loiDesPlis(ps) {
  let loi = [1];
  for (const p of ps) {
    const suivante = new Array(loi.length + 1).fill(0);
    loi.forEach((q, k) => {
      suivante[k] += q * (1 - p);
      suivante[k + 1] += q * p;
    });
    loi = suivante;
  }
  return loi;
}

function meilleureAnnonce(ps, cartesInRound, numeroManche, { rattrapage = 0.5 } = {}) {
  const loi = loiDesPlis(ps);
  const d = (k) => (k >= 0 && k < loi.length ? loi[k] : 0);
  let meilleure = 0;
  let meilleurGain = -Infinity;
  for (let b = 0; b <= cartesInRound; b++) {
    const exact = Math.min(0.97, d(b) + rattrapage * (d(b - 1) + d(b + 1)));
    let masse = 0;
    let ecart = 0;
    loi.forEach((q, k) => {
      if (k === b) return;
      masse += q;
      ecart += q * Math.abs(k - b);
    });
    const ecartMoyen = masse > 0 ? Math.max(1, ecart / masse) : 1;
    const gain = b === 0 ? 10 * numeroManche : 20 * b;
    const perte = b === 0 ? -10 * numeroManche : -10 * ecartMoyen;
    const esperance = exact * gain + (1 - exact) * perte;
    if (esperance > meilleurGain) {
      meilleurGain = esperance;
      meilleure = b;
    }
  }
  return meilleure;
}

// --- Manche à une carte --------------------------------------------------------

// On annonce sans voir sa carte, mais en voyant celles des autres : la chance
// que la mienne, tirée parmi celles que je ne vois pas, batte toutes les
// leurs. Exact, au détail près des choix à la pose.
function chanceManche1(state) {
  const ordre = state.players;
  const debut = Math.max(0, ordre.findIndex((p) => p.id === state.leaderPlayerId));
  const autour = ordre.map((_, k) => ordre[(debut + k) % ordre.length]);
  const visibles = new Set(ordre.map((p) => p.revealedCard && p.revealedCard.id).filter(Boolean));
  const inconnues = createDeck(state.extensions).filter((c) => !visibles.has(c.id));
  if (!inconnues.length) return 0;
  let gagnees = 0;
  for (const c of inconnues) {
    const cartes = [];
    let monIdx = -1;
    for (const p of autour) {
      if (p.id === state.myId) {
        monIdx = cartes.length;
        cartes.push(commeAdversaire(c, ledSuitOf(cartes.map((card) => ({ card }))), 'vert'));
      } else if (p.revealedCard) {
        cartes.push(commeAdversaire(p.revealedCard, ledSuitOf(cartes.map((card) => ({ card }))), 'vert'));
      }
    }
    if (monIdx !== -1 && gagnerait(cartes, monIdx)) gagnees += 1;
  }
  return gagnees / inconnues.length;
}

// --- Hasard -------------------------------------------------------------------

function auHasard(liste) {
  return liste[Math.floor(Math.random() * liste.length)];
}

module.exports = {
  cartesJouables,
  variantesDePose,
  coupsLegaux,
  gagnerait,
  joueursApresMoi,
  suivants,
  moi,
  plisRestants,
  plisManquants,
  rang,
  nouvelleMemoire,
  observer,
  aCoupe,
  cartesInconnues,
  commeAdversaire,
  chanceDeGain,
  forceStatique,
  chanceManche1,
  loiDesPlis,
  meilleureAnnonce,
  auHasard,
};
