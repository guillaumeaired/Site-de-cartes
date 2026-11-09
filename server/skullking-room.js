// Salons de Skull King en Socket.io. Même schéma que les salons de
// l'Ascenseur (rooms Map, lobby, hôte, jeton/déconnexion avec délai de
// grâce, pause de révélation de pli, enchaînement auto des manches) mais
// avec des différences de fond : les annonces sont simultanées et cachées
// jusqu'à ce que tout le monde ait choisi, une obligation de suivre la
// couleur imposée par la 1ère numérotée jouée (les cartes spéciales restent
// toujours jouables), et les cartes spéciales (Butin/Kraken/Baleine/pirates
// nommés) ont des effets propres résolus ici.

const {
  MIN_PLAYERS,
  MAX_PLAYERS,
  MONSTER_KINDS,
  PIRATE_POWER_BY_NAME,
  maxPlayersFor,
  deckSizeFor,
  EXTENSION_MODULES,
  EXTENSION_KEYS,
  extensionSet,
  buildRoundSequence,
  MIN_ROUNDS,
  MAX_ROUNDS,
  clampRounds,
  dealRound,
  createDeck,
  isValidBid,
  isCardPlayable,
  ledSuitOf,
  effectiveKind,
  resolveTrick,
  trickBonusForWinner,
  computeRoundScoreBreakdown,
} = require('./skullking');
const { likelyServerRestart } = require('./server-start');
const { makeRoomCode, sanitizeNickname } = require('./commun');
const { recordGameStarted } = require('./play-counts');
const { computeEloChanges } = require('./elo');
const { PIECES_A_CODE } = require('./pieces-a-code');

// Les deux paquets proposés dans le salon. Réglage purement visuel : il ne
// touche ni au deck, ni aux règles, ni au score — seul l'habillage des
// cartes change côté client. Le serveur ne fait que le garder et le
// diffuser, pour que tout le monde autour du tapis voie le même jeu.
const DECK_STYLES = ['classique', 'perso'];

// --- Donne truquée, pour l'essai des pouvoirs -------------------------
// Essayer les sept pouvoirs de Pirate et leurs animations dans l'ordre qu'on
// veut suppose de les avoir tous en main : en jeu normal c'est une affaire de
// chance, et il faut des dizaines de parties pour tomber sur le cas qu'on
// cherchait.
//
// Ce mode s'ouvre par l'ENVIRONNEMENT du serveur, et par rien d'autre :
// SK_ESSAI=1. Aucun message du protocole ne le déclenche, aucun réglage de
// salon ne l'expose — un client ne peut pas y entrer, même en local, même en
// se disant hôte. Un serveur lancé normalement l'ignore.
//
// SK_ESSAI_CARTES fixe le nombre de cartes par manche : la séquence normale
// commence à 1, où il n'y a rien à essayer.
const ESSAI = process.env.SK_ESSAI === '1';
const ESSAI_CARTES = Math.max(0, Math.min(20, Number(process.env.SK_ESSAI_CARTES) || 0));
// SK_ESSAI_BOTS remplit le salon tout seul à l'ouverture : autant de clics en
// moins avant chaque essai, et surtout le même équipage d'une fois sur
// l'autre — une table à cinq et une table à neuf ne montrent pas les mêmes
// chevauchements ni les mêmes pouvoirs.
const ESSAI_BOTS = Math.max(0, Math.min(MAX_PLAYERS - 1, Number(process.env.SK_ESSAI_BOTS) || 0));
// Le niveau des bots assis d'office (1 à 3). Par défaut le Mousse : il pose
// au hasard, on suit sans peine ce qu'il fait pendant un essai.
const ESSAI_NIVEAU = Number(process.env.SK_ESSAI_NIVEAU) || 1;
// SK_ESSAI_CARTE braque le mode sur une carte, ou sur quelques-unes : toute
// la main en est faite, autant d'exemplaires que la manche a de cartes. Le
// tour d'horizon des pouvoirs est bon pour vérifier qu'ils existent tous ;
// pour reprendre le même écran vingt fois de suite — le troc de Will le
// Bandit, où l'on retouche un espacement puis on recommence — il faut le
// déclencher à chaque pli, pas une fois par partie.
//
// Chaque valeur est soit la clé courte d'un pouvoir de Pirate (`will`,
// `rosie`, `juanita`, `rascal`, `harry`, `marythorne`), soit un `kind` de
// carte (`tigress`, `plank`, `davyjones`, `wild15`…).
//
// Plusieurs valeurs séparées par des virgules — `will,juanita` — remplissent
// la main en alternance : un pli sur deux ouvre l'un, un pli sur deux ouvre
// l'autre. C'est ce qu'il faut quand on met deux écrans au point dans la
// même passe, sans avoir à relancer le serveur entre les deux.
const ESSAI_CARTES_VISEES = (process.env.SK_ESSAI_CARTE || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

// Les cartes du paquet que SK_ESSAI_CARTE désigne, dans l'ordre donné. Une
// valeur qui ne correspond à rien est ignorée en silence plutôt que de vider
// la main : le mode reste jouable même sur une faute de frappe.
function cartesVisees(paquet) {
  return ESSAI_CARTES_VISEES.map(
    (cle) =>
      paquet.find((c) => c.kind === 'pirate' && PIRATE_POWER_BY_NAME[c.name] === cle) ||
      paquet.find((c) => c.kind === cle) ||
      null
  ).filter(Boolean);
}

// Ce qui va dans MA main, dans cet ordre : les pouvoirs d'abord, puis ce qui
// se joue contre eux. Les numérotées ordinaires vont aux bots.
const ORDRE_ESSAI = [
  'pirate',      // les cinq nommés, un pouvoir chacun
  'tigress',     // le choix Pirate / Fuite au moment de la pose
  'firstmate',   // Mat le Forban, qui rafle les Pirates sans leur pouvoir
  'skullking',   // qui dévore les Pirates et hérite de leur pouvoir
  'siren',
  'plank', 'davyjones', 'lastvolley', 'wild15',
  'kraken', 'whale', 'stingray', 'loot',
  'escape',
];

// Le 0/14 est une numérotée pour le moteur, mais il demande un choix à la
// pose comme une carte à pouvoir : il reste de mon côté.
function estUnPouvoir(carte) {
  return carte.kind !== 'number' || carte.wild14;
}

function melanger(liste) {
  for (let i = liste.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [liste[i], liste[j]] = [liste[j], liste[i]];
  }
  return liste;
}

// Rend la pioche (le reliquat), comme dealRound : Will le Bandit et Juanita
// Jade y puisent, elle ne peut pas être vide.
function donneTruquee(room, cardsInRound) {
  const paquet = createDeck(extensionsOf(room));
  const rang = (c) => {
    const i = ORDRE_ESSAI.indexOf(c.kind);
    return i === -1 ? ORDRE_ESSAI.length : i;
  };
  const pouvoirs = paquet.filter(estUnPouvoir).sort((a, b) => rang(a) - rang(b));
  // La liste tourne d'une manche à l'autre : triée toujours pareil, elle
  // aurait servi les mêmes dix cartes à chaque donne, et la Planche, le
  // Coffre, le Joker ou le 0/14 — qui viennent après les Pirates dans
  // l'ordre — ne seraient jamais tombés. Vingt-neuf cartes à pouvoir avec
  // l'extension : tout passe en trois manches à dix cartes.
  const depart = pouvoirs.length ? ((room.roundIndex || 0) * cardsInRound) % pouvoirs.length : 0;
  pouvoirs.push(...pouvoirs.splice(0, depart));
  const numerotees = melanger(paquet.filter((c) => !estUnPouvoir(c)));

  // Qui est un bot ne se lit pas sur le joueur : le module de salle ne pose
  // pas de drapeau, il demande à l'adaptateur (voir broadcastLobby, qui
  // calcule `isBot` de la même façon pour le salon).
  const estUnBot = (p) => Boolean(bots && bots.isBot(p.id));
  // Les humains servis les premiers ; s'il n'y en a aucun (table de bots),
  // le premier joueur tient le rôle, sans quoi personne n'aurait de pouvoir
  // et le mode ne servirait à rien.
  const servis = room.players.filter((p) => !estUnBot(p));
  const cible = new Set((servis.length ? servis : room.players.slice(0, 1)).map((p) => p.id));

  // Mode braqué : ma main n'est que des copies des cartes visées, en
  // alternance quand il y en a plusieurs. Le paquet n'en porte qu'un
  // exemplaire de chaque — il n'y a qu'un seul Will le Bandit — donc on les
  // duplique, avec des identifiants neufs : tout le jeu désigne les cartes
  // par leur `id`, deux cartes qui le partageraient seraient la même pour la
  // pose, pour la défausse et pour le pli.
  //
  // Les originaux restent dans le reliquat, où Will peut les repiocher et où
  // Juanita les montre : c'est sans conséquence, les copies ne portent pas
  // leur identifiant.
  const visees = cartesVisees(paquet);
  // `place` : le rang du joueur servi. Sans lui, deux mains servies dans la
  // même manche recevaient les mêmes identifiants (`s62-e4-1` chez deux
  // joueurs à la fois) - or tout le jeu désigne les cartes par leur id : la
  // Planche qui en cible une retirait alors la première des deux trouvée
  // dans le pli, pas celle qu'on avait désignée. Le mode d'essai mentait
  // exactement sur ce qu'il sert à éprouver.
  const copies = (n, place) =>
    Array.from({ length: n }, (_, i) => {
      const modele = visees[i % visees.length];
      return { ...modele, id: `${modele.id}-e${room.roundIndex || 0}-j${place}-${i}` };
    });

  room.players.forEach((p, place) => {
    const main = cible.has(p.id)
      ? (visees.length ? copies(cardsInRound, place) : pouvoirs.splice(0, cardsInRound))
      : numerotees.splice(0, cardsInRound);
    // Le paquet ne porte que 64 numérotées : à huit bots et dix cartes il en
    // faudrait 80. Plutôt qu'une main tronquée — qui casserait l'annonce et
    // le compte des plis — on complète avec ce qui reste de pouvoirs. Le
    // mode perd un peu de sa pureté, la partie reste jouable.
    while (main.length < cardsInRound && pouvoirs.length) main.push(pouvoirs.pop());
    p.hand = main;
  });
  return melanger([...pouvoirs, ...numerotees]);
}

// Les extensions actives d'une salle, en objet plat prêt à partir dans un
// message : c'est cette forme que la planche du salon coche. Passe par
// extensionSet pour qu'une salle d'avant la découpe — qui portait un simple
// booléen — se relise sans conversion : `true` veut dire les huit.
function extensionsOf(room) {
  const source = room && (room.extensions !== undefined ? room.extensions : room.extensionEnabled);
  const actives = extensionSet(source);
  return Object.fromEntries(EXTENSION_KEYS.map((key) => [key, actives.has(key)]));
}
const DEFAULT_DECK_STYLE = 'classique';

function sanitizeDeckStyle(style) {
  return DECK_STYLES.includes(style) ? style : DEFAULT_DECK_STYLE;
}

// Salon d'attente uniquement (voir handleDisconnecting) : délai de grâce
// avant de considérer le joueur vraiment parti.
const DISCONNECT_GRACE_MS = 45_000;
// Les cinq durées qui suivent ne sont plus que des VALEURS D'ORIGINE : elles
// nomment le rythme d'un salon qui n'a rien réglé, et le tableau PACE_SETTINGS
// plus bas s'en sert comme point de départ. Ce qui s'applique vraiment à une
// partie se lit toujours par paceMs(room, clé), jamais par ces constantes.
const TRICK_REVEAL_MS = 2_600;
// Filet de sécurité si le joueur n'interagit jamais (déconnexion, inactivité) -
// pas la vraie limite de lecture : celle-ci est maintenant pilotée par le
// client lui-même (skullking-power-juanita-done), déclenchée une fois toutes
// les cartes retournées + une pause de lecture.
const POWER_REVEAL_MS = 25_000;
const ROUND_END_MS = 7_000;

// Déconnexion en pleine partie : pause indéfinie, plus de délai de grâce fixe
// qui met fin à la partie tout seul (décision réconciliée Backend/Game
// Design/UI-UX, Manche 2 — voir ascenseur-room.js pour le contexte détaillé).
// Seul l'hôte peut choisir d'arrêter la partie plus tôt (skullking-end-game,
// déjà existant).

// Garde-fou anti-inactivité (Manche 2) : un joueur toujours connecté mais qui
// met trop de temps à agir sur son tour (phase 'playing' uniquement — les
// annonces de la phase 'bidding' sont simultanées, pas de "tour" à surveiller
// là) reçoit un simple signal visible de tous, sans saut de tour ni
// exclusion automatique.
const INACTIVITY_WARN_MS = 120_000;

// Le délai laissé au joueur de « Marcher sur la Planche » pour désigner sa
// victime. Déclaré ici avec les autres durées parce que le tableau des
// réglages ci-dessous s'en sert comme valeur d'origine ; la règle qu'il sert,
// elle, est expliquée bien plus bas (voir demanderCiblePlanche).
const PLANK_CHOICE_MS = 20_000;

// --- LE RYTHME DE LA PARTIE -------------------------------------------
//
// Toutes les durées ci-dessus étaient des constantes : la table les subissait
// sans jamais pouvoir en discuter. Or elles n'arrangent pas tout le monde — la
// même table de quatre lit le reliquat de Juanita Jade en dix secondes le
// mardi entre initiés et n'a pas fini en quarante le dimanche avec les
// beaux-parents, et le tableau de fin de manche qu'on trouve interminable à la
// dixième partie est celui qu'on n'a pas eu le temps de lire à la première.
//
// Elles deviennent donc des réglages de salon, du même régime que le paquet et
// le nombre de manches : l'hôte choisit, tout le monde voit, plus rien ne
// bouge une fois la partie lancée (les valeurs sont relues sur `room` à chaque
// usage, mais le salon est le seul endroit où on les écrit).
//
// Une LISTE de valeurs proposées plutôt qu'un curseur ou un champ libre : on
// ne règle pas ça au dixième de seconde, et une liste fermée est aussi ce qui
// garde le serveur à l'abri d'un « 0 » ou d'un « 999999 » envoyé à la main.
// Les libellés voyagent avec les valeurs — c'est le serveur qui sait ce que
// chaque durée veut dire, l'écran n'a plus qu'à dérouler la liste.
const PACE_SETTINGS = [
  {
    key: 'juanita',
    label: 'Regard de Juanita Jade',
    hint: 'Le temps laissé pour lire le reliquat avant que le pli reparte.',
    default: POWER_REVEAL_MS,
    options: [
      { value: 12_000, label: '12 s' },
      { value: 25_000, label: '25 s' },
      { value: 45_000, label: '45 s' },
      { value: 90_000, label: '90 s' },
    ],
  },
  {
    key: 'trick',
    label: 'Pli sur le tapis',
    // Le Kraken garde sa seconde de rab (KRAKEN_EXTRA_MS) : son pli se
    // raconte plus longtemps qu'un pli ramassé, quel que soit le réglage.
    hint: 'Combien de temps le pli complet reste visible avant d’être ramassé.',
    default: TRICK_REVEAL_MS,
    options: [
      { value: 1_400, label: '1,4 s' },
      { value: 2_600, label: '2,6 s' },
      { value: 4_000, label: '4 s' },
      { value: 6_000, label: '6 s' },
    ],
  },
  {
    key: 'roundEnd',
    label: 'Tableau de fin de manche',
    hint: 'La planche des scores entre deux manches. L’hôte peut toujours l’écourter.',
    default: ROUND_END_MS,
    options: [
      { value: 4_000, label: '4 s' },
      { value: 7_000, label: '7 s' },
      { value: 12_000, label: '12 s' },
      { value: 25_000, label: '25 s' },
    ],
  },
  {
    key: 'plank',
    label: 'Choix de la Planche',
    hint: 'Le délai pour désigner le Pirate qui passe par-dessus bord. Passé ce délai, c’est le premier Pirate posé qui tombe.',
    default: PLANK_CHOICE_MS,
    options: [
      { value: 10_000, label: '10 s' },
      { value: 20_000, label: '20 s' },
      { value: 40_000, label: '40 s' },
      { value: 90_000, label: '90 s' },
    ],
  },
  {
    key: 'inactivity',
    label: 'Rappel d’inactivité',
    hint: 'Au bout de combien de temps la table est prévenue qu’un joueur ne joue pas. Aucun tour n’est jamais sauté.',
    default: INACTIVITY_WARN_MS,
    options: [
      { value: 45_000, label: '45 s' },
      { value: 120_000, label: '2 min' },
      { value: 300_000, label: '5 min' },
      // Zéro veut dire « ne jamais prévenir » : le seul réglage de la liste
      // qui éteint son mécanisme au lieu de l'allonger. Une partie entre gens
      // qui se parlent n'a pas besoin d'un serveur pour dire qui traîne.
      { value: 0, label: 'Jamais' },
    ],
  },
];
const PACE_KEYS = PACE_SETTINGS.map((r) => r.key);
// Un pli englouti par le Kraken se raconte plus longtemps qu'un pli ramassé :
// il vient prendre le centre du feutre, avale les cartes une à une, se
// retourne, puis s'efface — et la ligne qui dit « personne ne le remporte »
// n'apparaît qu'ensuite, sur un feutre vide (voir playKrakenAnimation). Cette
// seconde s'AJOUTE au réglage au lieu d'être une durée à part : sur un salon
// réglé « Vif », un Kraken figé à 3,6 s aurait duré plus du double d'un pli
// normal. Ce n'est pas un réglage de plus, c'est le même avec son animation
// en supplément.
const KRAKEN_EXTRA_MS = 1_000;

// Trois allures toutes faites. Personne n'ouvre un salon pour arbitrer cinq
// durées une par une : on veut « ça va trop vite » ou « ça traîne ». Les
// réglages fins restent là pour qui veut, en dessous.
const PACE_PRESETS = [
  {
    key: 'vif',
    label: 'Vif',
    hint: 'Pour une table qui connaît le jeu et veut enchaîner.',
    values: { juanita: 12_000, trick: 1_400, roundEnd: 4_000, plank: 10_000, inactivity: 45_000 },
  },
  {
    key: 'normal',
    label: 'Normal',
    hint: 'Le rythme d’origine du jeu.',
    values: { juanita: 25_000, trick: 2_600, roundEnd: 7_000, plank: 20_000, inactivity: 120_000 },
  },
  {
    key: 'tranquille',
    label: 'Tranquille',
    hint: 'Pour une table qui découvre, ou qui joue en discutant.',
    values: { juanita: 45_000, trick: 4_000, roundEnd: 12_000, plank: 40_000, inactivity: 300_000 },
  },
];

// Les valeurs effectives : ce que l'hôte a choisi, chaque réglage manquant ou
// inconnu retombant sur sa valeur d'origine. Lu à chaque usage plutôt que figé
// au lancement — une partie créée avant ce réglage (ou un salon rechargé) n'a
// pas de `room.pace` du tout, et doit se jouer exactement comme avant.
function paceOf(room) {
  const choix = (room && room.pace) || {};
  return Object.fromEntries(
    PACE_SETTINGS.map((reglage) => {
      const valeur = Number(choix[reglage.key]);
      const connue = reglage.options.some((o) => o.value === valeur);
      return [reglage.key, connue ? valeur : reglage.default];
    })
  );
}

function paceMs(room, key) {
  return paceOf(room)[key];
}

// L'allure toute faite qui correspond aux cinq valeurs en cours, ou null si
// l'hôte a bricolé la sienne. C'est ce qui allume (ou n'allume pas) l'un des
// trois boutons du haut : mentir là-dessus serait pire que ne rien allumer.
function pacePresetOf(room) {
  const actuel = paceOf(room);
  const trouve = PACE_PRESETS.find((preset) => PACE_KEYS.every((k) => preset.values[k] === actuel[k]));
  return trouve ? trouve.key : null;
}

// Pirates ciblables par "Marcher sur la Planche" dans un pli en cours :
// identité choisie (effectiveKind, gère la Tigresse-Pirate), pas le type
// brut de la carte - sinon une Tigresse jouée comme Pirate n'est jamais
// proposée au ciblage (bug corrigé, cf. audit Game Designer 2026-08-12).
function eligiblePlankTargets(trick) {
  return trick.filter((t) => effectiveKind(t.card) === 'pirate');
}

// Pouvoirs hérités par le Skull King quand il remporte un pli (pas par Mat
// le Forban, qui mange les Pirates sans prendre leur pouvoir) : chaque Pirate classique capturé (retiré par la Planche exclu, voir
// excludedIdx) transmet le sien, à résoudre à la suite les uns des autres.
// Sur le tout dernier pli d'une manche, seul celui d'Harry le Géant survit.
function capturedPirateKeys(trick, excludedIdx, isLastTrick) {
  const capturedNames = trick
    .filter((t, i) => !excludedIdx.has(i) && t.card.kind === 'pirate')
    .map((t) => t.card.name);
  return capturedNames
    .map((name) => PIRATE_POWER_BY_NAME[name])
    .filter((k) => k && (k === 'harry' || !isLastTrick));
}

// QUI DÉVORE QUI. La hiérarchie des cartes de personnage n'est pas une
// échelle de valeurs abstraite : elle raconte quelque chose, et le tapis peut
// le montrer. Le Skull King mange les Pirates, un Pirate mange les Sirènes,
// une Sirène emporte le Skull King. Rien de tout ça ne se voyait sauf le
// premier cas — les autres cartes restaient posées, intactes, à côté de celle
// qui venait pourtant de les battre.
//
// On lit l'identité CHOISIE (effectiveKind) : une Tigresse annoncée en Pirate
// est dévorée comme un Pirate et dévore comme un Pirate — c'est ce que le
// joueur voit sur le tapis. Les cartes déjà retirées (Planche, Davy Jones)
// n'y sont plus.
//
// AU MOMENT DE LA RÉSOLUTION, jamais avant. Montrer une Sirène avalée dès
// qu'un Pirate la rejoint dans le pli serait un mensonge une fois sur deux :
// si le Skull King arrive ensuite, la boucle se referme et c'est la SIRÈNE
// qui remporte le pli. Tant que le pli n'est pas complet, personne n'a mangé
// personne.
//
// Renvoie { devoreurId, ids } - le client a besoin de savoir vers QUELLE
// carte faire converger les autres, et ce n'est plus toujours le Skull King.
const DEVORE = {
  // Le Skull King prend tout le rang Pirate, Mat le Forban compris : c'est
  // exactement ce que le bonus de capture compte déjà (+30 chacun).
  skullking: ['pirate', 'firstmate'],
  // Un Pirate bat les Sirènes. S'il gagne, c'est qu'aucun Mat le Forban
  // n'était là (il les bat tous) : rien d'autre à avaler.
  pirate: ['siren'],
  // Mat le Forban bat tous les Pirates. S'il gagne, ni Sirène ni Skull King
  // n'étaient du pli - ils le battent.
  firstmate: ['pirate'],
  // La Sirène séduit le Skull King, et emporte Mat le Forban. Pas les
  // Pirates : elle ne les bat pas. Quand les trois sont réunis (Pirate +
  // Skull King + Sirène), elle remporte le pli par la règle de la boucle,
  // pas en battant le Pirate - qui reste donc entier sur le tapis.
  siren: ['skullking', 'firstmate'],
};

function devoreesParLeVainqueur(cards, result) {
  const vide = { devoreurId: null, ids: [] };
  if (result.destroyed || result.winnerIdx == null) return vide;
  const vainqueur = cards[result.winnerIdx];
  const proies = DEVORE[effectiveKind(vainqueur)];
  if (!proies) return vide;
  const ids = cards
    .filter((c, i) => i !== result.winnerIdx && !result.excludedIdx.has(i) && proies.includes(effectiveKind(c)))
    .map((c) => c.id);
  return ids.length ? { devoreurId: vainqueur.id, ids } : vide;
}

// Cartes jetées par-dessus bord par « Marcher sur la Planche ». Le calcul
// les retirait bel et bien du pli (resolveTrick, excludedIdx) mais l'écran
// n'en disait rien : le Pirate restait posé sur le tapis, intact, et le
// pouvoir avait l'air de n'avoir servi à rien. Ces ids sont là pour que le
// client puisse le faire tomber à l'eau.
//
// Volontairement indépendant de result.destroyed : un Kraken qui détruit le
// pli n'annule pas la Planche, le Pirate a bien été retiré avant. La
// condition est exactement celle de resolveTrick — une cible absente du pli
// ne retire rien, ici comme là-bas.
function plankedCardIds(cards) {
  const ids = [];
  for (const c of cards) {
    if (effectiveKind(c) !== 'plank' || !c.removesId) continue;
    if (cards.some((cc) => cc.id === c.removesId)) ids.push(c.removesId);
  }
  return ids;
}

// Ce que le Coffre de Davy Jones engloutit : tous les Monstres Marins du
// pli. Comme pour la Planche, le calcul les retirait sans que l'écran n'en
// dise rien — le Kraken restait posé, entier, à côté d'un coffre qui venait
// pourtant de le détruire.
//
// Le coffre est renvoyé avec eux : c'est vers lui que les cartes tombent, et
// le client n'a pas à le rechercher par son genre. Lui-même est détruit par
// son propre effet, mais il reste sur le tapis — on ne fait pas disparaître
// la bouche qui mange.
function davyJonesSwallow(cards) {
  const coffre = cards.find((c) => effectiveKind(c) === 'davyjones');
  if (!coffre) return null;
  const ids = cards
    .filter((c) => c !== coffre && MONSTER_KINDS.includes(effectiveKind(c)))
    .map((c) => c.id);
  return { chestId: coffre.id, ids };
}

// Pièces de joueur (façon Monopoly) : une seule par salon, choisie dans le
// salon d'attente. Le serveur ne connaît que les clés - le dessin vit côté
// client (voir PIECES dans public/skullking.js) ; les deux listes doivent
// rester alignées.
//
// Les neuf premières sont la vitrine, ouverte à tous. Les suivantes, derrière
// une flèche du choix de pièce, sont RÉSERVÉES À L'HÔTE — le privilège de
// celui qui a ouvert le salon. Le hasard ne les sort donc jamais : il donnerait
// à un invité ce qu'il n'a pas le droit de prendre. La vitrine suffit à elle
// seule à une table pleine (neuf joueurs au plus, voir maxPlayersFor).
// Les listes elles-mêmes vivent dans pieces.js, que le profil partage.
const { PIECE_KEYS } = require('./pieces');
const { COULEURS, couleurValide, couleurParDefaut } = require('./couleurs');
const PIECES_EN_VITRINE = 9;

// Ce que le hasard peut encore donner : la vitrine seule.
function piecesTirables(room) {
  const prises = new Set(room.players.map((p) => p.piece).filter(Boolean));
  return PIECE_KEYS.slice(0, PIECES_EN_VITRINE).filter((k) => !prises.has(k));
}

// Une pièce du lot, et de la vitrine sauf pour l'hôte. Si l'hôte quitte le
// salon, son successeur hérite du privilège ; la pièce de l'ancien part avec
// lui, il n'y a donc rien à reprendre à personne.
//
// Exception : les pièces à code (voir pieces-a-code.js) ne vont qu'aux
// comptes qui ont saisi leur code, qu'ils soient hôtes ou non.

function pieceAutorisee(room, player, piece) {
  const rang = PIECE_KEYS.indexOf(piece);
  if (rang === -1) return false;
  if (PIECES_A_CODE.includes(piece)) return Boolean(player.ownedPieces && player.ownedPieces.includes(piece));
  return rang < PIECES_EN_VITRINE || player.id === room.hostId;
}

// Filet de sécurité au lancement : si une pièce manque encore (partie reprise
// d'un salon d'avant l'attribution à l'arrivée), on la comble au hasard parmi
// celles qui restent — au hasard et non la première libre, sinon la même
// partie donnerait toujours le crâne au même distrait.
function assignMissingPieces(room) {
  for (const p of room.players) {
    if (!p.piece) {
      const libres = piecesTirables(room);
      p.piece = libres[Math.floor(Math.random() * libres.length)] || null;
    }
    donnerCouleur(room, p);
  }
}

// LA COULEUR, c'est ce qui distingue les joueurs à table (voir couleurs.js) :
// elle peint la roue, la courbe, la légende. Deux joueurs ne l'ont donc
// jamais en même temps — le motif, lui, n'est qu'une affaire de goût.
function couleursPrises(room, sauf) {
  return new Set(room.players.filter((p) => p !== sauf && p.couleur).map((p) => p.couleur));
}

function couleurLibre(room, player, couleur) {
  return couleurValide(couleur) && !couleursPrises(room, player).has(couleur);
}

// Une couleur à qui n'en a pas : celle qu'il apporte si elle est libre (la
// couleur de sa pièce de profil pour un compte, celle gardée par son appareil
// pour un invité — c'est le client qui l'envoie), sinon une libre au hasard.
// La couleur ne suit plus le motif : elle ne change que si on la change.
function donnerCouleur(room, player, preferee) {
  if (!player || player.couleur) return;
  if (couleurLibre(room, player, preferee)) {
    player.couleur = preferee;
    return;
  }
  const prises = couleursPrises(room, player);
  const libres = COULEURS.filter((c) => !prises.has(c));
  player.couleur = libres[Math.floor(Math.random() * libres.length)] || null;
}

// PERSONNE NE S'ASSIED SANS PIÈCE. Le salon montre déjà une pièce à chaque
// arrivant (le client en dérive une de son pseudo faute de choix), mais tant
// qu'elle valait null côté serveur elle restait offerte : le voisin pouvait
// cliquer dessus et deux matelots portaient le même crâne. On en réserve donc
// une dès l'arrivée, au hasard parmi les libres — le joueur garde la main
// pour en changer, la pièce libérée retombant aussitôt dans le lot. Les bots
// passent par la même porte : ils n'ont pas d'écran pour choisir.
//
// `preferee` est la pièce que l'appareil du joueur a gardée de sa dernière
// partie : on la lui rend si elle est encore libre, sinon le hasard tranche.
// C'est le même souhait qu'exauçait le client une fois le salon dessiné —
// exaucé à la porte, il ne peut plus lui passer sous le nez entre-temps.
//
// La couleur suit la même porte : `couleurPreferee` est celle que le joueur
// apporte, rendue si elle est libre (voir donnerCouleur).
function giveFreePiece(room, player, preferee, couleurPreferee) {
  if (!player) return;
  if (!player.piece) {
    const prise = room.players.some((p) => p.piece === preferee);
    if (!prise && pieceAutorisee(room, player, preferee)) {
      player.piece = preferee;
    } else {
      const libres = piecesTirables(room);
      player.piece = libres[Math.floor(Math.random() * libres.length)] || null;
    }
  }
  donnerCouleur(room, player, couleurPreferee);
}

// Le seul chemin d'ajout d'un bot : le bouton de l'hôte et le mode essai
// passent tous les deux par ici, pour que la pièce soit prise dans les deux
// cas. Renvoie le joueur ajouté, ou null si la salle a refusé. Le niveau est
// vérifié par l'adaptateur : une valeur inconnue retombe sur son défaut.
function addBotToRoom(io, room, niveau) {
  if (!bots) return null;
  const id = bots.addBot(io, room, registerSkullKingHandlers, niveau);
  if (!id) return null;
  const bot = findPlayer(room, id);
  giveFreePiece(room, bot);
  return bot;
}

// --- Chat de salon ---
// L'historique vit sur le salon, pas sur la partie : il traverse les manches
// et les revanches, et ne disparaît qu'avec le salon lui-même. Plafonné pour
// qu'une partie longue ne fasse pas gonfler la mémoire indéfiniment (aucune
// base de données ici, tout est en RAM).
const CHAT_MAX_LENGTH = 200;
const CHAT_HISTORY = 80;
// Anti-spam : un message au plus toutes les 700 ms, et pas plus de 8 sur une
// fenêtre glissante de 12 s. Un salon de jeu n'a aucune raison d'écrire plus
// vite, et ça évite qu'un joueur noie les autres.
const CHAT_MIN_INTERVAL_MS = 700;
const CHAT_BURST_WINDOW_MS = 12_000;
const CHAT_BURST_MAX = 8;

function sanitizeChatText(text) {
  if (typeof text !== 'string') return null;
  // On normalise les retours à la ligne et on écrase les séries d'espaces :
  // un message ne doit pas pouvoir occuper dix lignes à lui seul.
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
  return clean || null;
}

// Vrai si le message doit être écarté. Ce garde-fou renvoyait la RAISON du
// refus, pour la dire au joueur ; elle finissait en toast au travers du haut
// de l'écran (voir le handler skullking-chat). Il ne renvoie plus qu'un
// verdict : le message n'apparaît pas, ce qui se voit tout seul.
function chatRateLimit(player, now) {
  if (player.chatLast && now - player.chatLast < CHAT_MIN_INTERVAL_MS) return true;
  const recents = (player.chatTimes || []).filter((t) => now - t < CHAT_BURST_WINDOW_MS);
  if (recents.length >= CHAT_BURST_MAX) return true;
  player.chatTimes = recents;
  return false;
}

let chatSeq = 0;

// Les allées et venues du salon s'écrivent dans la discussion. Elles ne se
// disaient qu'en toast — visible trois secondes, et seulement par ceux qui
// regardaient l'écran à cet instant : qui arrivait pendant qu'on choisissait
// sa pièce ne laissait aucune trace, et le fil qu'on relit en arrivant ne
// disait pas qui était déjà là.
//
// Elles passent par le chat ordinaire, donc par son historique (renvoyé avec
// le salon et avec l'état de jeu) : une reconnexion les retrouve comme le
// reste. Pas de playerId ni de pseudo — ces lignes n'ont pas d'auteur, et
// c'est `system` qui dit au client de les poser en italique, sans pastille
// de nom (voir .sk-chat-line--systeme).
function pushSystemChat(io, room, text) {
  chatSeq += 1;
  const message = { id: `c${chatSeq}`, system: true, text, at: Date.now() };
  room.chat = [...(room.chat || []), message].slice(-CHAT_HISTORY);
  broadcastToRoom(io, room, 'skullking-chat-message', message);
}

const rooms = new Map();

// Compteurs simples pour l'observabilite (route /stats, server/index.js) -
// pas de dependance a des logs bruts pour savoir combien de parties tournent.
function getStats() {
  const list = [...rooms.values()];
  return { total: list.length, playing: list.filter((r) => r.phase === 'playing').length };
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function findPlayerByToken(room, token) {
  if (!token) return null;
  return room.players.find((p) => p.token === token);
}

// Voir ascenseur-room.js pour le contexte détaillé de ce piège récurrent :
// toute structure indexée par socket.id doit être ré-indexée à la
// reconnexion, sous peine d'annonce perdue / score NaN / pli orphelin.
function rekeyPlayerId(room, oldId, newId) {
  if (oldId === newId) return;
  if (room.bids && Object.prototype.hasOwnProperty.call(room.bids, oldId)) {
    room.bids[newId] = room.bids[oldId];
    delete room.bids[oldId];
  }
  if (Array.isArray(room.currentTrick)) {
    room.currentTrick.forEach((t) => {
      if (t.playerId === oldId) t.playerId = newId;
    });
  }
  if (room.pendingPower && room.pendingPower.playerId === oldId) {
    room.pendingPower.playerId = newId;
  }
  if (room.pendingPower && room.pendingPower.leaderId === oldId) {
    room.pendingPower.leaderId = newId;
  }
  if (Array.isArray(room.lootAlliances)) {
    room.lootAlliances.forEach((a) => {
      if (a.lootPlayerId === oldId) a.lootPlayerId = newId;
      if (a.winnerId === oldId) a.winnerId = newId;
    });
  }
  if (room.lastRoundSummary) {
    room.lastRoundSummary.results.forEach((r) => {
      if (r.id === oldId) r.id = newId;
    });
    if (Array.isArray(room.lastRoundSummary.lootLinks)) {
      room.lastRoundSummary.lootLinks.forEach((link) => {
        if (link.a === oldId) link.a = newId;
        if (link.b === oldId) link.b = newId;
      });
    }
  }
  if (Array.isArray(room.finalRanking)) {
    room.finalRanking.forEach((r) => {
      if (r.id === oldId) r.id = newId;
    });
  }
  // Extension : cible du pouvoir de Mary Thorne (carte forcée au pli
  // suivant), joueur qui passe son tour après une Dernière Salve, joueur
  // qui doit encore jouer sa carte supplémentaire.
  if (room.forcedPlays && Object.prototype.hasOwnProperty.call(room.forcedPlays, oldId)) {
    room.forcedPlays[newId] = room.forcedPlays[oldId];
    delete room.forcedPlays[oldId];
  }
  if (Array.isArray(room.chat)) {
    room.chat.forEach((m) => {
      if (m.playerId === oldId) m.playerId = newId;
    });
  }
  if (room.sittingOutIds && room.sittingOutIds.delete(oldId)) room.sittingOutIds.add(newId);
  if (room.extraCardOwedBy === oldId) room.extraCardOwedBy = newId;
  rekeyHostId(room, oldId, newId);
}

function rekeyHostId(room, oldId, newId) {
  if (room.hostId === oldId) room.hostId = newId;
}

function sendError(socket, message) {
  socket.emit('skullking-error', message);
}

// Qui reçoit encore quelque chose de ce salon. Un joueur qui a cliqué
// « Quitter » en pleine partie reste dans room.players — son score doit
// figurer au classement final envoyé aux autres — mais il ne doit plus rien
// recevoir : sans ce filtre, son propre départ lui renvoyait l'état
// 'game-end' déclenché par ce départ, et l'écran de fin se rouvrait sur
// l'accueil qu'il venait d'atteindre.
function destinataires(room) {
  return room.players.filter((p) => !p.gone);
}

// Les spectateurs : arrivés par le lien alors que la partie était déjà
// lancée. Ils ne sont pas dans room.players — l'ordre des plis, la donne et
// les scores n'en savent rien — mais ils reçoivent tout ce que la table
// reçoit, vu d'une chaise vide (voir stateFor) : aucune main, aucune annonce
// avant la révélation. Au retour au salon, ils prennent place à la table
// (voir seatSpectators).
function spectatorsOf(room) {
  if (!room.spectators) room.spectators = [];
  return room.spectators;
}

function findSpectator(room, id) {
  return spectatorsOf(room).find((s) => s.id === id);
}

function findSpectatorByToken(room, token) {
  if (!token) return null;
  return spectatorsOf(room).find((s) => s.token === token);
}

// Ce qu'un spectateur passe à stateFor : une chaise vide. Les champs lus sur
// le joueur (sa main, ses bonus en attente) y sont vides, et son id ne figure
// dans aucune annonce ni aucun pouvoir — il ne voit donc que ce que tout le
// monde voit.
function spectatorView(s) {
  return { id: s.id, nickname: s.nickname, hand: [], pendingBonus: 0, rascalStake: 0, spectator: true };
}

function broadcastToRoom(io, room, event, data) {
  for (const p of destinataires(room)) io.to(p.id).emit(event, data);
  for (const s of spectatorsOf(room)) io.to(s.id).emit(event, data);
}

function humanPlayersLeft(room) {
  return destinataires(room).filter((p) => !bots || !bots.isBot(p.id));
}

function closeRoom(room) {
  clearRoomTimers(room);
  spectatorsOf(room).forEach((s) => clearTimeout(s.disconnectTimer));
  if (bots) bots.forgetRoom(room);
  rooms.delete(room.code);
}

// Le retour au salon : les spectateurs s'assoient, tant qu'il reste des
// places. Ceux qui ne tiennent pas — la table était pleine — sont prévenus
// et rendus à l'accueil plutôt que laissés devant un salon où ils ne sont
// pas.
function seatSpectators(io, room) {
  const maxPlayers = maxPlayersFor(extensionsOf(room));
  const waiting = spectatorsOf(room);
  room.spectators = [];
  waiting.forEach((s) => {
    clearTimeout(s.disconnectTimer);
    const sock = io.sockets && io.sockets.sockets ? io.sockets.sockets.get(s.id) : null;
    if (room.players.length >= maxPlayers) {
      io.to(s.id).emit('skullking-spectator-dropped', { reason: 'full', maxPlayers });
      if (sock) sock.data.skullkingRoom = null;
      return;
    }
    // Déconnecté au moment du retour au salon : son siège serait vide, on ne
    // le garde pas.
    if (s.connected === false) return;
    const player = newPlayer(s.id, s.nickname, s.token, s.account);
    room.players.push(player);
    giveFreePiece(room, player, s.piece, s.couleur);
    pushSystemChat(io, room, `${s.nickname} prend place à la table.`);
  });
}

// Bots (server/skullking-bot.js) : branchés par injection pour que ce module
// n'en dépende pas et que le jeu tourne à l'identique sans eux.
let bots = null;
function setBotAdapter(adapter) {
  bots = adapter;
}

// Comptes et Elo (server/comptes.js) : même injection que les bots. Sans eux
// (tests, autres déploiements), tout le monde joue en invité et aucune partie
// n'est classée.
let comptes = null;
function setComptesAdapter(adapter) {
  comptes = adapter;
}

// Qui s'assied : un joueur connecté s'assied sous le pseudo de son compte,
// quoi qu'ait envoyé le navigateur (il peut ensuite en prendre un autre pour
// la table, voir skullking-set-nickname) ; un invité sous le pseudo qu'il a tapé,
// à condition que ce ne soit pas celui d'un compte — sinon n'importe qui
// jouerait sous le nom du premier du classement.
function identityFor(socket, rawNickname) {
  const user = socket.data && socket.data.user;
  if (user) return { nickname: user.pseudo, account: user };
  const nickname = sanitizeNickname(rawNickname);
  if (nickname && comptes && comptes.isReservedPseudo(nickname)) {
    return { error: 'Ce pseudo appartient à un compte : connecte-toi, ou choisis-en un autre.' };
  }
  return { nickname, account: null };
}

// Un même compte ne s'assied qu'une fois à une table : deux onglets sous le
// même nom compteraient double au classement.
function accountAlreadyHere(room, account, token) {
  if (!account) return false;
  const here = [...room.players.filter((p) => !p.gone), ...spectatorsOf(room)];
  return here.some((p) => p.userId === account.id && p.token !== token);
}

function broadcastLobby(io, room) {
  const extensions = extensionsOf(room);
  const maxPlayers = maxPlayersFor(extensions);
  for (const p of destinataires(room)) {
    io.to(p.id).emit('skullking-lobby-update', {
      code: room.code,
      // Le salon est déjà émis joueur par joueur (isHost en dépend) : on en
      // profite pour dire à chacun qui il est, sinon le choix de pièce ne
      // sait pas quelle case est la sienne (myId n'arrive qu'avec l'état de
      // jeu, donc trop tard).
      myId: p.id,
      // Le jeton personnel : les pièces que CE joueur a gagnées par code, et
      // s'il peut en saisir un (il faut un compte pour garder la pièce).
      myPieces: p.ownedPieces || [],
      canRedeem: Boolean(comptes && p.userId),
      // isBot : l'hôte peut retirer un bot du salon, pas un joueur — le
      // client a donc besoin de savoir lesquels en sont.
      players: room.players.map((pp) => ({
        id: pp.id,
        nickname: pp.nickname,
        piece: pp.piece || null,
        couleur: pp.couleur || null,
        isBot: Boolean(bots && bots.isBot(pp.id)),
        // La cote de qui a un compte, « invité » pour les autres humains : le
        // salon dit d'avance si la partie sera classée, et pour qui.
        elo: pp.userId ? pp.elo : null,
        accountPseudo: pp.userId ? pp.accountPseudo : null,
        isGuest: !pp.userId && !(bots && bots.isBot(pp.id)),
        // Le niveau du bot (1 à 3, voir briefs/bots-skullking.md) : la
        // marque « BOT » le porte, et l'hôte le change d'un clic.
        botLevel: bots && bots.isBot(pp.id) && bots.botLevel ? bots.botLevel(pp.id) : null,
      })),
      // Les niveaux proposés, dans l'ordre : c'est le serveur qui sait
      // lesquels existent et comment ils s'appellent.
      botLevels: bots && bots.botCatalogue ? bots.botCatalogue() : [],
      pieceKeys: PIECE_KEYS,
      couleurs: COULEURS,
      chat: room.chat || [],
      hostId: room.hostId,
      isHost: p.id === room.hostId,
      canStart: room.players.length >= MIN_PLAYERS && room.players.length <= maxPlayers,
      minPlayers: MIN_PLAYERS,
      maxPlayers,
      // Les extensions sont cliquables seulement par l'hôte (imposé aussi
      // côté serveur dans les handlers dédiés) ; tous les autres les voient
      // en lecture seule via ces mêmes champs. La liste des modules part
      // avec l'état plutôt que d'être recopiée dans l'écran : elle décide du
      // libellé, du nombre de cartes et de l'ordre des lignes, et le salon
      // n'a plus qu'à la dérouler.
      extensions,
      extensionModules: EXTENSION_MODULES,
      // La taille du paquet est calculée là où il se construit : l'écran la
      // recopierait sinon à partir des lignes cochées, et les deux comptes
      // finiraient par diverger le jour où une carte change de camp.
      deckSize: deckSizeFor(extensions),
      // Le paquet : même régime que le switch d'extension — choisi par
      // l'hôte, vu en lecture seule par les autres.
      deckStyle: sanitizeDeckStyle(room.deckStyle),
      deckStyles: DECK_STYLES,
      totalRounds: room.totalRounds || MAX_ROUNDS,
      minRounds: MIN_ROUNDS,
      maxRounds: MAX_ROUNDS,
      // Le rythme : même régime que le paquet et les manches — réglé par
      // l'hôte, lu par tout le monde. La liste des réglages part avec l'état
      // plutôt que d'être recopiée dans l'écran, exactement comme celle des
      // modules d'extension : c'est le serveur qui applique ces durées, c'est
      // donc lui qui dit lesquelles existent et ce qu'elles valent.
      pace: paceOf(room),
      paceSettings: PACE_SETTINGS,
      pacePresets: PACE_PRESETS,
      pacePreset: pacePresetOf(room),
    });
  }
}

function playerAtTurn(room) {
  const order = activeOrderThisTrick(room);
  if (room.turnCount < order.length) return order[room.turnCount];
  // Carte supplémentaire de Dernière Salve : jouée après tout le monde,
  // toujours par le même joueur qui l'a posée ce pli-ci.
  return findPlayer(room, room.extraCardOwedBy);
}

// Aperçu du pli en cours (même incomplet) : qui le mènerait à l'instant, et
// s'il serait détruit (Kraken, ou Baleine sans numérotée pour départager).
function currentTrickPreview(room) {
  if (!room.currentTrick || room.currentTrick.length === 0) return { leaderId: null, destroyed: false };
  const cards = room.currentTrick.map((t) => t.card);
  const result = resolveTrick(cards);
  const entry = room.currentTrick[result.leaderIdx];
  // `destroyedBy` accompagne l'annonce « ce pli sera détruit » : elle se lit
  // pendant que le pli se joue, c'est là qu'il est le plus utile de savoir
  // quelle carte l'a condamné — on joue encore.
  const destroyerIdx = result.destroyerIdx;
  return {
    leaderId: entry ? entry.playerId : null,
    // La CARTE qui mène, pas seulement son joueur : après une Dernière
    // Salve, un joueur a deux cartes dans le pli, et seule l'une des deux
    // peut mener (la Salve ne gagne jamais).
    leaderCardId: entry ? entry.card.id : null,
    destroyed: result.destroyed,
    destroyedBy: destroyerIdx != null && destroyerIdx !== -1 ? effectiveKind(cards[destroyerIdx]) : null,
    // Les cartes mises hors course par un Monstre Marin. Renvoyées pendant
    // que le pli se joue, pas seulement à sa résolution : c'est là qu'elles
    // servent, quand on choisit encore sa propre carte.
    neutralisedCardIds: (result.neutralisedIdx || []).map((i) => cards[i].id),
  };
}

function allBidsIn(room) {
  return room.players.every((p) => Object.prototype.hasOwnProperty.call(room.bids, p.id));
}

function startRound(io, room) {
  const cardsInRound = room.roundSequence[room.roundIndex];
  if (ESSAI) {
    room.residualPile = donneTruquee(room, cardsInRound);
  } else {
    const { hands, residualPile } = dealRound(room.players.length, cardsInRound, extensionsOf(room));
    room.players.forEach((p, i) => { p.hand = hands[i]; });
    room.residualPile = residualPile;
  }
  room.players.forEach((p) => {
    p.tricksWon = 0;
    p.pendingBonus = 0;
    p.rascalStake = 0;
  });
  room.lootAlliances = [];
  room.cardsInRound = cardsInRound;
  room.bids = {};
  room.leaderIndex = (room.dealerIndex + 1) % room.players.length;
  room.turnCount = 0;
  room.currentTrick = [];
  room.trickNumber = 1;
  room.trickPaused = false;
  room.pendingPower = null;
  room.pendingPowerQueue = null;
  room.lastTrickResult = null;
  room.lastWinningCard = null;
  room.forcedPlays = {};
  room.sittingOutIds = new Set();
  room.extraCardOwedBy = null;
  room.phase = 'bidding';
  broadcastState(io, room);
}

// Ordre de jeu du pli en cours, en partant du meneur : identique à
// room.players tant que tout le monde a encore une carte. Celui qui a posé
// une Dernière Salve a joué deux fois dans un pli : sa main est vide au
// dernier pli de la manche, il en est donc absent. Si c'est lui qui aurait
// dû mener, le joueur suivant dans l'ordre prend sa place naturellement
// (aucun cas particulier à gérer).
function activeOrderThisTrick(room) {
  const n = room.players.length;
  const rotated = Array.from({ length: n }, (_, i) => room.players[(room.leaderIndex + i) % n]);
  const absents = room.sittingOutIds;
  return absents && absents.size ? rotated.filter((p) => !absents.has(p.id)) : rotated;
}

// Nombre total de cartes attendues pour boucler le pli en cours : un joueur
// qui passe son tour en retire une, et Dernière Salve (si jouée ce pli-ci,
// hors tout dernier pli de la manche) en ajoute une - la carte
// supplémentaire du joueur qui l'a posée, jouée après tout le monde.
function trickTotalCards(room) {
  return activeOrderThisTrick(room).length + (room.extraCardOwedBy ? 1 : 0);
}

function roundNumber(room) {
  return room.roundIndex + 1;
}

// Réduit au total courant (+ le dernier delta pour animer le tableau) — même
// raisonnement que l'Ascenseur : le détail manche par manche passe par le
// pop-up de fin de manche, pas par un tableau qui grossirait sans fin.
function scoreboard(room) {
  return room.players.map((p) => ({
    id: p.id,
    nickname: p.nickname,
    total: p.totalScore,
    lastDelta: p.roundHistory.length ? p.roundHistory[p.roundHistory.length - 1].delta : null,
  }));
}

function stateFor(room, p) {
  const inRound = room.phase === 'bidding' || room.phase === 'playing' || room.phase === 'power';
  const bidding = room.phase === 'bidding';
  // Manche 1 (1 carte chacun) : l'annonce n'est pas un pari complètement à
  // l'aveugle, elle se base sur ce qu'on voit des AUTRES - jamais sur sa
  // propre carte, cachée jusqu'à ce qu'on la joue. Ne s'applique qu'à
  // l'annonce : une fois la phase de jeu entamée, chacun pose sa carte à
  // son tour et elle devient visible normalement pour tout le monde.
  // La condition porte sur le nombre de CARTES, pas sur le numéro de manche :
  // c'est d'avoir une carte unique qui rend l'annonce aveugle, le numéro n'y
  // est pour rien. En partie normale les deux sont le même événement (la
  // séquence commence toujours à une carte) ; ils ne se séparent qu'en mode
  // essai, où l'on veut dix cartes dès la première manche et où cacher la
  // main tout entière n'aurait aucun sens.
  const blindRound1 = bidding && room.cardsInRound === 1;
  // Manche à une seule carte : chacun tient la sienne tournée vers les
  // autres, et c'est sur elles qu'on annonce. Seule la mienne reste hors de
  // cette liste — elle est dans ma main, cachée (voir blindRound1).
  //
  // Elle n'est envoyée QUE pendant l'annonce. Elle l'était aussi pendant le
  // jeu, tant que son porteur ne l'avait pas posée : rien de neuf n'était
  // révélé — tout le monde les avait vues — mais le tapis portait alors
  // pêle-mêle ce qui était tombé et ce qui ne l'était pas, alors que dans
  // toute autre manche il ne porte que le pli. L'écran les fait rentrer en
  // main à la fin de l'annonce (reprendreCartesManche1) et elles reviennent
  // une à une, jouées, comme partout ailleurs — il n'a donc plus rien à en
  // faire ici.
  //
  // La condition porte sur le nombre de CARTES et non sur le numéro de
  // manche, comme blindRound1 juste au-dessus : c'est d'en avoir une seule
  // qui fait qu'on la tient. Les deux ne se séparent qu'en mode essai, où
  // `pp.hand[0]` sur une main de dix aurait montré une carte au hasard.
  const base = {
    phase: room.phase,
    code: room.code,
    myId: p.id,
    isHost: p.id === room.hostId,
    // Vrai pour qui regarde sans jouer (voir spectatorView) : l'écran retire
    // la main et les commandes, et annonce qu'on s'assoira au salon.
    spectator: Boolean(p.spectator),
    spectators: spectatorsOf(room).map((s) => ({ id: s.id, nickname: s.nickname })),
    players: room.players.map((pp) => ({
      id: pp.id,
      nickname: pp.nickname,
      piece: pp.piece || null,
      couleur: pp.couleur || null,
      connected: pp.connected !== false,
      // La cote du compte assis (ou de celui qui a quitté le siège, qu'un bot
      // finit pour lui) : le registre agrandi l'affiche à côté du score.
      ...coteDuSiege(pp),
      handCount: pp.hand ? pp.hand.length : 0,
      tricksWon: pp.tricksWon || 0,
      // Les chiffres cumulés ne révèlent aucune information sur la manche en
      // cours : ils ne décrivent que les manches déjà terminées. Ils servent
      // au registre agrandi, afin qu'il offre le même bilan que la fin de
      // partie sans attendre le dernier tour.
      recap: playerRecap(pp),
      hasBid: room.bids ? Object.prototype.hasOwnProperty.call(room.bids, pp.id) : false,
      // Les annonces sont cachées tant que tout le monde n'a pas choisi : on
      // ne révèle que la sienne (pour confirmer son propre choix) pendant la
      // phase d'annonce ; une fois révélées (phase 'playing' et après),
      // elles sont toutes visibles d'un coup, jamais avant.
      bid: room.bids && (!bidding || pp.id === p.id) ? room.bids[pp.id] : undefined,
      revealedCard: blindRound1 && pp.id !== p.id && pp.hand && pp.hand[0]
        ? pp.hand[0]
        : undefined,
    })),
    // Historique du chat : renvoyé avec l'état pour qu'une reconnexion ou un
    // arrivant en cours de partie retrouve la conversation.
    chat: room.chat || [],
    // Qui mène/mènera le pli en cours (fixé dès la donne, avant même
    // l'annonce) - permet de savoir "qui commence" dès la phase d'annonce,
    // pas seulement une fois la phase de jeu entamée. C'est la seule chose
    // que le tapis marque d'un jeton : le donneur n'en a plus, personne ne
    // jouant en fonction de qui distribue, et room.dealerIndex ne sert donc
    // plus qu'ici, à faire tourner l'entame d'une manche à l'autre.
    //
    // C'est le premier de l'ordre de jeu RÉEL, et pas room.leaderIndex tout
    // court : celui qui a posé une Dernière Salve et remporte l'avant-dernier
    // pli n'a plus de carte pour le dernier. Son voisin de gauche entame à sa
    // place (voir activeOrderThisTrick), et le jeton doit passer chez lui —
    // il restait sinon sur un siège qui n'a rien à jouer.
    leaderPlayerId: inRound && activeOrderThisTrick(room)[0] ? activeOrderThisTrick(room)[0].id : null,
    roundNumber: roundNumber(room),
    totalRounds: room.roundSequence.length,
    cardsInRound: room.cardsInRound,
    scoreboard: scoreboard(room),
    // Les extensions retenues : elles ne changent plus une fois la partie
    // lancée, mais un joueur qui se reconnecte n'a peut-être jamais vu le
    // salon — et les règles affichées en cours de partie s'y accordent.
    extensions: extensionsOf(room),
    // Le paquet retenu dans le salon : il habille les cartes jusqu'à la fin
    // de la partie, y compris pour un joueur qui se reconnecte en cours de
    // route et n'a jamais vu le salon.
    deckStyle: sanitizeDeckStyle(room.deckStyle),
    // Joueurs actuellement liés par une alliance Butin sur cette manche :
    // remonté en direct (et plus seulement dans le résumé de fin de manche)
    // pour qu'un pictogramme reste affiché à côté des alliés jusqu'au bout
    // de la manche, une fois l'alliance formée.
    lootAllies: inRound
      ? [...new Set((room.lootAlliances || []).flatMap((a) => [a.lootPlayerId, a.winnerId]))]
      : [],
  };

  if (inRound) {
    // Sa propre carte reste cachée pendant l'annonce de la manche 1 : un
    // repère de dos de carte (même id, aucune autre info) plutôt que
    // simplement l'omettre, pour que la main ne paraisse pas vide.
    base.hand = blindRound1 ? p.hand.map((c) => ({ id: c.id, kind: 'hidden' })) : p.hand;
    base.myBid = room.bids ? room.bids[p.id] : undefined;
    // Ce que la manche rapportera si SON contrat est tenu : le cadre « Gain »
    // le recompose côté client à partir de l'annonce, de ces trois nombres et
    // du numéro de manche. Les siens seulement — un joueur n'a pas à lire les
    // captures des autres avant la fin de la manche, et le tapis les lui a de
    // toute façon montrées pli par pli.
    base.myPendingBonus = p.pendingBonus || 0;
    base.myRascalStake = p.rascalStake || 0;
    // Les +20 de Butin, comptés comme endRound les paiera si les deux alliés
    // tiennent : 20 par alliance où l'on figure, de chaque côté — un joueur
    // à la fois poseur et gagnant (Dernière Salve) touche les deux.
    base.myLootBonus = (room.lootAlliances || []).reduce(
      (s, a) => s + (a.lootPlayerId === p.id ? 20 : 0) + (a.winnerId === p.id ? 20 : 0),
      0
    );
  }
  if (room.phase === 'playing' || room.phase === 'power') {
    // La Tigresse annonce son choix EN SE POSANT, comme dans la règle
    // officielle : on la déclare Pirate ou Fuite au moment de la jouer, et
    // tout le monde l'entend. Le bluff est dans le choix, pas dans le secret.
    //
    // Le choix était caché aux autres joueurs jusqu'à la résolution du pli.
    // C'était plus tendu et c'était faux : une Tigresse posée sans marque ne
    // dit pas si le pli est pris ou abandonné, et c'est précisément ce qu'il
    // faut savoir pour choisir sa propre carte. Les suivants jouaient à
    // l'aveugle sur la seule carte du jeu qui change de nature en se posant —
    // ils ne pouvaient même pas s'en rendre compte, puisque rien à l'écran ne
    // signalait qu'il y avait quelque chose à savoir.
    base.currentTrick = room.currentTrick;
    const turnPlayer = playerAtTurn(room);
    base.turnPlayerId = turnPlayer ? turnPlayer.id : null;
    base.isMyTurn = room.phase === 'playing' && !room.trickPaused && turnPlayer && turnPlayer.id === p.id;
    base.trickNumber = room.trickNumber;
    const preview = currentTrickPreview(room);
    base.leadingPlayerId = preview.leaderId;
    base.leadingCardId = preview.leaderCardId;
    base.trickWillBeDestroyed = preview.destroyed;
    base.trickDestroyedBy = preview.destroyedBy;
    base.trickNeutralisedCardIds = preview.neutralisedCardIds;
    base.trickPaused = Boolean(room.trickPaused);
    base.lastTrickResult = room.trickPaused ? room.lastTrickResult : null;
    // Dernière Salve : ce joueur n'a tout simplement pas de carte à jouer
    // ce pli-ci (autre chose qu'"attendre son tour normalement" - le client
    // affiche un message dédié plutôt qu'une attente silencieuse).
    base.sittingOutThisTrick = !!room.sittingOutIds && room.sittingOutIds.has(p.id);
    // Pouvoir de Mary Thorne : une carte précise de SA main a été tirée au
    // sort pour lui - toute autre carte devient injouable tant que ce
    // n'est pas fait, peu importe la couleur imposée.
    base.forcedCardId = room.forcedPlays ? room.forcedPlays[p.id] : undefined;
  }
  if (room.phase === 'power' && room.pendingPower) {
    const pending = room.pendingPower;
    const mine = pending.playerId === p.id;
    base.pendingPower = {
      kind: pending.kind,
      playerId: pending.playerId,
      mine,
      revealCards: mine ? pending.revealCards : undefined,
      drawnCardIds: mine ? pending.drawnCardIds : undefined,
      options:
        mine && (pending.kind === 'rosie' || pending.kind === 'marythorne')
          ? room.players.map((pp) => ({ id: pp.id, nickname: pp.nickname, handCount: pp.hand.length }))
          : undefined,
      currentBid: mine && pending.kind === 'harry' ? room.bids[pending.playerId] : undefined,
      // Marcher sur la Planche : les Pirates du pli complet parmi lesquels
      // choisir. Envoyé au seul joueur de la Planche - les autres voient le
      // bandeau, pas la liste.
      plankTargetIds: mine && pending.kind === 'plank' ? pending.plankTargetIds : undefined,
      // Ce qu'il reste à Juanita Jade pour regarder, en millisecondes.
      revealMs:
        mine && pending.kind === 'juanita' && pending.revealUntil
          ? Math.max(0, pending.revealUntil - Date.now())
          : undefined,
    };
  }
  if (room.phase === 'round-end') {
    base.roundSummary = room.lastRoundSummary;
    base.roundEndMs = paceMs(room, 'roundEnd');
  }
  if (room.phase === 'game-end') {
    base.finalRanking = room.finalRanking;
    // Classée ou non : le récap le dit, sinon on chercherait sa nouvelle
    // cote après une partie entre invités.
    base.rated = Boolean(room.rated);
  }
  return base;
}

// L'état seul, à tout le monde : sans relancer ni le rappel d'inactivité ni
// les bots. C'est ce qu'il faut quand seul le bord de la table change (un
// spectateur arrive ou s'en va) — relancer les bots leur ferait jouer deux
// fois le même coup.
function emitState(io, room) {
  for (const p of destinataires(room)) {
    io.to(p.id).emit('skullking-state', stateFor(room, p));
  }
  for (const s of spectatorsOf(room)) {
    io.to(s.id).emit('skullking-state', stateFor(room, spectatorView(s)));
  }
}

function broadcastState(io, room) {
  emitState(io, room);
  scheduleInactivityCheck(io, room);
  // Les bots « voient » l'état par ce même point de passage : ils
  // n'ont pas de vraie socket pour recevoir l'événement ci-dessus.
  if (bots) bots.driveBots(io, room, stateFor);
}

// Voir la constante INACTIVITY_WARN_MS : seule la phase 'playing', hors
// pause de révélation de pli, a un joueur unique dont c'est vraiment le tour.
// Le délai est réglable dans le salon, et « Jamais » (0) éteint le rappel : on
// ne programme alors rien du tout plutôt que de programmer un rappel immédiat.
function scheduleInactivityCheck(io, room) {
  clearTimeout(room.inactivityTimer);
  room.inactivityTimer = null;
  if (room.phase !== 'playing' || room.trickPaused) return;
  const delai = paceMs(room, 'inactivity');
  if (!delai) return;
  const playerId = playerAtTurn(room).id;
  room.inactivityTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    if (room.phase !== 'playing' || room.trickPaused) return;
    if (playerAtTurn(room).id !== playerId) return;
    const player = findPlayer(room, playerId);
    if (!player || player.connected === false) return; // déjà couvert par la bannière de déconnexion
    broadcastToRoom(io, room, 'skullking-inactivity-notice', { id: playerId, nickname: player.nickname });
  }, delai);
}

function endRound(io, room) {
  const num = roundNumber(room);
  const exactness = {};
  const summary = room.players.map((p) => {
    const bid = room.bids[p.id];
    const made = p.tricksWon;
    const exact = made === bid;
    exactness[p.id] = exact;
    const { base, bonus } = computeRoundScoreBreakdown(bid, made, num, p.pendingBonus);
    return { id: p.id, nickname: p.nickname, bid, made, base, bonus, rascalDelta: 0, lootBonus: 0, delta: base + bonus };
  });

  // Mise secondaire de Rascal le Flambeur : gagnée si SA propre annonce de
  // manche est exacte, perdue sinon.
  summary.forEach((s) => {
    const player = findPlayer(room, s.id);
    if (player.rascalStake) {
      const rascalDelta = exactness[s.id] ? player.rascalStake : -player.rascalStake;
      s.rascalDelta = rascalDelta;
      s.delta += rascalDelta;
    }
  });

  // Bonus Butin : +20 chacun si le poseur ET le gagnant du pli réussissent
  // TOUS LES DEUX leur annonce de manche exactement. Le lien est en revanche
  // remonté dès qu'une alliance s'est FORMÉE, réussie ou non (avec le drapeau
  // `paid`) : n'afficher que les alliances payantes le rendait quasi invisible
  // en vrai, alors que c'est justement ce qu'on veut voir se produire.
  const lootLinks = [];
  const seenLootPairs = new Set();
  room.lootAlliances.forEach(({ lootPlayerId, winnerId }) => {
    const paid = Boolean(exactness[lootPlayerId] && exactness[winnerId]);
    if (paid) {
      const lootEntry = summary.find((s) => s.id === lootPlayerId);
      const winEntry = summary.find((s) => s.id === winnerId);
      if (lootEntry) {
        lootEntry.lootBonus += 20;
        lootEntry.delta += 20;
      }
      if (winEntry) {
        winEntry.lootBonus += 20;
        winEntry.delta += 20;
      }
    }
    const pairKey = [lootPlayerId, winnerId].sort().join('|');
    if (!seenLootPairs.has(pairKey)) {
      seenLootPairs.add(pairKey);
      lootLinks.push({ a: lootPlayerId, b: winnerId, paid });
    }
  });

  summary.forEach((s) => {
    const player = findPlayer(room, s.id);
    player.totalScore += s.delta;
    player.roundHistory.push({ round: num, bid: s.bid, made: s.made, delta: s.delta, total: player.totalScore });
  });

  room.roundIndex += 1;
  if (room.roundIndex >= room.roundSequence.length) {
    finishGame(io, room, { complete: true });
    return;
  }

  room.lastRoundSummary = {
    round: num,
    results: summary.map(({ id, nickname, bid, made, base, bonus, rascalDelta, lootBonus, delta }) => ({
      id,
      nickname,
      bid,
      made,
      base,
      bonus,
      rascalDelta,
      lootBonus,
      delta,
    })),
    lootLinks,
  };
  room.phase = 'round-end';
  broadcastState(io, room);

  room.roundEndTimer = setTimeout(() => {
    if (rooms.get(room.code) === room && room.phase === 'round-end') advanceRound(io, room);
  }, paceMs(room, 'roundEnd'));
}

// Fin de la pause de révélation d'un pli (ou d'un pouvoir de pirate) : le
// meneur passé en paramètre entame le pli suivant, ou la manche se termine
// si c'était le dernier.
function finishTrickCollection(io, room, leaderId) {
  room.currentTrick = [];
  room.trickPaused = false;
  room.pendingPower = null;
  room.pendingPowerQueue = null;
  room.lastTrickResult = null;
  room.lastWinningCard = null;
  room.leaderIndex = room.players.findIndex((p) => p.id === leaderId);
  room.turnCount = 0;
  room.trickNumber += 1;
  // Dernière Salve : celui qui l'a posée a joué DEUX cartes dans le même
  // pli. Il lui en manque donc une, et le pli qu'il ne peut pas jouer est le
  // DERNIER de la manche — pas le suivant, comme on le faisait. Le livret de
  // l'extension le dit ainsi (« That player will then skip the final trick of
  // the round »), et c'est de toute façon ce que l'arithmétique impose : on
  // ne fabrique pas un tour de pause, on constate qu'une main est vide.
  //
  // La liste est figée à l'OUVERTURE du pli, pas recalculée en cours de
  // route : un joueur qui pose sa dernière carte au milieu d'un pli verrait
  // sinon sa main se vider et disparaîtrait de l'ordre de jeu en plein pli.
  room.extraCardOwedBy = null;
  room.sittingOutIds = new Set(room.players.filter((p) => !(p.hand || []).length).map((p) => p.id));

  if (room.trickNumber > room.cardsInRound) {
    endRound(io, room);
    return;
  }
  room.phase = 'playing';
  broadcastState(io, room);
}

// Ouvre la phase d'action d'un pouvoir de pirate. `leaderId` est le meneur
// par défaut du pli suivant (le gagnant du pli) — seule Rosie la Douce peut
// le changer.
function startPiratePower(io, room, powerKey, playerId, leaderId) {
  room.pendingPower = { kind: powerKey, playerId, leaderId };

  if (powerKey === 'will') {
    const drawn = room.residualPile.splice(0, 2);
    findPlayer(room, playerId).hand.push(...drawn);
    // Mémorisé pour que le client puisse mettre en évidence CES deux cartes
    // précisément (le choix de défausse porte sur toute la main, mais sans
    // repère on ne sait plus lesquelles viennent d'arriver).
    room.pendingPower.drawnCardIds = drawn.map((c) => c.id);
  }
  if (powerKey === 'juanita') {
    room.pendingPower.revealCards = [...room.residualPile];
  }

  room.phase = 'power';
  broadcastState(io, room);

  if (powerKey === 'juanita') {
    // L'échéance, et pas seulement le minuteur : l'écran affiche une barre
    // qui se vide, et elle doit dire le temps qui reste VRAIMENT — y compris
    // à un joueur qui se reconnecte au milieu du pouvoir, ou dont l'onglet
    // était en arrière-plan. Le temps restant est recalculé à chaque état
    // envoyé plutôt que d'expédier une date : les horloges des deux machines
    // n'ont aucune raison d'être d'accord, la durée si.
    const regard = paceMs(room, 'juanita');
    room.pendingPower.revealUntil = Date.now() + regard;
    room.powerTimer = setTimeout(() => {
      if (rooms.get(room.code) === room && room.phase === 'power') resolvePowerDone(io, room);
    }, regard);
  }
}

// Résumé en clair de la décision prise avec ce pouvoir, diffusé à toute la
// table avant de ramasser le pli - sans ça, seul le joueur qui a utilisé le
// pouvoir sait ce qu'il vient de se passer.
// Annonce d'un pouvoir de Pirate, en deux morceaux : le pirate concerné (le
// titre de la bannière) et ce qu'il vient de changer. Renvoie null quand il
// n'y a rien à annoncer aux autres.
function powerResultMessage(room) {
  const pending = room.pendingPower;
  const player = findPlayer(room, pending.playerId);
  const name = player ? player.nickname : '?';
  switch (pending.kind) {
    case 'rosie': {
      const leader = findPlayer(room, pending.leaderId);
      const leaderName = leader ? (leader.id === pending.playerId ? 'soi-même' : leader.nickname) : '?';
      return {
        title: "Rosie la Douce",
        detail: `${name} désigne ${leaderName} pour mener le prochain pli.`,
      };
    }
    // Will et Juanita ne changent rien de visible pour les autres : l'un
    // remanie sa propre main, l'autre ne fait que regarder. Pas d'annonce -
    // seuls les pouvoirs qui pèsent sur la suite de la manche en méritent
    // une (qui mène, quelle annonce, quelle carte imposée).
    case 'will':
    case 'juanita':
      return null;
    case 'rascal': {
      const stake = player ? player.rascalStake || 0 : 0;
      return {
        title: 'Rascal le Flambeur',
        detail:
          stake > 0
            ? `${name} mise ${stake} points de plus sur sa propre annonce.`
            : `${name} ne mise rien de plus cette manche.`,
      };
    }
    case 'harry': {
      // Ne rien changer est un vrai choix — c'est même souvent le bon, et le
      // bouton existe pour ça. « modifie son annonce (±0) » disait donc le
      // contraire de ce qui venait de se passer, et laissait les autres
      // chercher ce qui avait bougé. Même chose quand le minuteur expire sans
      // réponse : rien n'a bougé, on le dit.
      const delta = pending.harryDelta || 0;
      const newBid = room.bids[pending.playerId];
      const detail = delta === 0
        ? `${name} ne bouge pas son annonce : elle reste à ${newBid}.`
        : `${name} ${delta > 0 ? 'monte' : 'descend'} son annonce d'un pli : ${newBid - delta} → ${newBid}.`;
      return { title: 'Harry le Géant', detail };
    }
    case 'marythorne': {
      const target = findPlayer(room, pending.marythorneTargetId);
      const targetName = target ? (target.id === pending.playerId ? 'sa propre main' : `la main de ${target.nickname}`) : '?';
      return {
        title: 'Mary Thorne',
        detail: `${name} tire une carte au hasard dans ${targetName}, à jouer obligatoirement au pli suivant.`,
      };
    }
    default:
      return null;
  }
}

function resolvePowerDone(io, room) {
  const leaderId = room.pendingPower.leaderId;
  const playerId = room.pendingPower.playerId;
  const announce = powerResultMessage(room);
  if (announce) broadcastToRoom(io, room, 'skullking-power-result', announce);
  // Skull King : plusieurs pouvoirs de Pirates capturés à résoudre à la
  // suite (file constituée à la résolution du pli, voir plus bas) - on
  // enchaîne sur le suivant avant de ramasser le pli pour de bon, en
  // conservant le meneur déjà éventuellement changé par un pouvoir
  // précédent de la même file (ex: Rosie la Douce).
  if (room.pendingPowerQueue && room.pendingPowerQueue.length) {
    const nextKey = room.pendingPowerQueue.shift();
    startPiratePower(io, room, nextKey, playerId, leaderId);
    return;
  }
  // Dernier pli de la manche : on laisse l'annonce se lire avant que la
  // planche de fin de manche ne prenne l'écran. Elle tient exactement le temps
  // d'un pli sur le tapis (réglage 'trick') : ailleurs le cadre s'affiche
  // par-dessus le pli suivant qui s'installe et personne ne le coupe, mais sur
  // le dernier `finishTrickCollection` enchaînait sur `endRound` dans la foulée
  // du broadcast, et la planche de fin de manche recouvrait l'annonce avant
  // qu'on ait lu de quel Pirate il s'agissait.
  //
  // Le pouvoir est marqué résolu avant l'attente : pendant cette pause la
  // manche est encore en phase `power`, et un second envoi du même pouvoir
  // (double clic, client rejoué) repasserait sinon `guardPower` et
  // relancerait un timer par-dessus le premier. On le marque plutôt que de
  // le retirer, pour que le bandeau du pouvoir reste affiché derrière le
  // cadre d'annonce au lieu de disparaître au milieu de la lecture.
  if (announce && room.trickNumber === room.cardsInRound) {
    room.pendingPower.resolved = true;
    room.trickTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room) return;
      finishTrickCollection(io, room, leaderId);
    }, paceMs(room, 'trick'));
    return;
  }
  finishTrickCollection(io, room, leaderId);
}

function advanceRound(io, room) {
  clearRoomTimers(room);
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  startRound(io, room);
}

function clearRoomTimers(room) {
  clearTimeout(room.roundEndTimer);
  clearTimeout(room.trickTimer);
  clearTimeout(room.powerTimer);
  clearTimeout(room.inactivityTimer);
  room.roundEndTimer = null;
  room.trickTimer = null;
  room.powerTimer = null;
  room.inactivityTimer = null;
}

// Récap de fin de partie : le classement seul ne raconte rien de la partie
// qu'on vient de jouer. On dérive de l'historique des manches (déjà tenu à
// jour manche après manche) de quoi se comparer autrement que par le score :
// combien d'annonces tenues, combien de plis pris, la meilleure et la pire
// manche, la plus longue série.
// Qui est assis, du point de vue du classement : un compte (avec sa cote du
// moment), un invité, ou un bot. Un siège quitté en cours de route garde la
// cote de celui qui est parti — c'est lui que la partie classe, pas le bot.
function coteDuSiege(p) {
  const isBot = Boolean(bots && bots.isBot(p.id));
  // accountPseudo : le nom du compte derrière le siège. Il diffère du pseudo
  // affiché quand le joueur s'est choisi un autre nom pour la table — la
  // cote, elle, reste celle du compte.
  if (p.leaver) {
    return {
      elo: p.leaver.userId ? p.leaver.elo : null,
      accountPseudo: p.leaver.userId ? p.leaver.pseudo || null : null,
      isGuest: !p.leaver.userId,
      isBot: false,
    };
  }
  if (p.userId) return { elo: p.elo, accountPseudo: p.accountPseudo || null, isGuest: false, isBot };
  return { elo: null, accountPseudo: null, isGuest: !isBot, isBot };
}

function playerRecap(p) {
  const h = p.roundHistory || [];
  const exact = h.filter((r) => r.made === r.bid).length;
  const tricks = h.reduce((sum, r) => sum + (r.made || 0), 0);
  // Une annonce à zéro tenue est le pari le plus risqué du jeu : il vaut la
  // peine de dire combien de fois on l'a réussi.
  const zeros = h.filter((r) => r.bid === 0 && r.made === 0).length;
  let streak = 0;
  let bestStreak = 0;
  h.forEach((r) => {
    if (r.made === r.bid) {
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else {
      streak = 0;
    }
  });
  const best = h.reduce((b, r) => (b === null || r.delta > b.delta ? r : b), null);
  const worst = h.reduce((b, r) => (b === null || r.delta < b.delta ? r : b), null);
  return {
    id: p.id,
    nickname: p.nickname,
    // La pièce sert à colorer la courbe des scores : même repère que sur le
    // tapis, on retrouve sa ligne sans lire la légende.
    piece: p.piece || null,
    // …et c'est la COULEUR qui la peint : celle du joueur, pas celle du motif.
    couleur: p.couleur || null,
    // A quitté en cours de route : un bot a fini la partie à sa place.
    left: Boolean(p.leaver),
    // La cote AVANT le calcul de fin (rateGame y ajoute ensuite `elo`, avec
    // l'avant, l'après et l'écart, quand la partie est classée) : le récap
    // donne ainsi la cote de chaque compte, classée ou non.
    cote: coteDuSiege(p).elo,
    accountPseudo: coteDuSiege(p).accountPseudo,
    isBot: coteDuSiege(p).isBot,
    total: p.totalScore,
    rounds: h.length,
    exact,
    tricks,
    zeros,
    bestStreak,
    bestRound: best ? { round: best.round, delta: best.delta } : null,
    worstRound: worst ? { round: worst.round, delta: worst.delta } : null,
    // Score cumulé après chaque manche, pour tracer la courbe de la partie.
    curve: h.map((r) => ({ round: r.round, total: r.total })),
  };
}

function finishGame(io, room, { complete = false } = {}) {
  clearRoomTimers(room);
  // Celui qui a quitté est compté dernier, quoi qu'ait marqué le bot qui a
  // fini sa main : il ne remporte pas une partie qu'il a abandonnée.
  const ranking = [...room.players]
    .map(playerRecap)
    .sort((a, b) => Number(a.left) - Number(b.left) || b.total - a.total);
  room.rated = complete ? rateGame(io, room, ranking) : false;
  room.finalRanking = ranking;
  room.phase = 'game-end';
  broadcastState(io, room);
}

// La partie classée : seulement une partie menée à son terme (ni arrêtée par
// l'hôte, ni interrompue par un départ), et seulement entre comptes — il en
// faut au moins deux à table. Invités et bots jouent, marquent leurs points,
// mais ne comptent pas dans les duels. Le calcul est fait tout de suite, sur
// les cotes connues à table, pour que le récap les affiche sans attendre la
// base ; l'écriture part ensuite.
function rateGame(io, room, ranking) {
  if (!comptes || ESSAI) return false;
  // Un siège compte pour le compte qui y est assis, ou pour celui qui l'a
  // quitté en cours de route (un bot l'a fini) : ce dernier est classé
  // derrière tout le monde, quel que soit le score de son siège.
  const seen = new Set();
  const rated = [];
  room.players.forEach((p) => {
    let entry = null;
    if (p.leaver && p.leaver.userId) {
      entry = { seat: p, userId: p.leaver.userId, elo: p.leaver.elo, score: -Infinity, left: true };
    } else if (p.userId && !p.gone && !(bots && bots.isBot(p.id))) {
      entry = { seat: p, userId: p.userId, elo: p.elo, score: p.totalScore, left: false };
    }
    if (!entry || seen.has(entry.userId)) return;
    seen.add(entry.userId);
    rated.push(entry);
  });
  if (rated.length < 2) return false;
  const restes = room.players.filter((p) => !p.leaver);
  const topScore = Math.max(...(restes.length ? restes : room.players).map((p) => p.totalScore));
  const changes = computeEloChanges(rated.map((e) => ({ userId: e.userId, elo: e.elo, score: e.score })));
  const byUser = new Map(changes.map((c) => [c.userId, c]));
  // Les cotes connues ailleurs que sur le siège : la socket (apprise à la
  // connexion) et, pour un partant, sa chaise de spectateur. On les tient à
  // jour, sinon la revanche partirait de l'ancienne.
  const majCote = (userId, elo) => {
    const s = spectatorsOf(room).find((x) => x.userId === userId);
    if (s && s.account) s.account.elo = elo;
    const ids = [s && s.id, ...room.players.filter((p) => p.userId === userId).map((p) => p.id)];
    ids.forEach((id) => {
      const sock = id && io.sockets && io.sockets.sockets ? io.sockets.sockets.get(id) : null;
      if (sock && sock.data.user) sock.data.user.elo = elo;
    });
  };
  rated.forEach((e) => {
    const c = byUser.get(e.userId);
    const entry = ranking.find((r) => r.id === e.seat.id);
    if (entry) entry.elo = { before: c.before, after: c.after, delta: c.delta };
    if (e.left) e.seat.leaver.elo = c.after;
    else e.seat.elo = c.after;
    majCote(e.userId, c.after);
  });
  comptes
    .applyGameResult({
      rounds: room.roundSequence ? room.roundSequence.length : 0,
      results: rated.map((e) => ({
        userId: e.userId,
        delta: byUser.get(e.userId).delta,
        won: !e.left && e.score === topScore,
      })),
      // Le pseudo de table ET celui du compte : un nom de table ne dit pas,
      // relu des mois plus tard, à quel compte la partie a compté.
      // L'id du compte en plus : c'est lui que relit le profil (courbe de la
      // cote, duels contre chacun), même si le pseudo change un jour.
      summary: ranking.map((r) => ({
        userId: (rated.find((e) => e.seat.id === r.id) || {}).userId || null,
        nickname: r.nickname,
        account: r.accountPseudo || null,
        total: r.total,
        left: r.left || false,
        elo: r.elo || null,
      })),
    })
    .then((after) => {
      // La base fait foi : si une autre partie du même joueur s'est finie
      // entre-temps, sa cote réelle n'est pas celle calculée ici.
      rated.forEach((e) => {
        if (!after || after[e.userId] == null) return;
        if (!e.left) e.seat.elo = after[e.userId];
        majCote(e.userId, after[e.userId]);
      });
    })
    .catch((err) => console.error('[skullking] classement non enregistré', err));
  return true;
}

function startGame(io, room) {
  assignMissingPieces(room);
  room.roundSequence = ESSAI_CARTES
    ? Array.from({ length: clampRounds(room.totalRounds) }, () => ESSAI_CARTES)
    : buildRoundSequence(room.totalRounds);
  room.roundIndex = 0;
  // Le donneur de la première manche est tiré au sort, comme au Rami : il
  // était figé sur le premier de la liste, donc le meneur du tout premier pli
  // (dealerIndex + 1, voir startRound) était TOUJOURS le même joueur - la
  // roue de tirage n'avait alors plus rien à tirer. Le donneur tourne
  // ensuite normalement d'une manche à l'autre (advanceRound).
  room.dealerIndex = Math.floor(Math.random() * room.players.length);
  room.players.forEach((p) => {
    p.totalScore = 0;
    p.roundHistory = [];
  });
  startRound(io, room);
}

function removeFromLobby(io, room, id, verbe = 'a quitté le salon') {
  const idx = room.players.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const [removed] = room.players.splice(idx, 1);
  clearTimeout(removed.disconnectTimer);
  // Une salle où il ne reste que des bots n'a plus de raison d'exister
  // (personne ne la verra jamais) : on la ferme comme une salle vide.
  const humansLeft = room.players.filter((p) => !bots || !bots.isBot(p.id));
  if (humansLeft.length === 0) {
    clearRoomTimers(room);
    if (bots) bots.forgetRoom(room);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === id) {
    room.hostId = room.players[Math.floor(Math.random() * room.players.length)].id;
  }
  // Le seul chemin de sortie du salon : « Quitter » comme le délai de grâce
  // d'une déconnexion y passent (finalizeSkullKingDisconnect).
  pushSystemChat(io, room, `${removed.nickname} ${verbe}.`);
  broadcastToRoom(io, room, 'skullking-player-left', { nickname: removed.nickname });
  broadcastLobby(io, room);
}

// Même choix que l'Ascenseur : un départ définitif en pleine partie (délai
// de grâce expiré, ou "Quitter" explicite) met fin à la partie pour tout le
// monde, classement sur le score courant — retirer un seul joueur casserait
// l'ordre des plis et la main déjà distribuée des autres.
// L'hôte renvoie un joueur humain du salon. Le renvoyé est prévenu et rendu
// à l'accueil ; son jeton est retenu pour que le lien ne le rassoie pas à la
// seconde (voir skullking-join-room). Le jeton vit dans le navigateur, ce
// n'est donc pas un bannissement à toute épreuve — juste de quoi qu'un
// renvoi ne s'annule pas d'un clic sur le même lien.
function kickFromLobby(io, room, id) {
  const player = findPlayer(room, id);
  if (!player || id === room.hostId || (bots && bots.isBot(id))) return false;
  if (player.token) {
    if (!room.kickedTokens) room.kickedTokens = new Set();
    room.kickedTokens.add(player.token);
  }
  // Un compte débarqué ne revient pas non plus par un autre onglet.
  if (player.userId) {
    if (!room.kickedUserIds) room.kickedUserIds = new Set();
    room.kickedUserIds.add(player.userId);
  }
  io.to(id).emit('skullking-kicked');
  const sock = io.sockets && io.sockets.sockets ? io.sockets.sockets.get(id) : null;
  if (sock) sock.data.skullkingRoom = null;
  removeFromLobby(io, room, id, 'a été débarqué par le capitaine');
  return true;
}

function finalizeSkullKingDisconnect(io, room, id, reason) {
  const player = findPlayer(room, id);
  if (!player) return;

  if (room.phase === 'lobby') {
    removeFromLobby(io, room, id);
    return;
  }

  // Un départ volontaire en pleine partie ne l'arrête plus pour les autres :
  // un bot reprend le siège et la partie continue (voir remplacerParUnBot).
  if (reason === 'left' && remplacerParUnBot(io, room, player)) return 'spectator';

  // Marqué parti AVANT toute émission : ni l'annonce de son départ ni le
  // classement qu'il déclenche ne doivent lui revenir (voir destinataires).
  player.gone = true;

  // Plus personne pour regarder : la salle n'a plus de raison d'exister.
  if (humanPlayersLeft(room).length === 0 && spectatorsOf(room).length === 0) {
    closeRoom(room);
    return;
  }

  // Le dernier joueur s'en va et il ne reste que des spectateurs : personne
  // ne lancerait plus la revanche à leur place, la salle revient d'elle-même
  // au salon et ils s'y assoient.
  if (humanPlayersLeft(room).length === 0) {
    if (bots) bots.forgetRoom(room);
    if (room.phase !== 'game-end') finishGame(io, room);
    backToLobby(io, room);
    return;
  }

  // La partie est déjà finie et tout le monde est sur le récap : le départ
  // ne change plus rien au classement, inutile de le rejouer.
  if (room.phase === 'game-end') return;

  broadcastToRoom(io, room, 'skullking-player-left', { nickname: player.nickname, reason: reason || 'left' });
  if (bots) bots.forgetRoom(room);
  finishGame(io, room);
}

function handleExplicitLeave(io, socket) {
  const code = socket.data.skullkingRoom;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.skullkingRoom = null;
  if (!room) return;
  if (findSpectator(room, socket.id)) {
    removeSpectator(io, room, socket.id);
    return;
  }
  // Resté à la table comme spectateur (un bot a pris son siège) : il la
  // regarde, l'écran le suit. Sinon il est vraiment sorti : on le lui dit,
  // pour que l'écran revienne à l'accueil.
  if (finalizeSkullKingDisconnect(io, room, socket.id, 'left') === 'spectator') {
    socket.data.skullkingRoom = code;
    return;
  }
  socket.emit('skullking-left');
}

const PHASES_EN_JEU = ['bidding', 'playing', 'power', 'round-end'];

// Celui qui quitte en pleine partie laisse son siège à un bot : mêmes cartes
// en main, même score, même place dans l'ordre du tour — la partie continue
// pour les autres comme s'il était resté. Lui passe au bord de la table, en
// spectateur : il voit la fin de la partie et se rassied à la revanche.
// Au classement, il est compté dernier (voir rateGame), quoi que fasse le
// bot de sa main : sinon on quitterait une partie mal engagée pour ne rien
// perdre.
//
// Seulement s'il reste au moins un autre humain assis : une partie entre
// bots, que plus personne ne joue, n'a pas de raison de continuer.
function remplacerParUnBot(io, room, player) {
  if (!bots || !bots.takeOverSeat) return false;
  if (!PHASES_EN_JEU.includes(room.phase)) return false;
  if (bots.isBot(player.id)) return false;
  const autresHumains = humanPlayersLeft(room).filter((p) => p !== player);
  if (autresHumains.length === 0) return false;

  const oldId = player.id;
  const botId = bots.takeOverSeat(io, room, registerSkullKingHandlers);
  clearTimeout(player.disconnectTimer);
  player.disconnectTimer = null;
  // Le partant garde son compte et sa cote pour le classement de fin.
  player.leaver = player.userId
    ? { userId: player.userId, elo: player.elo, pseudo: player.accountPseudo }
    : { userId: null };
  const account = player.userId ? { id: player.userId, pseudo: player.accountPseudo, elo: player.elo } : null;
  const token = player.token;
  // Le capitaine qui s'en va passe la barre à un humain : un bot ne lancerait
  // jamais la manche suivante ni n'arrêterait la partie.
  const etaitHote = room.hostId === oldId;
  rekeyPlayerId(room, oldId, botId);
  player.id = botId;
  player.token = botId;
  player.userId = null;
  player.connected = true;
  if (etaitHote) room.hostId = autresHumains[0].id;

  spectatorsOf(room).push({
    id: oldId,
    nickname: player.nickname,
    token,
    account,
    userId: account ? account.id : null,
    piece: player.piece || null,
    couleur: player.couleur || null,
    connected: true,
    disconnectTimer: null,
  });
  pushSystemChat(io, room, `${player.nickname} a quitté la table : un bot finit la partie à sa place.`);
  broadcastToRoom(io, room, 'skullking-player-replaced', { nickname: player.nickname });
  broadcastState(io, room);
  return true;
}

function handleDisconnecting(io, socket) {
  const code = socket.data.skullkingRoom;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.skullkingRoom = null;
  if (!room) return;

  // Un spectateur qui recharge la page revient par skullking-rejoin-room :
  // on lui garde sa chaise le temps du délai de grâce, comme à un joueur du
  // salon.
  const spectator = findSpectator(room, socket.id);
  if (spectator) {
    spectator.connected = false;
    clearTimeout(spectator.disconnectTimer);
    spectator.disconnectTimer = setTimeout(() => {
      if (rooms.get(code) === room) removeSpectator(io, room, spectator.id);
    }, DISCONNECT_GRACE_MS);
    return;
  }

  const player = findPlayer(room, socket.id);
  if (!player) return;

  player.connected = false;
  broadcastToRoom(io, room, 'skullking-player-disconnected', {
    id: player.id,
    nickname: player.nickname,
  });

  // En salon d'attente, un délai de grâce reste nécessaire (voir
  // ascenseur-room.js pour le contexte du bug qu'il corrige). En pleine
  // partie : pause indéfinie, décision réconciliée Manche 2 — seul l'hôte
  // peut choisir d'arrêter (skullking-end-game, déjà existant).
  if (room.phase === 'lobby') {
    player.disconnectTimer = setTimeout(() => {
      if (rooms.get(code) === room) finalizeSkullKingDisconnect(io, room, player.id, 'timeout');
    }, DISCONNECT_GRACE_MS);
  }
}

// Garde commune à tous les handlers de pouvoir : bonne phase, bon pouvoir en
// attente, et c'est bien à ce joueur d'agir.
function guardPower(room, socket, kind) {
  if (!room || room.phase !== 'power' || !room.pendingPower) return false;
  // Déjà résolu, on n'attend plus que la fin du temps de lecture de son
  // annonce (voir resolvePowerDone) : plus rien à envoyer.
  if (room.pendingPower.resolved) return false;
  if (room.pendingPower.kind !== kind) return false;
  return room.pendingPower.playerId === socket.id;
}

// --- LE PLI EST COMPLET : ON LE RÉSOUT --------------------------------
//
// Sorti du handler de pose parce qu'il y a désormais deux façons d'y
// arriver : la dernière carte posée, ou - quand Marcher sur la Planche a
// plusieurs Pirates sous la main - la désignation de celui qui passe
// par-dessus bord, qui vient APRÈS la dernière carte (voir
// demanderCiblePlanche).
function resoudreLePliComplet(io, room) {
  // Le pli reste affiché un instant avant d'être ramassé, sinon la dernière
  // carte posée n'apparaît jamais.
  const cards = room.currentTrick.map((t) => t.card);
  const result = resolveTrick(cards);
  let winnerId = null;
  if (!result.destroyed) {
    winnerId = room.currentTrick[result.winnerIdx].playerId;
    const winner = findPlayer(room, winnerId);
    winner.tricksWon += 1;
    winner.pendingBonus += trickBonusForWinner(cards, result.winnerIdx, result.excludedIdx);
    // Alliance Butin : chaque Butin posé par un AUTRE joueur que le
    // vainqueur forme une alliance avec lui (sauf s'il a gagné lui-même
    // via le cas exceptionnel "tout-Fuites + Butin", déjà exclu ici
    // puisque result.winnerIdx pointerait alors sur ce Butin lui-même).
    room.currentTrick.forEach((t, i) => {
      if (t.card.kind === 'loot' && i !== result.winnerIdx) {
        room.lootAlliances.push({ lootPlayerId: t.playerId, winnerId });
      }
    });
  }
  // Les +20 par Monstre englouti vont à qui a posé le Coffre, pas au
  // vainqueur du pli : le Coffre ne gagne jamais le pli, mais ses Monstres
  // lui reviennent quand même — pli remporté par un autre ou défaussé.
  if (result.monstersDestroyed) {
    const coffre = room.currentTrick.find((t) => effectiveKind(t.card) === 'davyjones');
    const poseur = coffre && findPlayer(room, coffre.playerId);
    if (poseur) poseur.pendingBonus += result.monstersDestroyed * 20;
  }
  const leaderId = room.currentTrick[result.leaderIdx].playerId;
  const devorees = devoreesParLeVainqueur(cards, result);
  room.lastTrickResult = {
    destroyed: result.destroyed,
    winnerId,
    // Qui dévore qui : le vainqueur et ce qu'il emporte (voir DEVORE).
    devourerCardId: devorees.devoreurId,
    devouredCardIds: devorees.ids,
    plankedCardIds: plankedCardIds(cards),
    davyJones: davyJonesSwallow(cards),
    // La carte qui engloutit le pli, quand c'est le Kraken : l'écran s'en
    // sert pour faire converger les autres cartes dessus.
    krakenCardId: result.krakenIdx != null && result.krakenIdx !== -1 ? cards[result.krakenIdx].id : null,
    // Le genre de la carte qui a détruit le pli, Kraken compris : c'est ce
    // que l'écran NOMME. « Le pli est détruit » sans dire par quoi laisse
    // chercher la cause dans les mauvaises cartes.
    destroyedBy: result.destroyerIdx != null && result.destroyerIdx !== -1
      ? effectiveKind(cards[result.destroyerIdx])
      : null,
    neutralisedCardIds: (result.neutralisedIdx || []).map((i) => cards[i].id),
  };
  room.lastWinningCard = result.destroyed ? null : cards[result.winnerIdx];
  room.trickPaused = true;
  broadcastState(io, room);

  room.trickTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    const isLastTrick = room.trickNumber === room.cardsInRound;
    const powerKeys = powerKeysAfterTrick(room.lastWinningCard, room.currentTrick, result.excludedIdx, isLastTrick);
    if (powerKeys.length) {
      room.pendingPowerQueue = powerKeys.slice(1);
      startPiratePower(io, room, powerKeys[0], winnerId, leaderId);
      return;
    }
    finishTrickCollection(io, room, leaderId);
  }, paceMs(room, 'trick') + (result.destroyed && result.krakenIdx >= 0 ? KRAKEN_EXTRA_MS : 0));
}

// Les pouvoirs à résoudre une fois le pli ramassé, dans l'ordre. Un Pirate
// nommé qui gagne déclenche le sien. Le Skull King hérite de celui de chaque
// Pirate classique capturé dans le même pli (retiré par la Planche exclu,
// voir excludedIdx), à résoudre à la suite les uns des autres - sans toucher
// au bonus de capture, géré à part dans trickBonusForWinner. Mat le Forban,
// lui, rafle les Pirates sans exécuter leur pouvoir : il ne gagne que le pli.
// Sur le dernier pli de la manche, seul Harry le Géant agit encore : Rascal
// n'a plus rien à miser, Rosie et Mary plus de pli suivant à régler.
function powerKeysAfterTrick(winningCard, trick, excludedIdx, isLastTrick) {
  if (!winningCard) return [];
  if (winningCard.kind === 'pirate' && winningCard.name) {
    const powerKey = PIRATE_POWER_BY_NAME[winningCard.name];
    return powerKey && (powerKey === 'harry' || !isLastTrick) ? [powerKey] : [];
  }
  if (winningCard.kind === 'skullking') return capturedPirateKeys(trick, excludedIdx, isLastTrick);
  return [];
}

// --- MARCHER SUR LA PLANCHE : LA CIBLE SE DÉSIGNE À LA FIN DU PLI ------
//
// Le livret de l'extension est explicite : « The Walk the Plank card does
// not win a trick. When played, the player must remove one standard Pirate
// AT THE END OF THE TRICK, if any are present. If multiple pirates are in a
// trick, the player chooses which one to remove, potentially changing the
// highest-ranking pirate. »
//
// À la fin du pli, donc, et pas à la pose - c'est toute la différence : un
// Pirate posé APRÈS la Planche est une cible comme les autres. On ciblait
// jusqu'ici au moment de la pose, sur le pli en cours, et la Planche jouée
// tôt dans le tour ne retirait alors personne : elle avait l'air de ne rien
// faire, et c'était bien le cas. C'est aussi la règle du Coffre de Davy
// Jones juste à côté, qui engloutit les Monstres du pli complet quel que
// soit l'ordre de pose.
//
// Trois cas : aucun Pirate (rien à faire), un seul (il n'y a rien à
// choisir, on l'impose), plusieurs (le joueur de la Planche désigne, via la
// phase de pouvoir - le pli attend). Le délai de désignation est un réglage
// de salon comme les autres (PACE_SETTINGS, clé 'plank').

function planchePosee(room) {
  return room.currentTrick.find((t) => t.card.kind === 'plank') || null;
}

// Renvoie true si le pli est mis en attente d'une désignation.
function demanderCiblePlanche(io, room) {
  const planche = planchePosee(room);
  if (!planche) return false;
  const cibles = eligiblePlankTargets(room.currentTrick);
  if (!cibles.length) return false;
  if (cibles.length === 1) {
    planche.card.removesId = cibles[0].card.id;
    return false;
  }
  room.pendingPower = {
    kind: 'plank',
    playerId: planche.playerId,
    plankTargetIds: cibles.map((t) => t.card.id),
  };
  room.phase = 'power';
  // Personne ne doit pouvoir geler la table en ne répondant pas : passé le
  // délai, c'est le premier Pirate posé qui tombe. Le pouvoir est
  // OBLIGATOIRE (« must remove one standard Pirate »), il n'y a donc pas de
  // bouton « ne rien faire » à proposer, ni de choix par défaut plus neutre
  // qu'un autre.
  room.powerTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    if (room.phase !== 'power' || !room.pendingPower || room.pendingPower.kind !== 'plank') return;
    validerCiblePlanche(io, room, room.pendingPower.plankTargetIds[0]);
  }, paceMs(room, 'plank'));
  broadcastState(io, room);
  return true;
}

function validerCiblePlanche(io, room, removesId) {
  clearTimeout(room.powerTimer);
  room.powerTimer = null;
  const planche = planchePosee(room);
  if (planche) planche.card.removesId = removesId;
  room.pendingPower = null;
  room.phase = 'playing';
  resoudreLePliComplet(io, room);
}

function backToLobby(io, room) {
  room.phase = 'lobby';
  // Ceux qui ont quitté figuraient au classement final, ils n'ont rien à
  // faire dans le salon de la revanche. Les bots qui ont fini la partie à la
  // place d'un partant non plus : le partant, lui, se rassied (il attendait
  // au bord de la table, voir seatSpectators).
  room.players.forEach((p) => {
    if (p.leaver && bots) bots.removeBot(p.id);
  });
  room.players = destinataires(room).filter((p) => !p.leaver);
  room.players.forEach((p) => {
    p.hand = [];
    p.tricksWon = 0;
    p.pendingBonus = 0;
    p.rascalStake = 0;
    p.totalScore = 0;
    p.roundHistory = [];
  });
  seatSpectators(io, room);
  if (!findPlayer(room, room.hostId) || (bots && bots.isBot(room.hostId))) {
    const humans = room.players.filter((p) => !bots || !bots.isBot(p.id));
    const pool = humans.length ? humans : room.players;
    room.hostId = pool[Math.floor(Math.random() * pool.length)].id;
  }
  broadcastLobby(io, room);
}

function newPlayer(id, nickname, token, account = null) {
  return {
    id,
    nickname,
    piece: null,
    // La couleur du joueur à table (voir donnerCouleur).
    couleur: null,
    token,
    // Le compte derrière le siège (null pour un invité ou un bot) : c'est lui
    // que la fin de partie classe.
    userId: account ? account.id : null,
    elo: account ? account.elo : null,
    // Le nom du compte, gardé à part du pseudo affiché : le joueur peut se
    // renommer pour la table sans que sa cote change de propriétaire.
    accountPseudo: account ? account.pseudo : null,
    // Les pièces gagnées par code (voir pieces-a-code.js et
    // skullking-redeem-code).
    ownedPieces: account && Array.isArray(account.pieces) ? [...account.pieces] : [],
    connected: true,
    disconnectTimer: null,
    hand: [],
    tricksWon: 0,
    pendingBonus: 0,
    rascalStake: 0,
    totalScore: 0,
    roundHistory: [],
  };
}

// Rejoindre une partie déjà lancée : on la regarde depuis le bord de la
// table, et on s'assoit au retour au salon.
function joinAsSpectator(io, socket, room, nickname, payload, account = null) {
  const token = payload && payload.token;
  // Le même appareil qui revient (page rouverte par le lien) : on reprend sa
  // place de spectateur plutôt que d'en ajouter une seconde.
  const existing = findSpectatorByToken(room, token);
  if (existing) {
    clearTimeout(existing.disconnectTimer);
    existing.disconnectTimer = null;
    existing.id = socket.id;
    existing.connected = true;
    existing.nickname = nickname;
  } else {
    spectatorsOf(room).push({
      id: socket.id,
      nickname,
      token,
      // Gardé pour le jour où il s'assied (voir seatSpectators) : sa place à
      // table doit compter pour son compte.
      account,
      userId: account ? account.id : null,
      piece: (payload && payload.piece) || null,
      couleur: (payload && payload.couleur) || null,
      connected: true,
      disconnectTimer: null,
    });
    pushSystemChat(io, room, `${nickname} regarde la partie.`);
  }
  socket.data.skullkingRoom = room.code;
  emitState(io, room);
}

function removeSpectator(io, room, id) {
  const list = spectatorsOf(room);
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [removed] = list.splice(idx, 1);
  clearTimeout(removed.disconnectTimer);
  // Plus personne pour regarder : même règle que pour les joueurs.
  if (humanPlayersLeft(room).length === 0 && list.length === 0) {
    closeRoom(room);
    return;
  }
  pushSystemChat(io, room, `${removed.nickname} ne regarde plus la partie.`);
  emitState(io, room);
}

function registerSkullKingHandlers(io, socket) {
  socket.on('skullking-create-room', (payload) => {
    const ident = identityFor(socket, payload && payload.nickname);
    if (ident.error) {
      sendError(socket, ident.error);
      return;
    }
    const { nickname, account } = ident;
    if (!nickname) {
      sendError(socket, 'Choisis un pseudo avant de créer une partie.');
      return;
    }
    const code = makeRoomCode(rooms);
    const room = {
      code,
      phase: 'lobby',
      hostId: socket.id,
      // Aucune extension au départ : le paquet de base, celui des règles
      // que tout le monde connaît. L'hôte ouvre ce qu'il veut, ligne à ligne.
      // En mode essai, tout est ouvert d'entrée : Mat le Forban, la Planche,
      // le Coffre et le Joker n'existent que dans l'extension, et c'est
      // justement ce qu'on vient éprouver.
      extensions: Object.fromEntries(EXTENSION_KEYS.map((key) => [key, ESSAI])),
      deckStyle: DEFAULT_DECK_STYLE,
      totalRounds: MAX_ROUNDS,
      // Le rythme d'origine, celui des constantes : un salon qu'on n'a pas
      // réglé se joue exactement comme avant l'existence de ces réglages.
      pace: Object.fromEntries(PACE_SETTINGS.map((r) => [r.key, r.default])),
      players: [newPlayer(socket.id, nickname, payload && payload.token, account)],
    };
    rooms.set(code, room);
    // Sa pièce est réservée avant même le premier dessin du salon (voir
    // giveFreePiece) : l'hôte en a une, elle est à lui, et le suivant ne peut
    // plus la prendre.
    giveFreePiece(room, room.players[0], payload && payload.piece, payload && payload.couleur);
    socket.data.skullkingRoom = code;
    socket.emit('skullking-room-created', { code });
    // L'hôte ouvre le fil : sans cette ligne, celui qui arrive en second lit
    // « Untel a rejoint le salon » sans savoir qui l'attendait déjà.
    pushSystemChat(io, room, `${nickname} a ouvert le salon.`);
    // Mode essai : l'équipage s'assied tout seul (voir ESSAI_BOTS). Les mêmes
    // gardes que le bouton « Ajouter un bot » — l'adaptateur doit être là, et
    // la table ne doit pas déborder.
    if (ESSAI && ESSAI_BOTS && bots) {
      const maxPlayers = maxPlayersFor(extensionsOf(room));
      for (let i = 0; i < ESSAI_BOTS && room.players.length < maxPlayers; i++) {
        addBotToRoom(io, room, ESSAI_NIVEAU);
      }
    }
    broadcastLobby(io, room);
  });

  socket.on('skullking-join-room', (payload) => {
    const code = ((payload && payload.code) || '').toUpperCase();
    const ident = identityFor(socket, payload && payload.nickname);
    const { nickname, account } = ident;
    const room = rooms.get(code);
    if (!room) {
      sendError(socket, "Cette partie n'existe pas (ou plus).");
      return;
    }
    if (ident.error) {
      sendError(socket, ident.error);
      return;
    }
    if (accountAlreadyHere(room, account, payload && payload.token)) {
      sendError(socket, 'Ton compte est déjà à cette table, dans un autre onglet.');
      return;
    }
    const kickedAccount = account && room.kickedUserIds && room.kickedUserIds.has(account.id);
    if (kickedAccount || (room.kickedTokens && payload && room.kickedTokens.has(payload.token))) {
      sendError(socket, "L'hôte t'a retiré de cette partie.");
      return;
    }
    if (room.phase !== 'lobby') {
      if (!nickname) {
        sendError(socket, 'Choisis un pseudo avant de rejoindre.');
        return;
      }
      joinAsSpectator(io, socket, room, nickname, payload, account);
      return;
    }
    const maxPlayers = maxPlayersFor(extensionsOf(room));
    if (room.players.length >= maxPlayers) {
      sendError(socket, `Cette partie est complète (${maxPlayers} joueurs max).`);
      return;
    }
    if (!nickname) {
      sendError(socket, 'Choisis un pseudo avant de rejoindre.');
      return;
    }
    room.players.push(newPlayer(socket.id, nickname, payload && payload.token, account));
    // Même règle que pour l'hôte : la pièce est prise à l'instant où il
    // s'assied, donc jamais deux fois.
    giveFreePiece(room, room.players[room.players.length - 1], payload && payload.piece, payload && payload.couleur);
    socket.data.skullkingRoom = code;
    // Après le push : broadcastToRoom parcourt room.players, et l'arrivant
    // doit lire sa propre arrivée comme les autres.
    pushSystemChat(io, room, `${nickname} a rejoint le salon.`);
    broadcastLobby(io, room);
  });

  // L'interrupteur maître : tout ou rien d'un geste. Il n'allume les huit
  // que s'il en manquait au moins une — sinon il éteint tout. C'est le geste
  // qu'on fait neuf fois sur dix, les lignes servant ensuite à s'écarter du
  // bloc. Diffusé à tous via broadcastLobby comme le reste de l'état du
  // salon, pas de système de sync dédié.
  socket.on('skullking-toggle-extension', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    const actives = extensionsOf(room);
    const toutes = EXTENSION_KEYS.every((key) => actives[key]);
    room.extensions = Object.fromEntries(EXTENSION_KEYS.map((key) => [key, !toutes]));
    // Si des extensions viennent d'être coupées et que la salle dépassait
    // déjà le plafond que le paquet réduit permet, on laisse l'hôte
    // constater l'incompatibilité via canStart plutôt que d'expulser qui que
    // ce soit.
    broadcastLobby(io, room);
  });

  // Une extension à la fois : même régime que le maître — hôte seulement,
  // lobby seulement (verrouillé dès que la partie démarre, room.extensions
  // n'est plus modifié nulle part ailleurs). Une clé inconnue est ignorée
  // plutôt que ramenée à une valeur par défaut : un message malformé ne doit
  // pas changer un réglage sous les yeux de l'hôte.
  socket.on('skullking-toggle-extension-module', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    const key = payload && payload.module;
    if (!EXTENSION_KEYS.includes(key)) return;
    const actives = extensionsOf(room);
    actives[key] = !actives[key];
    room.extensions = actives;
    broadcastLobby(io, room);
  });

  // Le paquet de cartes : hôte seulement, lobby seulement. Une fois la
  // partie lancée, room.deckStyle n'est plus modifié — il part avec chaque
  // état de jeu, ce qui suffit à habiller les cartes sans rien renégocier.
  socket.on('skullking-set-deck', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    // Une valeur inconnue est ignorée, pas ramenée au paquet par défaut :
    // un message malformé ne doit pas changer le réglage sous les yeux de
    // l'hôte. sanitizeDeckStyle reste la garde de lecture (broadcastLobby,
    // stateFor), pour un salon d'avant ce réglage.
    const style = payload && payload.deckStyle;
    if (!DECK_STYLES.includes(style) || style === room.deckStyle) return;
    room.deckStyle = style;
    broadcastLobby(io, room);
  });

  // Nombre de manches : même régime que le switch d'extension — hôte
  // seulement, lobby seulement, diffusé par broadcastLobby. Une fois la
  // partie lancée, room.roundSequence est figée et ce réglage n'a plus
  // aucun effet, donc rien à verrouiller de plus.
  socket.on('skullking-set-rounds', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    const total = clampRounds(payload && payload.totalRounds);
    if (total === room.totalRounds) return;
    room.totalRounds = total;
    broadcastLobby(io, room);
  });

  // Le rythme, réglage par réglage. Hôte seulement, salon seulement — comme
  // le paquet et les manches. Une clé ou une valeur inconnue est ignorée sans
  // bruit plutôt que ramenée à la valeur d'origine : un message malformé ne
  // doit pas changer un réglage sous les yeux de l'hôte.
  socket.on('skullking-set-pace', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    const reglage = PACE_SETTINGS.find((r) => r.key === (payload && payload.key));
    if (!reglage) return;
    const valeur = Number(payload && payload.value);
    if (!reglage.options.some((o) => o.value === valeur)) return;
    const actuel = paceOf(room);
    if (actuel[reglage.key] === valeur) return;
    room.pace = { ...actuel, [reglage.key]: valeur };
    broadcastLobby(io, room);
  });

  // Une allure toute faite : les cinq réglages d'un coup. C'est le geste que
  // fera l'immense majorité des hôtes — les lignes du dessous sont là pour
  // qui veut discuter le détail.
  socket.on('skullking-set-pace-preset', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    const preset = PACE_PRESETS.find((p) => p.key === (payload && payload.preset));
    if (!preset) return;
    room.pace = { ...preset.values };
    broadcastLobby(io, room);
  });

  // Choix de sa pièce dans le salon d'attente. Une pièce ne peut être prise
  // que par un seul joueur : c'est ce qui la rend utile pour se reconnaître
  // autour du tapis. Refusé une fois la partie lancée, pour ne pas changer
  // de figure en cours de route.
  socket.on('skullking-set-piece', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    const player = findPlayer(room, socket.id);
    if (!player) return;
    const piece = payload && payload.piece;
    if (!pieceAutorisee(room, player, piece)) return;
    if (room.players.some((p) => p.id !== socket.id && p.piece === piece)) {
      sendError(socket, 'Cette pièce est déjà prise par un autre joueur.');
      return;
    }
    player.piece = piece;
    // Le salon montre chaque pièce libre dans une couleur à elle : on la
    // prend comme on la voit. Une couleur prise entre-temps ne passe pas — le
    // joueur garde alors la sienne, et le salon redessiné le lui montre.
    const couleur = payload && payload.couleur;
    if (couleur && couleurLibre(room, player, couleur)) player.couleur = couleur;
    broadcastLobby(io, room);
  });

  // Choix de sa couleur dans le salon : une couleur n'est portée que par un
  // joueur à la fois, puisque c'est elle qui le désigne sur la roue et la
  // courbe. Refusé une fois la partie lancée, comme le motif.
  socket.on('skullking-set-couleur', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    const player = findPlayer(room, socket.id);
    if (!player) return;
    const couleur = payload && payload.couleur;
    if (!couleurValide(couleur)) return;
    if (!couleurLibre(room, player, couleur)) {
      sendError(socket, 'Cette couleur est déjà prise par un autre joueur.');
      return;
    }
    player.couleur = couleur;
    broadcastLobby(io, room);
  });

  // Un code de pièce, tapé dans le cadre « Jeton personnel » du salon. Le
  // code est consommé côté comptes (une seule fois, tous joueurs confondus) ;
  // la pièce gagnée est aussitôt mise, puisque personne d'autre ne peut la
  // porter. Le client reçoit skullking-code-ok pour jouer son grattage.
  socket.on('skullking-redeem-code', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    const player = findPlayer(room, socket.id);
    if (!player) return;
    if (!comptes || !player.userId) {
      socket.emit('skullking-code-error', 'Connecte-toi pour utiliser un code.');
      return;
    }
    if (player.redeeming) return;
    player.redeeming = true;
    const fwd = socket.handshake && socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
    const ip = (fwd && String(fwd).split(',')[0].trim()) || (socket.handshake && socket.handshake.address) || 'inconnue';
    comptes
      .redeemCode(player.userId, payload && payload.code, ip)
      .then((res) => {
        if (res.error) {
          socket.emit('skullking-code-error', res.error);
          return;
        }
        if (!player.ownedPieces) player.ownedPieces = [];
        if (!player.ownedPieces.includes(res.piece)) player.ownedPieces.push(res.piece);
        const user = socket.data && socket.data.user;
        if (user && user.id === player.userId) {
          if (!user.pieces) user.pieces = [];
          if (!user.pieces.includes(res.piece)) user.pieces.push(res.piece);
        }
        if (room.phase === 'lobby' && !room.players.some((p) => p !== player && p.piece === res.piece)) {
          player.piece = res.piece;
          // Une pièce qu'on vient de gagner se porte d'abord dans SA couleur
          // par défaut — celle du grattage. Portée par un autre joueur, on
          // garde la sienne : deux joueurs n'ont jamais la même couleur.
          const defaut = couleurParDefaut(res.piece);
          if (couleurLibre(room, player, defaut)) player.couleur = defaut;
        }
        socket.emit('skullking-code-ok', { piece: res.piece });
        broadcastLobby(io, room);
      })
      .catch((err) => {
        console.error('[skullking] code de pièce', err);
        socket.emit('skullking-code-error', 'Le serveur n’a pas pu vérifier le code, réessaie dans un instant.');
      })
      .finally(() => {
        player.redeeming = false;
      });
  });

  // Se renommer depuis le salon. Même régime que la pièce : tant que la partie
  // n'a pas commencé, chacun règle ce qui le concerne.
  //
  // LE FIL N'EST PAS RÉÉCRIT. Chaque message porte le pseudo qu'avait son
  // auteur à l'envoi (recopié dans le message, voir le handler
  // skullking-chat), et les lignes système déjà posées gardent le nom du
  // moment. Se renommer ne récrit pas ce qu'on a dit : un fil relu resterait
  // sinon cohérent avec le rôle mais faux sur ce qui s'est passé — « Paul a
  // ouvert le salon » alors que le salon a été ouvert par Marc.
  socket.on('skullking-set-nickname', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    const player = findPlayer(room, socket.id);
    if (!player) return;
    // Un compte peut se choisir un autre nom pour la table : la cote reste
    // attachée à son compte (player.userId), pas au nom affiché, et le
    // classement garde le pseudo du compte. Il peut toujours reprendre le
    // sien — c'est le seul nom réservé qu'on lui laisse.
    const nickname = sanitizeNickname(payload && payload.nickname);
    if (!nickname || nickname === player.nickname) return;
    if (comptes && comptes.isReservedPseudo(nickname, player.userId ? player.accountPseudo : null)) {
      sendError(socket, 'Ce pseudo appartient à un compte : choisis-en un autre.');
      return;
    }
    const ancien = player.nickname;
    player.nickname = nickname;
    // Le changement s'annonce à l'équipage : sans cette ligne, les messages
    // d'avant portent un nom qui n'existe plus nulle part dans le rôle, et on
    // les prend pour ceux d'un joueur parti.
    pushSystemChat(io, room, `${ancien} se fait maintenant appeler ${nickname}.`);
    broadcastLobby(io, room);
  });

  // Chat du salon : disponible à toutes les phases, y compris dans le salon
  // d'attente et entre deux manches — c'est justement là qu'on se parle.
  socket.on('skullking-chat', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room) return;
    const player = findPlayer(room, socket.id) || findSpectator(room, socket.id);
    if (!player) return;

    const text = sanitizeChatText(payload && payload.text);
    if (!text) return;

    const now = Date.now();
    // Le garde-fou anti-flood reste, mais il se tait : son refus partait en
    // `skullking-error`, et dans le salon un `skullking-error` devient un
    // toast en haut de l'écran. On écrivait deux messages coup sur coup et
    // « Doucement — un message à la fois. » venait barrer le haut du salon,
    // par-dessus le code de la partie, pour dire quelque chose que la seule
    // absence du message dit déjà. Le message est simplement écarté.
    if (chatRateLimit(player, now)) return;
    player.chatLast = now;
    player.chatTimes = [...(player.chatTimes || []), now];

    chatSeq += 1;
    const message = {
      id: `c${chatSeq}`,
      playerId: player.id,
      nickname: player.nickname,
      text,
      at: now,
    };
    room.chat = [...(room.chat || []), message].slice(-CHAT_HISTORY);
    broadcastToRoom(io, room, 'skullking-chat-message', message);
  });

  // Ajoute un joueur automatique au salon. Réservé à l'hôte et au salon
  // d'attente ; ces gardes s'appliquent aussi à l'interface déployée.
  socket.on('skullking-add-bot', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby' || !bots) return;
    if (socket.id !== room.hostId) return;
    if (room.players.length >= maxPlayersFor(extensionsOf(room))) return;
    // L'arrivée s'annonce toute seule : le bot entre par le vrai handler
    // `skullking-join-room`, qui pousse déjà « Untel a rejoint le salon. »
    // Une seconde ligne ici l'écrivait deux fois dans le fil.
    if (addBotToRoom(io, room, payload && payload.level)) broadcastLobby(io, room);
  });

  // Change le niveau d'un bot assis. Mêmes gardes que le retrait : l'hôte,
  // le salon d'attente, et une cible qui est bien un bot — un joueur humain
  // n'a pas de niveau à recevoir.
  socket.on('skullking-set-bot-level', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby' || !bots || !bots.setBotLevel) return;
    if (socket.id !== room.hostId) return;
    const playerId = payload && payload.playerId;
    if (!playerId || !bots.isBot(playerId) || !findPlayer(room, playerId)) return;
    if (bots.setBotLevel(playerId, payload.level)) broadcastLobby(io, room);
  });

  // Retire un bot du salon. Un bot ajouté par erreur bloquait la partie
  // jusqu'au bout — la salle était
  // pleine, ou le compte de joueurs faussait le nombre de cartes de la
  // dernière manche, et il n'y avait aucun moyen de revenir en arrière sans
  // refaire le salon. La garde isBot est la seule qui compte ici : ce point
  // d'entrée ne doit jamais pouvoir expulser un humain.
  socket.on('skullking-remove-bot', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby' || !bots) return;
    if (socket.id !== room.hostId) return;
    const playerId = payload && payload.playerId;
    if (!playerId || !bots.isBot(playerId)) return;
    if (!findPlayer(room, playerId)) return;
    bots.removeBot(playerId);
    removeFromLobby(io, room, playerId);
  });

  // Renvoie un joueur humain du salon. Point d'entrée distinct du retrait de
  // bot, qui reste incapable de toucher un humain. Gardes : l'hôte, le salon
  // d'attente (en pleine partie, un départ arrête tout — pas question de le
  // déclencher pour un autre), et jamais soi-même.
  socket.on('skullking-kick-player', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    const playerId = payload && payload.playerId;
    if (!playerId) return;
    kickFromLobby(io, room, playerId);
  });

  socket.on('skullking-start-game', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    const maxPlayers = maxPlayersFor(extensionsOf(room));
    if (room.players.length < MIN_PLAYERS || room.players.length > maxPlayers) return;
    recordGameStarted('skullking');
    startGame(io, room);
  });

  socket.on('skullking-rematch', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'game-end') return;
    // La revanche se lance depuis la table : un spectateur attend qu'on la
    // lance, il n'arrache pas les joueurs à leur récap.
    if (!findPlayer(room, socket.id)) return;
    backToLobby(io, room);
  });

  // Annonce simultanée : chaque joueur choisit en aveugle, la révélation a
  // lieu d'un coup pour tout le monde dès que le dernier a annoncé (voir
  // stateFor : la valeur de chaque annonce reste cachée aux autres tant que
  // room.phase==='bidding', même après avoir été reçue par le serveur).
  socket.on('skullking-bid', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'bidding') return;
    // L'annonce reste modifiable tant que la phase d'annonce n'est pas
    // terminée (donc tant que tout le monde n'a pas annoncé) - une fois
    // que tous ont choisi, la phase passe à 'playing' et ce handler ne
    // fait plus rien de toute façon.
    if (!findPlayer(room, socket.id)) return;
    const bid = Number(payload && payload.bid);
    if (!isValidBid(bid, room.cardsInRound)) {
      sendError(socket, 'Annonce invalide.');
      return;
    }
    room.bids[socket.id] = bid;
    if (allBidsIn(room)) room.phase = 'playing';
    broadcastState(io, room);
  });

  socket.on('skullking-play-card', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'playing') return;
    if (room.trickPaused) return;
    const player = playerAtTurn(room);
    if (player.id !== socket.id) {
      sendError(socket, "Ce n'est pas ton tour de jouer.");
      return;
    }
    const cardId = payload && payload.cardId;
    const card = player.hand.find((c) => c.id === cardId);
    if (!card) {
      sendError(socket, 'Carte introuvable dans ta main.');
      return;
    }
    // Pouvoir de Mary Thorne : une carte précise de sa main a été tirée au
    // sort pour ce joueur - elle prime sur toute autre règle de jouabilité
    // ("peu importe la couleur d'entame ou tout autre effet de carte").
    const forcedCardId = room.forcedPlays && room.forcedPlays[player.id];
    if (forcedCardId && cardId !== forcedCardId) {
      sendError(socket, 'Le pouvoir de Mary Thorne t\'oblige à jouer une carte précise ce pli-ci.');
      return;
    }
    if (!forcedCardId && !isCardPlayable(card, player.hand, room.currentTrick)) {
      sendError(socket, 'Tu dois suivre la couleur demandée si tu en as encore en main.');
      return;
    }
    // Seule la Tigresse demande un choix au moment de la pose (jouée comme
    // Pirate ou comme Fuite) - elle reste toujours jouable quelle que soit
    // la couleur demandée, comme toute carte spéciale.
    if (card.kind === 'tigress') {
      const chosenAs = payload && payload.chosenAs;
      if (chosenAs !== 'pirate' && chosenAs !== 'escape') {
        sendError(socket, 'Choisis si la Tigresse est jouée comme Pirate ou comme Fuite.');
        return;
      }
      card.chosenAs = chosenAs;
    }
    // 0/14 : la valeur n'est fixée qu'au moment de la pose.
    if (card.wild14 && card.value == null) {
      const declaredValue = Number(payload && payload.declaredValue);
      if (declaredValue !== 0 && declaredValue !== 14) {
        sendError(socket, 'Choisis si cette carte vaut 0 ou 14.');
        return;
      }
      card.value = declaredValue;
    }
    // Joker/Wild 15 : prend la couleur déjà imposée par le pli si elle est
    // vert/jaune/violet ; sinon (rien d'imposé encore) le joueur choisit ;
    // sinon (le noir est déjà imposé) il reste sans couleur, ce qui suffit
    // à le faire perdre face à l'atout noir (voir resolveTrick/resolveHierarchy,
    // aucun cas particulier n'y est nécessaire).
    if (card.kind === 'wild15') {
      const ledSuit = ledSuitOf(room.currentTrick);
      let chosenSuit;
      if (ledSuit === 'vert' || ledSuit === 'jaune' || ledSuit === 'violet') {
        chosenSuit = ledSuit;
      } else if (ledSuit === null) {
        const requested = payload && payload.chosenSuit;
        if (!['vert', 'jaune', 'violet'].includes(requested)) {
          sendError(socket, 'Choisis la couleur prise par le Joker (vert, jaune ou violet).');
          return;
        }
        chosenSuit = requested;
      }
      card.kind = 'number';
      card.suit = chosenSuit;
      card.value = 15;
      card.wild15 = true; // marqueur explicite pour l'affichage client, sans incidence sur la résolution
    }
    // Marcher sur la Planche : AUCUN choix à la pose. La cible se désigne
    // quand le pli est complet - voir demanderCiblePlanche.

    player.hand = player.hand.filter((c) => c.id !== cardId);
    if (forcedCardId) delete room.forcedPlays[player.id];
    room.currentTrick.push({ playerId: player.id, card });
    room.turnCount += 1;

    // Dernière Salve : sauf sur le tout dernier pli de la manche, le joueur
    // qui la pose devra encore jouer une carte après tout le monde ce
    // pli-ci, puis passera son tour au pli suivant (voir finishTrickCollection).
    if (card.kind === 'lastvolley' && room.trickNumber !== room.cardsInRound) {
      room.extraCardOwedBy = player.id;
    }

    if (room.currentTrick.length !== trickTotalCards(room)) {
      broadcastState(io, room);
      return;
    }

    // Pli complet. Marcher sur la Planche désigne sa victime maintenant,
    // et le pli attend cette réponse si plusieurs Pirates sont en lice.
    if (demanderCiblePlanche(io, room)) return;
    resoudreLePliComplet(io, room);
  });

  // Marcher sur la Planche : le joueur désigne le Pirate qui passe
  // par-dessus bord, une fois le pli complet (voir demanderCiblePlanche).
  // Le pli n'est résolu qu'après cette réponse.
  socket.on('skullking-power-plank', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'plank')) return;
    const requested = payload && payload.removesId;
    if (!room.pendingPower.plankTargetIds.includes(requested)) {
      sendError(socket, 'Choisis quel Pirate passe par-dessus bord.');
      return;
    }
    validerCiblePlanche(io, room, requested);
  });

  // Rosie la Douce : choisit qui entame le pli suivant (elle-même incluse).
  socket.on('skullking-power-rosie', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'rosie')) return;
    const targetId = payload && payload.leaderId;
    // Corrigé Manche 2 : une cible invalide restait sans aucun retour, le
    // pouvoir semblait juste ne rien faire côté client.
    if (!findPlayer(room, targetId)) {
      sendError(socket, 'Cible invalide pour Rosie la Douce.');
      return;
    }
    room.pendingPower.leaderId = targetId;
    resolvePowerDone(io, room);
  });

  // Mary Thorne : choisit un joueur (elle-même incluse) - une carte au
  // hasard de sa main lui sera imposée au pli suivant, peu importe la
  // couleur d'entame ou tout autre effet de carte à ce moment-là (voir le
  // contrôle forcedCardId dans skullking-play-card). Sans effet si la
  // cible n'a plus de carte en main (fin de manche).
  socket.on('skullking-power-marythorne', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'marythorne')) return;
    const targetId = payload && payload.targetId;
    const target = findPlayer(room, targetId);
    // Même bug que Rosie la Douce (corrigé Manche 2) : une cible invalide ne
    // renvoyait rien.
    if (!target) {
      sendError(socket, 'Cible invalide pour Mary Thorne.');
      return;
    }
    room.pendingPower.marythorneTargetId = target.id;
    if (target.hand.length > 0) {
      const picked = target.hand[Math.floor(Math.random() * target.hand.length)];
      room.forcedPlays = room.forcedPlays || {};
      room.forcedPlays[target.id] = picked.id;
    }
    resolvePowerDone(io, room);
  });

  // Will le Bandit : les 2 cartes piochées sont déjà dans sa main (ajoutées
  // à l'ouverture du pouvoir) — il doit désormais en défausser 2, parmi
  // n'importe lesquelles de sa main actuelle.
  socket.on('skullking-power-will', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'will')) return;
    const discardIds = payload && payload.discardIds;
    if (!Array.isArray(discardIds) || discardIds.length !== 2 || new Set(discardIds).size !== 2) {
      sendError(socket, 'Choisis exactement 2 cartes à défausser.');
      return;
    }
    const player = findPlayer(room, socket.id);
    const found = discardIds.map((id) => player.hand.find((c) => c.id === id));
    if (found.some((c) => !c)) {
      sendError(socket, 'Carte introuvable dans ta main.');
      return;
    }
    player.hand = player.hand.filter((c) => !discardIds.includes(c.id));
    room.residualPile.push(...found);
    resolvePowerDone(io, room);
  });

  // Rascal le Flambeur : mise secondaire 0/10/20, réglée en même temps que
  // le score de la manche (voir endRound).
  socket.on('skullking-power-rascal', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'rascal')) return;
    // Ceinture et bretelles : le pouvoir ne s'ouvre jamais sur le dernier pli
    // (voir powerKeysAfterTrick), une mise qui arriverait quand même là est
    // refusée - la manche se solde, il n'y a plus rien sur quoi parier.
    if (room.trickNumber >= room.cardsInRound) {
      sendError(socket, 'Rascal le Flambeur ne mise pas sur le dernier pli.');
      return;
    }
    const stake = Number(payload && payload.stake);
    if (![0, 10, 20].includes(stake)) {
      sendError(socket, 'Mise invalide.');
      return;
    }
    findPlayer(room, socket.id).rascalStake = stake;
    resolvePowerDone(io, room);
  });

  // Harry le Géant : modifie sa propre annonce de ±1, dans les limites de la
  // manche — seul pouvoir utilisable même après le dernier pli.
  socket.on('skullking-power-harry', (payload) => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'harry')) return;
    const delta = Number(payload && payload.delta);
    if (![-1, 0, 1].includes(delta)) {
      sendError(socket, 'Choix invalide.');
      return;
    }
    const player = findPlayer(room, socket.id);
    const newBid = room.bids[player.id] + delta;
    if (newBid < 0 || newBid > room.cardsInRound) {
      sendError(socket, 'Annonce hors limites.');
      return;
    }
    room.bids[player.id] = newBid;
    room.pendingPower.harryDelta = delta;
    resolvePowerDone(io, room);
  });

  // Juanita Jade : le joueur ferme lui-même le pouvoir quand il a fini de
  // lire (bouton « J'ai fini de regarder ») - le réglage 'juanita' est la
  // limite haute, celle que la barre du panneau décompte, et le filet qui
  // empêche une table de rester bloquée si personne n'interagit
  // (déconnexion, inactivité).
  socket.on('skullking-power-juanita-done', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!guardPower(room, socket, 'juanita')) return;
    clearTimeout(room.powerTimer);
    room.powerTimer = null;
    resolvePowerDone(io, room);
  });

  // Historique des manches jouées, à la demande : le pop-up de fin de manche
  // s'efface au bout de quelques secondes, sans ça le détail est perdu. Envoyé
  // seulement quand on l'ouvre plutôt que dans chaque broadcast d'état (10
  // manches x 9 joueurs à chaque carte posée, pour un panneau rarement ouvert).
  socket.on('skullking-request-history', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || !Array.isArray(room.roundSequence)) return;
    const playedRounds = room.players.length ? room.players[0].roundHistory.length : 0;
    const rounds = [];
    for (let i = 0; i < playedRounds; i++) {
      rounds.push({
        round: i + 1,
        cards: room.roundSequence[i],
        rows: room.players.map((p) => {
          const h = p.roundHistory[i] || {};
          return { id: p.id, nickname: p.nickname, bid: h.bid, made: h.made, delta: h.delta, total: h.total };
        }),
      });
    }
    socket.emit('skullking-history', { rounds });
  });

  socket.on('skullking-next-round', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room || room.phase !== 'round-end') return;
    if (socket.id !== room.hostId) return;
    advanceRound(io, room);
  });

  socket.on('skullking-end-game', () => {
    const room = rooms.get(socket.data.skullkingRoom);
    if (!room) return;
    if (!['bidding', 'playing', 'power', 'round-end'].includes(room.phase)) return;
    if (socket.id !== room.hostId) return;
    finishGame(io, room);
  });

  socket.on('skullking-rejoin-room', (payload) => {
    const code = ((payload && payload.code) || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('skullking-rejoin-failed', { reason: likelyServerRestart() ? 'server-restarted' : 'not-found' });
      return;
    }
    const player = findPlayerByToken(room, payload && payload.token);
    // Un spectateur qui recharge la page retrouve sa chaise au bord de la
    // table (voir handleDisconnecting).
    const spectator = !player && findSpectatorByToken(room, payload && payload.token);
    if (spectator) {
      clearTimeout(spectator.disconnectTimer);
      spectator.disconnectTimer = null;
      spectator.id = socket.id;
      spectator.connected = true;
      socket.data.skullkingRoom = code;
      socket.emit('skullking-rejoin-ok', stateFor(room, spectatorView(spectator)));
      return;
    }
    // Un joueur qui a cliqué « Quitter » a quitté : son siège ne se reprend
    // pas au rafraîchissement de la page.
    if (!player || player.gone) {
      socket.emit('skullking-rejoin-failed', { reason: 'not-found' });
      return;
    }

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    const wasDisconnected = player.connected === false;
    const oldId = player.id;
    rekeyPlayerId(room, oldId, socket.id);
    player.id = socket.id;
    player.connected = true;
    socket.data.skullkingRoom = code;

    if (room.phase === 'lobby') {
      broadcastLobby(io, room);
      return;
    }

    socket.emit('skullking-rejoin-ok', stateFor(room, player));
    if (wasDisconnected) {
      broadcastToRoom(io, room, 'skullking-player-reconnected', { id: player.id, nickname: player.nickname });
    }
  });

  socket.on('skullking-leave-room', () => handleExplicitLeave(io, socket));
  socket.on('disconnecting', () => handleDisconnecting(io, socket));
}

module.exports = {
  registerSkullKingHandlers,
  MIN_PLAYERS,
  MAX_PLAYERS,
  eligiblePlankTargets,
  demanderCiblePlanche,
  validerCiblePlanche,
  activeOrderThisTrick,
  capturedPirateKeys,
  powerKeysAfterTrick,
  devoreesParLeVainqueur,
  plankedCardIds,
  davyJonesSwallow,
  // Exporté pour éprouver à qui vont les points d'un pli (le Coffre de Davy
  // Jones paie qui le pose, pas qui ramasse).
  resoudreLePliComplet,
  powerResultMessage,
  stateFor,
  // Exporté pour pouvoir l'éprouver : la donne truquée n'est pilotée que par
  // l'environnement du serveur, elle est donc invérifiable depuis un client.
  donneTruquee,
  setBotAdapter,
  setComptesAdapter,
  rateGame,
  getStats,
  // Le départ en pleine partie : exporté pour pouvoir vérifier que celui qui
  // part ne reçoit plus rien — un handler socket ne le laisse pas voir.
  finalizeSkullKingDisconnect,
  // Le renvoi d'un joueur par l'hôte : exporté pour éprouver ses gardes.
  kickFromLobby,
  // Les spectateurs : exportés pour éprouver qu'ils ne voient aucune main et
  // qu'ils s'assoient au retour au salon.
  joinAsSpectator,
  backToLobby,
  spectatorView,
  // La pièce prise à l'arrivée : exportée pour éprouver qu'aucune n'est
  // distribuée deux fois, ce que les handlers socket ne permettent pas de
  // vérifier ici.
  giveFreePiece,
  PIECE_KEYS,
  COULEURS,
  // Le rythme : exporté pour pouvoir éprouver la garde de lecture (un salon
  // sans réglage, un réglage inconnu, une valeur hors liste) sans avoir à
  // monter un vrai salon.
  PACE_SETTINGS,
  PACE_PRESETS,
  paceOf,
  paceMs,
  pacePresetOf,
};
