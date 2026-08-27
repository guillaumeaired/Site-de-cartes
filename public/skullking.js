const socket = io();

// Les pseudos ne sont que tronqués côté serveur (sanitizeNickname), jamais
// échappés : tout pseudo inséré dans un innerHTML doit passer par ici, sinon
// un pseudo contenant du HTML s'exécute chez tous les autres joueurs de la
// table.
function escapeHTML(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function getPlayerToken() {
  let token = sessionStorage.getItem('cardGamesPlayerToken');
  if (!token) {
    token = crypto.randomUUID();
    sessionStorage.setItem('cardGamesPlayerToken', token);
  }
  return token;
}
const ACTIVE_ROOM_KEY = 'skullking:activeRoom';
function saveActiveRoom(code, nickname) {
  sessionStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify({ code, nickname }));
}
function loadActiveRoom() {
  try {
    return JSON.parse(sessionStorage.getItem(ACTIVE_ROOM_KEY));
  } catch {
    return null;
  }
}
function clearActiveRoom() {
  // Nouveau salon = nouvelle table : la préférence de pièce sera reproposée.
  piecePrefApplied = false;
  sessionStorage.removeItem(ACTIVE_ROOM_KEY);
}

// Plus d'emoji sur les cartes : dans l'éventail, chaque carte est recouverte
// par la suivante et emoji + libellé ne tenaient pas dans la bande visible
// (« Skull Kin », « Harry le Gé »). Il ne reste qu'un libellé COURT, calé
// dans cette bande - le nom complet reste dans l'infobulle au survol.
const SPECIAL_INFO = {
  pirate: { label: 'Pirate' },
  siren: { label: 'Sirène' },
  skullking: { label: 'Skull King' },
  escape: { label: 'Fuite' },
  tigress: { label: 'Tigresse' },
  loot: { label: 'Butin' },
  kraken: { label: 'Kraken' },
  whale: { label: 'Baleine' },
  // Extension
  firstmate: { label: 'Mat le Forban' },
  stingray: { label: 'Raie' },
  lastvolley: { label: 'Salve' },
  plank: { label: 'Planche' },
  davyjones: { label: 'Coffre' },
};

// Les pirates nommés portent leur nom sur la carte : raccourci à un seul mot
// distinctif, sinon rien ne tient dans la bande visible de l'éventail.
const PIRATE_SHORT_NAME = {
  "Rosie la Douce": 'Rosie',
  'Will le Bandit': 'Will',
  'Rascal le Flambeur': 'Rascal',
  'Juanita Jade': 'Juanita',
  'Harry le Géant': 'Harry',
  'Mary Thorne': 'Mary',
};
// Ce que déclenche chaque pirate nommé s'IL remporte le pli avec sa propre
// carte — affiché en infobulle sur la carte, pour savoir à quoi s'attendre
// avant même de la jouer.
const PIRATE_POWER_TEXT = {
  "Rosie la Douce": "Choisit qui entame le pli suivant (pas sur le dernier pli).",
  'Will le Bandit': 'Pioche 2 cartes non distribuées et en défausse 2 (pas sur le dernier pli).',
  'Rascal le Flambeur': "Peut miser 10 ou 20 points de plus sur sa propre annonce (pas sur le dernier pli).",
  'Juanita Jade': 'Regarde les cartes non distribuées ce tour-ci (pas sur le dernier pli).',
  'Harry le Géant': 'Modifie sa propre annonce de ±1 (même sur le dernier pli).',
  'Mary Thorne': 'Force un joueur choisi à jouer une carte aléatoire de sa main au pli suivant (pas sur le dernier pli).',
};

// Tri d'affichage de la main : par couleur (vert/jaune/violet/noir) puis
// par hauteur croissante, les cartes spéciales groupées à la fin (dans un
// ordre fixe) - purement visuel, ne change rien à la logique de jeu.
const SUIT_DISPLAY_ORDER = ['vert', 'jaune', 'violet', 'noir'];
const SPECIAL_DISPLAY_ORDER = [
  'pirate',
  'firstmate',
  'siren',
  'skullking',
  'tigress',
  'loot',
  'kraken',
  'whale',
  'stingray',
  'lastvolley',
  'plank',
  'davyjones',
  'wild15',
  'escape',
];
// Le 0/14 garde une vraie couleur dès la donne (kind:'number', value:null
// tant qu'il n'est pas déclaré) : il se trie donc avec sa famille de
// couleur comme n'importe quelle numérotée, positionné en fin de groupe
// (juste après le 14) tant que sa valeur n'est pas encore choisie.
function sortHandForDisplay(hand) {
  return [...hand].sort((a, b) => {
    const groupA = a.kind === 'number' ? SUIT_DISPLAY_ORDER.indexOf(a.suit) : 4 + SPECIAL_DISPLAY_ORDER.indexOf(a.kind);
    const groupB = b.kind === 'number' ? SUIT_DISPLAY_ORDER.indexOf(b.suit) : 4 + SPECIAL_DISPLAY_ORDER.indexOf(b.kind);
    if (groupA !== groupB) return groupA - groupB;
    if (a.kind === 'number') return (a.value ?? 14.5) - (b.value ?? 14.5);
    return 0;
  });
}

// Indice visuel de la couleur imposée (purement indicatif, le serveur reste
// seul juge à la validation) - même logique que server/skullking.js
// (ledSuitOf/mustFollowSuit/isCardPlayable), dupliquée par convention.
function ledSuitOf(trick) {
  for (const play of trick) {
    if (play.card.kind === 'number') return play.card.suit;
  }
  return null;
}
function mustFollowSuit(hand, ledSuit) {
  return ledSuit !== null && hand.some((c) => c.kind === 'number' && c.suit === ledSuit);
}
function isCardPlayable(card, hand, trick) {
  if (card.kind !== 'number') return true;
  const ledSuit = ledSuitOf(trick);
  if (ledSuit === null || card.suit === ledSuit) return true;
  return !mustFollowSuit(hand, ledSuit);
}

// Code couleur des cartes spéciales : rouge = famille Pirate (elle prend le
// pli), bleu = famille Fuite (elle y renonce). La Tigresse, qui est l'une ou
// l'autre au choix, est coupée en deux — et une fois son choix connu elle
// bascule dans la couleur correspondante (voir stateFor côté serveur : le
// choix n'est révélé aux autres qu'une fois le pli résolu).
// LES DEUX PAQUETS. Choisis par l'hôte dans le salon, purement visuels :
// aucune règle, aucun score, aucune carte n'en dépend — seul l'habillage
// change, et il change pour tout le monde en même temps (le réglage voyage
// avec l'état de jeu, pas en préférence locale, sinon deux joueurs ne
// verraient pas la même carte posée sur le tapis).
//
// Le paquet perso ne redéfinit QUE des Pirates : ce sont les seules
// illustrations maison qui existent. Tout ce qu'il ne dit pas retombe sur le
// classique — d'où un paquet perso complet dès le premier visage, sans avoir
// à peindre les 74 cartes avant de pouvoir le proposer.
//
// Les cartes gardent leur nom officiel Skull King : l'illustration habille
// la carte, elle ne la renomme pas.
const PIRATE_ART = {
  classique: {
    'Will le Bandit': 'classique-will',
    'Harry le Géant': 'classique-harry',
    "Rosie la Douce": 'classique-rosie',
    'Rascal le Flambeur': 'classique-rascal',
    'Mary Thorne': 'classique-mary',
    // Juanita Jade est bien sur la planche des spéciales : c'est la brune à
    // la boule de cristal, celle dont on croyait qu'elle était une seconde
    // Rosie. Le paquet classique est donc peint en entier, Pirates compris —
    // ne restent nus que les quatre 0/14, qu'aucune planche numérotée ne
    // contient.
    'Juanita Jade': 'classique-juanita',
  },
  perso: {
    'Harry le Géant': 'anto',
    'Juanita Jade': 'mams',
    'Rascal le Flambeur': 'guigui',
    "Rosie la Douce": 'pablo',
  },
};

// Les spéciales peintes des planches classiques. Le paquet perso n'en a
// aucune : elles habillent donc les deux paquets.
const SPECIAL_ART = {
  skullking: 'classique-skullking',
  escape: 'classique-fuite',
  kraken: 'classique-kraken',
  loot: 'classique-butin',
  whale: 'classique-baleine',
  stingray: 'classique-raie',
  tigress: 'classique-tigresse',
  firstmate: 'classique-forban',
  plank: 'classique-planche',
  davyjones: 'classique-davyjones',
  lastvolley: 'classique-salve',
  wild15: 'classique-joker',
};

// Les deux Sirènes sont identiques en règle et distinctes en peinture. Le
// serveur numérote la variante à la construction du deck (voir
// skullking.js) ; sans ce numéro, la même sirène tomberait deux fois.
const SIREN_ART = ['classique-sirene-1', 'classique-sirene-2'];

// Le paquet en cours. Tenu à jour par le salon ET par l'état de jeu : un
// joueur qui se reconnecte en pleine manche n'est jamais repassé par le
// salon.
let deckStyle = 'classique';

function setDeckStyle(style) {
  deckStyle = style === 'perso' ? 'perso' : 'classique';
}

// L'illustration d'une carte dans le paquet courant, ou null si elle n'en a
// pas (elle est alors dessinée en CSS, comme au premier jour).
function artFor(card) {
  if (card.kind === 'pirate') {
    return (PIRATE_ART[deckStyle] && PIRATE_ART[deckStyle][card.name])
      || PIRATE_ART.classique[card.name]
      || null;
  }
  if (card.kind === 'siren') return SIREN_ART[(card.variant || 1) - 1] || SIREN_ART[0];
  return SPECIAL_ART[card.kind] || null;
}

// UNE CARTE ILLUSTRÉE N'A PAS DE CARTOUCHE. Le pied de parchemin masquait le
// bas du dessin, sur toute sa largeur, pour redire ce que le dessin dit déjà
// — un nom peint dans sa banderole, un chiffre gravé dans les médaillons, ou
// un sujet qui se reconnaît sans légende. Il reste dans le document, hors
// champ : c'est lui que lisent les technologies d'assistance.
//
// Deux cartes changent d'état en cours de pli et le disaient dans ce pied :
// il fallait le remplacer, pas seulement l'enlever. La Tigresse annoncée et
// le Joker posé portent un LISERÉ de la couleur retenue (voir la CSS) — le
// signal survit au cartouche, sans rien poser sur le dessin.
function artClasses(cle) {
  return `sk-card--art sk-card--art-${cle}`;
}

// Les quatre familles illustrées, et le préfixe de leurs quatorze fichiers.
// Trois d'entre elles gravent leur chiffre dans l'illustration assez gros
// pour se passer du pied de parchemin ; les Perroquets le gardent, parce que
// leur chiffre n'est peint que dans les médaillons d'angle, et que le
// médaillon du haut passe sous la carte voisine dès que l'éventail se
// recouvre — seul le pied reste alors lisible.
const SUIT_ART = {
  jaune: 'tresor',      // le coffre ouvert
  violet: 'carte',      // la carte au trésor
  noir: 'pavillon',     // le pavillon noir — la famille d'atout
  vert: 'perroquet',    // les Perroquets
};

function cardClass(card) {
  if (card.kind === 'hidden') return 'sk-card--hidden';
  // Le Joker, avant comme après sa pose. Son 15 est peint dans les
  // médaillons ; ce qui ne l'est pas, c'est la famille qu'il déclare en se
  // posant — et elle ne l'était nulle part. Ni la fenêtre aux quatre
  // couleurs, la même quoi qu'il déclare, ni l'emblème du pied, qui se
  // peignait en carré d'encre plein faute de la classe de couleur qui lui
  // donne son masque. Un Joker posé n'annonçait donc sa famille nulle part :
  // elle ne se lisait que dans la résolution du pli. Elle est maintenant sa
  // classe de couleur, et un liseré avec elle.
  if (card.kind === 'wild15' || card.wild15) {
    const peinte = artFor({ kind: 'wild15' });
    const famille = card.suit ? ` sk-card--${card.suit} sk-card--wild15-pose` : '';
    const art = peinte ? ` ${artClasses(peinte)}` : '';
    return `sk-card--wild15${famille}${art}`;
  }
  if (card.kind === 'number') {
    if (card.wild14 && card.value == null) return 'sk-card--wild14';
    // Familles peintes : une planche d'illustrations par couleur, quatorze
    // valeurs, découpées par briefs/decouper-planche-numerotees.py. Même
    // mécanique que les Pirates
    // illustrés, à ceci près que le pied ne se surimpose que là où
    // l'illustration ne dit pas déjà son chiffre lisiblement (voir SUIT_ART) :
    // sur un Pirate il porte le nom, absent de l'illustration ; sur un Trésor
    // il redirait un chiffre déjà gravé deux fois.
    // Le 0/14 de l'extension en est exclu, quelle que soit sa famille : sa
    // valeur peut valoir 0, qui n'existe dans aucune planche, et il a déjà
    // son habillage.
    const prefixe = SUIT_ART[card.suit];
    if (prefixe && !card.wild14 && card.value >= 1 && card.value <= 14) {
      return `sk-card--${card.suit} ${artClasses(`${prefixe}-${card.value}`)}`;
    }
    return `sk-card--${card.suit}`;
  }
  if (card.kind === 'pirate' || card.kind === 'firstmate') {
    // Une carte illustrée EST son illustration : le cadre CSS est neutralisé
    // (les PNG portent déjà leur bord crème, leur bande peinte et leurs
    // médaillons d'angle), seul le cartouche de nom se surimpose.
    // Mat le Forban n'est pas un Pirate au sens des règles, mais il en a
    // l'habit et désormais sa propre planche : artFor le sert par
    // SPECIAL_ART, les Pirates nommés par la table du paquet courant.
    const art = artFor(card);
    return art ? `sk-card--pirate ${artClasses(art)}` : 'sk-card--pirate';
  }
  // La Tigresse passe AVANT la Fuite : une fois annoncée en Fuite, elle
  // reste une Tigresse à l'écran, pas un navire qui s'éloigne. Illustrée,
  // elle perd sa fenêtre coupée en deux — mais garde ses classes de choix,
  // qui lui posent alors un liseré de la couleur retenue (voir la CSS) et
  // son pied, qui dit « Tigresse Pirate » ou « Tigresse Fuite » en toutes
  // lettres. Le choix reste donc lisible, deux fois plutôt qu'une.
  if (card.kind === 'tigress') {
    const peinte = artFor(card);
    const base = 'sk-card--tigress' + (peinte ? ` ${artClasses(peinte)}` : '');
    if (card.chosenAs === 'pirate') return `${base} sk-card--tigress-pirate`;
    if (card.chosenAs === 'escape') return `${base} sk-card--tigress-escape`;
    return base;
  }
  const art = artFor(card);
  // Les classes de couleur restent posées sous l'illustration : elles ne
  // servent plus au recto (masqué), mais le halo du Skull King et la teinte
  // du dos y sont encore accrochés.
  const base = card.kind === 'escape' ? 'sk-card--escape' : `sk-card--special sk-card--k-${card.kind}`;
  return art ? `${base} ${artClasses(art)}` : base;
}

// Anatomie d'une carte : papier crème vieilli, fenêtre de couleur cerclée
// d'une dorure éraflée, et un PIED de parchemin qui porte l'indice (le
// chiffre ou le nom) plus le motif de famille. Le pied est le seul élément
// dont la lisibilité est garantie : dans l'éventail, les cartes se
// recouvrent et il ne reste que leur bande gauche. Tout ce qui identifie
// une carte vit donc en bas à gauche, jamais au centre.
function cardShell(figure, foot) {
  return (
    '<i class="sk-card__field"></i>' +
    figure +
    '<i class="sk-card__rope sk-card__rope--tl"></i>' +
    '<i class="sk-card__rope sk-card__rope--br"></i>' +
    '<i class="sk-card__seal"></i>' +
    '<span class="sk-card__foot">' + foot + '</span>'
  );
}

function cardFaceHTML(card) {
  // Ta propre carte pendant l'annonce de la manche 1 : dos de carte marqué
  // d'un « ? » pour que ce soit lisible comme un choix de règle et pas comme
  // un bug d'affichage (le contenu n'est même pas envoyé par le serveur -
  // voir stateFor, seul l'id accompagne la carte).
  if (card.kind === 'hidden') {
    return '<i class="sk-card__field"></i><span class="sk-hidden-mark">?</span>';
  }
  if (card.kind === 'wild15') {
    // Pas encore joué : sa couleur/valeur ne sont pas encore fixées.
    return cardShell('<i class="sk-card__wm"></i>', '<b class="sk-special-label">Joker</b>');
  }
  if (card.kind === 'number') {
    const suit = '<i class="sk-card__suit" aria-hidden="true"></i>';
    if (card.wild14 && card.value == null) {
      return cardShell(
        '<span class="sk-card__figure sk-card__figure--wild">0/14</span>',
        '<b class="card-emblem card-emblem--wild">0/14</b>' + suit
      );
    }
    return cardShell(
      `<span class="sk-card__figure">${card.value}</span>`,
      `<b class="card-emblem">${card.value}</b>` + suit
    );
  }
  const info = SPECIAL_INFO[card.kind];
  let label = card.kind === 'pirate' ? PIRATE_SHORT_NAME[card.name] || 'Pirate' : info.label;
  // Une fois la décision de la Tigresse connue, la carte le dit : sans ça on
  // voyait bien qu'elle avait été jouée, jamais en quoi elle s'était changée.
  // Le pied le dit pour les lecteurs d'écran ; à l'œil, c'est l'emblème
  // retenu — le même que celui du cadre de choix — frappé sur le dessin. Le
  // liseré de couleur seul ne suffisait pas : il faut savoir que rouge veut
  // dire Pirate, et à la taille d'une carte posée sur le tapis il disparaît.
  let sceau = '';
  if (card.kind === 'tigress' && card.chosenAs) {
    label = card.chosenAs === 'pirate' ? 'Tigresse Pirate' : 'Tigresse Fuite';
    sceau = '<i class="sk-card__tigresse" aria-hidden="true"></i>';
  }
  return cardShell('<i class="sk-card__wm"></i>', `<b class="sk-special-label">${label}</b>`) + sceau;
}

// Texte d'infobulle (survol). Toutes les cartes en ont une, y compris celles
// dont le comportement se résume à leur place dans la hiérarchie : il en
// manquait, et ne rien afficher laissait croire à un oubli plutôt qu'à un
// choix. Une carte sans texte n'attache simplement aucune bulle (voir
// attachPowerTooltip), ce qui ne concerne plus que le dos de carte.
function cardPowerText(card) {
  switch (card.kind) {
    case 'pirate':
      return card.name && PIRATE_POWER_TEXT[card.name]
        ? `${card.name} — s'il/elle remporte le pli : ${PIRATE_POWER_TEXT[card.name]}`
        : "Pirate — bat toutes les cartes numérotées et les Sirènes. Seul le Skull King le bat.";
    case 'siren':
      return "Sirène — bat toutes les cartes numérotées, mais perd contre un Pirate. Elle bat en revanche le Skull King : c'est la seule carte à le faire.";
    case 'skullking':
      return "Skull King — bat les Pirates et toutes les cartes numérotées, et hérite du pouvoir de chaque Pirate qu'il capture. Seule une Sirène peut le battre.";
    case 'escape':
      return "Fuite — ne remporte jamais le pli et n'impose aucune couleur. À jouer quand on veut surtout ne pas gagner. Si tout le monde fuit, la première Fuite posée ramasse.";
    case 'tigress':
      return "Tigresse — au moment de la poser, tu choisis : Pirate (elle prend le pli) ou Fuite (elle y renonce). Le choix est annoncé à toute la table dans la foulée : le bluff est dans ce que tu décides, pas dans le secret.";
    case 'loot':
      return "Butin — si un AUTRE joueur remporte le pli, vous formez une alliance : +20 points chacun si vous réussissez tous les deux votre annonce de la manche.";
    case 'kraken':
      return 'Kraken — détruit le pli : personne ne le gagne. Le pli suivant est mené par qui aurait gagné sans lui.';
    case 'whale':
      return "Baleine blanche — annule l'effet de toutes les cartes spéciales du pli : seule la valeur numérique compte, le noir perd son statut d'atout. La plus haute valeur l'emporte, et à égalité le premier à l'avoir posée.";
    case 'firstmate':
      // Trois précisions qui manquaient et qu'on ne peut pas deviner de la
      // carte : il perd contre une Sirène SEULE (un vrai Pirate la bat),
      // capturer des Pirates ne lui rapporte aucun bonus (ce privilège est
      // au seul Skull King), et il vaut +30 à qui le prend — Sirène comprise.
      return "Mat le Forban — bat tous les Pirates, perd contre le Skull King et contre une Sirène (même seule). S'il remporte le pli, il hérite du/des pouvoir(s) du/des Pirate(s) capturé(s), sans aucun bonus de points. Le Skull King ou une Sirène qui le capturent gagnent +30.";
    case 'stingray':
      return "Raie Tachetée — comme la Baleine blanche, mais c'est la carte la PLUS BASSE qui remporte le pli (à égalité, la première posée).";
    case 'lastvolley':
      // Elle ne gagne jamais — mais la carte SUPPLÉMENTAIRE qu'elle donne,
      // si : c'est tout son intérêt, et c'est ce qui fait croire que la
      // Salve a remporté le pli. Autant le dire. Le tour manqué est le
      // DERNIER pli de la manche, pas le suivant : deux cartes posées dans
      // un même pli, c'est une carte de moins pour la fin.
      return "Dernière Salve — elle ne remporte jamais le pli, mais tu poses une carte de plus après tout le monde : c'est ELLE qui peut l'emporter. Tu auras alors une carte de moins, donc tu ne joueras pas le dernier pli de la manche (sauf si tu la poses justement sur ce dernier pli : elle ne fait alors rien de plus).";
    case 'plank':
      // Trois choses que la carte ne dit pas et qu'on ne devine pas : le
      // choix est au joueur (et pas au premier Pirate posé), le Pirate retiré
      // ne compte plus pour RIEN (bonus du Skull King compris), et Mat le
      // Forban n'est pas une cible.
      return "Marcher sur la Planche — ne remporte jamais le pli. Elle envoie par-dessus bord un Pirate du pli en cours, celui que TU désignes s'il y en a plusieurs. Le Pirate retiré ne gagne plus, ne rapporte plus de bonus et son pouvoir ne se déclenche pas. Mat le Forban n'est pas une cible.";
    case 'davyjones':
      return 'Coffre de Davy Jones — ne remporte jamais le pli. Détruit tous les Monstres Marins présents (Kraken, Baleine, Raie) : +20 points par Monstre détruit.';
    case 'wild15':
      return "Joker — tu choisis sa couleur au moment de la poser (sauf si une couleur est déjà imposée). Il vaut alors 15, la plus haute valeur du jeu.";
    case 'number': {
      if (card.wild14 && card.value == null) {
        // « perd toujours » était faux : un 0 reste une carte numérotée, la
        // plus basse du paquet. Il perd contre toute autre numérotée de la
        // couleur demandée et contre l'atout noir — mais il bat les Fuites,
        // et sous la Raie Tachetée il gagne à coup sûr. C'est ça, le risque.
        return "0 ou 14 — au moment de la poser, tu décides si elle vaut 0 ou 14. À 14 c'est une carte forte (mais elle ne rapporte aucun bonus à qui la capture). À 0 c'est la carte la plus basse du paquet : elle perd contre toutes les autres numérotées, mais elle bat les Fuites — et sous la Raie Tachetée, où la plus basse l'emporte, elle remporte le pli à coup sûr.";
      }
      const noir = card.suit === 'noir';
      const base = noir
        ? 'Carte noire — le noir est atout : il bat les trois autres couleurs.'
        : 'Carte numérotée — la plus haute de la couleur demandée remporte le pli, sauf si du noir est joué (le noir est atout).';
      if (card.value === 14) return `${base} Un 14 remporté rapporte un bonus de ${noir ? 20 : 10} points si ton annonce est réussie.`;
      if (card.ext && card.value === 8) return `${base} Ce 8 d'extension rapporte +5 points à qui remporte le pli.`;
      if (card.ext && card.value === 7) return `${base} Ce 7 d'extension coûte 5 points à qui remporte le pli.`;
      return base;
    }
    default:
      return '';
  }
}

// --- Fenêtre d'explication au survol des cartes à pouvoir ---
// Le title natif du navigateur est lent à apparaître et non stylable :
// on le remplace par une bulle qui suit la souris, cohérente avec le reste
// de l'habillage du jeu.
const cardTooltip = document.getElementById('sk-card-tooltip');

function positionCardTooltip(e) {
  const pad = 16;
  const rect = cardTooltip.getBoundingClientRect();
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - pad;
  cardTooltip.style.left = `${Math.max(8, x)}px`;
  cardTooltip.style.top = `${Math.max(8, y)}px`;
}

function hideCardTooltip() {
  cardTooltip.classList.add('hidden');
}

// La bulle au survol, sur n'importe quel élément : la fiche de parchemin
// vaut pour tout ce qui demande un mot d'explication, pas seulement pour les
// cartes à pouvoir. Le title natif est laissé en place par les appelants qui
// en posent un — il sert au clavier et aux technologies d'assistance, que la
// bulle, elle, ne touche pas.
function attachTooltip(el, text) {
  el.addEventListener('mouseenter', (e) => {
    cardTooltip.textContent = text;
    cardTooltip.classList.remove('hidden');
    positionCardTooltip(e);
  });
  el.addEventListener('mousemove', positionCardTooltip);
  el.addEventListener('mouseleave', hideCardTooltip);
}

// Attache l'explication d'une carte à un élément : rien n'est fait si la
// carte n'a pas de texte particulier (numérotées hors atout/extension).
function attachPowerTooltip(el, card) {
  const text = cardPowerText(card);
  if (!text) return;
  attachTooltip(el, text);

  // Appui long : la fiche s'ouvre, la carte ne se joue pas. Le clic qui
  // suit le relâchement est avalé (voir suppressNextTap), sinon consulter
  // une carte revenait à la poser — et une pose est irréversible.
  let holdTimer = null;
  let startX = 0;
  let startY = 0;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      el.dataset.consulted = '1';
      cardTooltip.textContent = text;
      cardTooltip.classList.remove('hidden');
      positionCardTooltip({ clientX: startX, clientY: startY });
    }, 350);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }, { passive: true });
  const endHold = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (el.dataset.consulted) {
      delete el.dataset.consulted;
      suppressNextTap = true;
      setTimeout(() => { suppressNextTap = false; }, 400);
      setTimeout(hideCardTooltip, 2200);
    }
  };
  el.addEventListener('touchend', endHold);
  el.addEventListener('touchcancel', endHold);
}

// Vrai le temps qu'un appui long se termine : le clic synthétique émis
// après le relâchement ne doit pas jouer la carte qu'on venait consulter.
let suppressNextTap = false;

const screens = {
  home: document.getElementById('sk-screen-home'),
  waiting: document.getElementById('sk-screen-waiting'),
  game: document.getElementById('sk-screen-game'),
  end: document.getElementById('sk-screen-end'),
};
// --- Le centre du plateau, publié en variables CSS ---------------------
// Tout ce qui se pose PAR-DESSUS le jeu — bandeau de manche, annonce de
// pouvoir, révélation des annonces, roue de tirage, récap de manche, cadre de
// la Tigresse — est une boîte `fixed; inset: 0` centrée en flex. Le voile qui
// l'accompagne doit couvrir tout l'écran, on ne peut donc pas rétrécir la
// boîte au plateau : on laisse le centrage faire son travail sur la fenêtre,
// et on déplace la CARTE du delta entre les deux centres.
//
// Ce delta n'est jamais nul en jeu. La scène est une image à ratio fixe,
// centrée dans la fenêtre avec des bandes de part et d'autre ; et dans la
// scène, le feutre n'est pas au milieu non plus — la colonne du registre le
// pousse à gauche, la main le pousse vers le haut. Centré fenêtre, un message
// tombait donc systématiquement à droite du tapis et trop bas, par-dessus le
// registre plutôt que par-dessus le jeu.
function publierCentreDuPlateau() {
  const feutre = document.querySelector('#sk-screen-game:not(.hidden) .sk-table');
  const r = feutre && feutre.getBoundingClientRect();
  const style = document.documentElement.style;
  // Hors jeu (accueil, salon, écran de fin) il n'y a pas de plateau : le
  // delta retombe à zéro et tout se recentre sur la fenêtre, comme avant.
  if (!r || !r.width) {
    style.setProperty('--sk-plateau-dx', '0px');
    style.setProperty('--sk-plateau-dy', '0px');
    return;
  }
  style.setProperty('--sk-plateau-dx', `${Math.round(r.left + r.width / 2 - window.innerWidth / 2)}px`);
  style.setProperty('--sk-plateau-dy', `${Math.round(r.top + r.height / 2 - window.innerHeight / 2)}px`);
}

window.addEventListener('resize', publierCentreDuPlateau);

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
  publierCentreDuPlateau();
}

const toastEl = document.getElementById('sk-toast');
let toastTimer = null;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

const reconnectOverlay = document.getElementById('reconnect-overlay');

// Le serveur (hebergement gratuit) peut mettre jusqu'a ~25s a se reveiller au
// tout premier chargement apres une periode d'inactivite : sans ca, la page
// semble juste figee/cassee le temps que le socket se connecte. On reutilise
// la banniere de reconnexion existante avec un texte different, seulement le
// temps de ce tout premier connect (jamais reaffiche ensuite).
let hasConnectedOnce = false;
if (!socket.connected) {
  reconnectOverlay.textContent = "🌙 Réveil du serveur… (jusqu'à 25s au premier chargement)";
  reconnectOverlay.classList.remove('hidden');
}
socket.on('connect', () => {
  if (hasConnectedOnce) return;
  hasConnectedOnce = true;
  reconnectOverlay.classList.add('hidden');
  reconnectOverlay.textContent = 'Connexion perdue — reconnexion en cours…';
});

function showReconnectingOverlay(show) {
  reconnectOverlay.classList.toggle('hidden', !show);
}

// --- Accueil ---

const inputNickname = document.getElementById('sk-input-nickname');
const homeError = document.getElementById('sk-home-error');
const btnCreate = document.getElementById('sk-btn-create');
const formJoin = document.getElementById('sk-form-join');
const inputCode = document.getElementById('sk-input-code');
const btnRules = document.getElementById('sk-btn-rules');
const rulesModal = document.getElementById('sk-rules-modal');
const btnCloseRules = document.getElementById('sk-btn-close-rules');

function requireNickname() {
  const value = inputNickname.value.trim();
  if (!value) {
    homeError.textContent = 'Entre un pseudo avant de continuer.';
    inputNickname.focus();
    return null;
  }
  return value;
}

let myNickname = null;
let myId = null;
let rejoinFallback = null;

const btnCreateDefaultLabel = btnCreate.innerHTML;
function setCreateBusy(busy, label) {
  btnCreate.disabled = busy;
  btnCreate.innerHTML = busy ? label : btnCreateDefaultLabel;
}
if (!socket.connected) setCreateBusy(true, 'Connexion au serveur…');
socket.on('connect', () => setCreateBusy(false));
socket.on('disconnect', () => setCreateBusy(true, 'Connexion au serveur…'));

btnCreate.addEventListener('click', () => {
  const nickname = requireNickname();
  if (!nickname) return;
  homeError.textContent = '';
  myNickname = nickname;
  setCreateBusy(true, 'Création…');
  socket.emit('skullking-create-room', { nickname, token: getPlayerToken() });
});

formJoin.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = inputCode.value.trim().toUpperCase();
  const nickname = requireNickname();
  if (!nickname) return;
  if (!code) {
    homeError.textContent = 'Entre un code de partie.';
    return;
  }
  homeError.textContent = '';
  myNickname = nickname;

  const saved = loadActiveRoom();
  if (saved && saved.code === code) {
    rejoinFallback = { code, nickname };
    showReconnectingOverlay(true);
    socket.emit('skullking-rejoin-room', { code, token: getPlayerToken() });
    return;
  }
  socket.emit('skullking-join-room', { code, nickname, token: getPlayerToken() });
});

btnRules.addEventListener('click', () => rulesModal.classList.remove('hidden'));
btnCloseRules.addEventListener('click', () => rulesModal.classList.add('hidden'));

// --- Historique des manches ---
// Le pop-up de fin de manche s'efface au bout de quelques secondes : ce
// panneau permet d'y revenir. Les données ne sont demandées qu'à l'ouverture
// (voir skullking-request-history côté serveur), pas envoyées en continu.
const historyModal = document.getElementById('sk-history-modal');
const historyBody = document.getElementById('sk-history-body');
const btnHistory = document.getElementById('sk-btn-history');

btnHistory.addEventListener('click', () => {
  historyBody.innerHTML = '<p class="hint">Chargement…</p>';
  historyModal.classList.remove('hidden');
  socket.emit('skullking-request-history');
});
document.getElementById('sk-btn-close-history').addEventListener('click', () =>
  historyModal.classList.add('hidden')
);

socket.on('skullking-history', ({ rounds }) => {
  if (!rounds || !rounds.length) {
    historyBody.innerHTML = '<p class="hint">Aucune manche terminée pour l\'instant.</p>';
    return;
  }
  const players = rounds[0].rows;
  const head = players
    .map((r) => `<th>${r.id === myId ? 'Toi' : escapeHTML(r.nickname)}</th>`)
    .join('');
  // Une ligne par manche, une colonne par joueur : « plis sur annonce »
  // — la MÊME convention que sur la table, écrite en toutes lettres —, puis le
  // delta de la manche, et le cumul en petit — de quoi refaire tout le match.
  const body = rounds
    .map((r) => {
      const cells = r.rows
        .map((row) => {
          const exact = row.bid === row.made;
          const delta = row.delta >= 0 ? `+${row.delta}` : `${row.delta}`;
          return `<td class="${exact ? 'sk-hist-hit' : 'sk-hist-miss'}">
              <span class="sk-hist-bid">${row.made} sur ${row.bid}</span>
              <span class="sk-hist-delta">${delta}</span>
              <span class="sk-hist-total">${row.total}</span>
            </td>`;
        })
        .join('');
      return `<tr><th class="sk-hist-round">${r.round}<small>${r.cards} c.</small></th>${cells}</tr>`;
    })
    .join('');
  historyBody.innerHTML = `<table class="sk-hist-table">
      <thead><tr><th></th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="hint sk-hist-legend">plis sur annonce · points de la manche · cumul</p>`;
});

// --- Salon d'attente ---

const shareBlock = document.getElementById('sk-share-block');
const shareLink = document.getElementById('sk-share-link');
const shareCode = document.getElementById('sk-share-code');
const btnCopy = document.getElementById('sk-btn-copy');
const btnLeaveWaiting = document.getElementById('sk-btn-leave-waiting');
const lobbyPlayers = document.getElementById('sk-lobby-players');
const lobbyList = document.getElementById('sk-lobby-list');
const lobbyCount = document.getElementById('sk-lobby-count');
const lobbyRange = document.getElementById('sk-lobby-range');
const btnStartGame = document.getElementById('sk-btn-start-game');
const btnAddBot = document.getElementById('sk-btn-add-bot');

// Outils de test (bots) : uniquement en local ou avec ?dev dans l'URL, pour
// qu'un vrai joueur ne tombe jamais dessus.
const DEV_TOOLS =
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  new URLSearchParams(location.search).has('dev');

btnAddBot.addEventListener('click', () => socket.emit('skullking-add-bot'));
const waitingHint = document.getElementById('sk-waiting-hint');
const btnExtension = document.getElementById('sk-btn-extension');
const extensionHint = document.getElementById('sk-extension-hint');
const extList = document.getElementById('sk-ext-list');
const cardModal = document.getElementById('sk-card-modal');
const cardModalArt = document.getElementById('sk-card-modal-art');
const cardModalTitle = document.getElementById('sk-card-modal-title');
const cardModalRule = document.getElementById('sk-card-modal-rule');

function fermerFiche() {
  cardModal.classList.add('hidden');
}
document.getElementById('sk-btn-close-card').addEventListener('click', fermerFiche);
// Le fond de la modale ferme aussi : on l'ouvre pour un coup d'œil, pas pour
// s'y installer.
cardModal.addEventListener('click', (e) => {
  if (e.target === cardModal) fermerFiche();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !cardModal.classList.contains('hidden')) fermerFiche();
});
const roundsGrid = document.getElementById('sk-rounds-grid');
const roundsHint = document.getElementById('sk-rounds-hint');
const lobbyChatLog = document.getElementById('sk-lobby-chat-log');
const deckGrid = document.getElementById('sk-deck-grid');
const deckHint = document.getElementById('sk-deck-hint');

const joinModal = document.getElementById('sk-join-modal');
const joinModalNickname = document.getElementById('sk-join-modal-nickname');
const btnJoinModal = document.getElementById('sk-btn-join-modal');
const joinModalError = document.getElementById('sk-join-modal-error');

let myIsHost = false;

function goHome() {
  clearActiveRoom();
  socket.emit('skullking-leave-room');
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);
  joinModal.classList.add('hidden');
  inputNickname.value = '';
  showScreen('home');
}

btnLeaveWaiting.addEventListener('click', goHome);
document.getElementById('sk-btn-leave-game').addEventListener('click', goHome);
document.getElementById('sk-btn-leave-end').addEventListener('click', goHome);

const copyDefaultLabel = btnCopy.innerHTML;
btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareLink.value);
    btnCopy.textContent = 'Lien copié';
    setTimeout(() => (btnCopy.innerHTML = copyDefaultLabel), 1500);
  } catch {
    shareLink.select();
  }
});

socket.on('skullking-room-created', ({ code }) => {
  setCreateBusy(false);
  saveActiveRoom(code, myNickname);
  const url = `${window.location.protocol}//${window.location.host}/skullking.html?room=${code}`;
  shareLink.value = url;
  shareCode.textContent = code;
  shareBlock.classList.remove('hidden');
});

// --- Choix de sa pièce dans le salon d'attente ---
// Une pièce par joueur : celles déjà prises sont montrées barrées plutôt que
// masquées, pour qu'on voie tout de suite qui a quoi. Le dernier choix est
// gardé sur cet appareil et re-proposé à la partie suivante s'il est libre.
const PIECE_PREF_KEY = 'guimams-sk-piece';
const piecePicker = document.getElementById('sk-piece-picker');
const pieceGrid = document.getElementById('sk-piece-grid');
let piecePrefApplied = false;

function renderPiecePicker(players) {
  const me = players.find((p) => p.id === myId);
  const takenBy = new Map();
  players.forEach((p) => {
    if (p.piece) takenBy.set(p.piece, p);
  });

  // Une seule fois par salon : si la pièce gardée sur cet appareil est
  // encore libre, on la reprend sans rien demander.
  if (!piecePrefApplied && me) {
    piecePrefApplied = true;
    let pref = null;
    try {
      pref = localStorage.getItem(PIECE_PREF_KEY);
    } catch (e) {
      pref = null;
    }
    if (pref && pref !== me.piece && PIECE_BY_KEY[pref] && !takenBy.has(pref)) {
      socket.emit('skullking-set-piece', { piece: pref });
      return; // le lobby suivant redessinera avec le bon choix
    }
  }

  piecePicker.classList.remove('hidden');
  pieceGrid.innerHTML = '';
  PIECES.forEach((piece) => {
    const owner = takenBy.get(piece.key);
    const mine = owner && owner.id === myId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sk-piece-btn' + (mine ? ' sk-piece-btn--mine' : '') + (owner && !mine ? ' sk-piece-btn--taken' : '');
    btn.style.setProperty('--sk-av-color', piece.color);
    btn.disabled = Boolean(owner) && !mine;
    btn.title = owner && !mine ? `${piece.label} — pris par ${owner.nickname}` : piece.label;
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = pieceSVG(piece);
    btn.addEventListener('click', () => {
      if (btn.disabled || mine) return;
      try {
        localStorage.setItem(PIECE_PREF_KEY, piece.key);
      } catch (e) {
        /* navigation privée : le choix vaut pour cette partie, sans plus */
      }
      socket.emit('skullking-set-piece', { piece: piece.key });
    });
    pieceGrid.appendChild(btn);
  });
}

// LES BOUTONS DU BAS NE BOUGENT PLUS. « Lancer la partie » et « Ajouter un
// bot » suivent la grille du salon, dont la hauteur est celle de sa planche
// la plus haute. Passé quatre matelots c'était l'équipage : chaque arrivée
// poussait les boutons d'une ligne, et au septième il fallait défiler pour
// lancer la partie — au moment précis où tout le monde attend.
//
// La liste se borne donc à ce que les autres planches laissent : mesuré, pas
// codé en dur. La planche des extensions a déjà changé de hauteur deux fois
// (huit lignes, puis des libellés sur deux lignes), un plafond en pixels
// aurait vieilli avec elle. Avec le rôle sur deux colonnes, le plafond n'est
// atteint qu'au-delà de huit joueurs — et là, la liste défile toute seule
// plutôt que d'emporter le salon avec elle.
const GRILLE_EN_RANGEE = '(min-width: 1000px)';

// La place qu'un bloc réglable peut prendre pour que SA colonne s'arrête à
// la hauteur visée : la cible, moins tout ce que la colonne mesure en dehors
// de lui (titres, pièces, code, formulaire).
function placeDisponible(bloc, colonne, cible) {
  return cible - (colonne.offsetHeight - bloc.offsetHeight);
}

function ajusterHauteurSalon() {
  const grille = document.querySelector('.sk-lobby-grid');
  if (!grille) return;
  const equipage = grille.querySelector('.sk-lobby-col--crew');
  const pile = grille.querySelector('.sk-lobby-pile');

  // Toujours remettre à zéro d'abord : les hauteurs se mesurent sur la mise
  // en page naturelle, pas sur celle du dernier passage.
  lobbyList.style.maxHeight = '';
  if (lobbyChatLog) lobbyChatLog.style.height = '';

  // Sous 1000px les planches sont empilées : la grille fait leur somme, il
  // n'y a plus de « planche la plus haute » à ne pas dépasser.
  if (!window.matchMedia(GRILLE_EN_RANGEE).matches) return;
  const planches = [...grille.children].filter((c) => !c.classList.contains('hidden'));
  // Fenêtre trop étroite pour les quatre colonnes : elles s'enroulent sur
  // deux rangées, et il n'y a plus de hauteur commune à viser — borner les
  // blocs ne ferait que cacher des matelots et des messages pour rien.
  if (new Set(planches.map((c) => c.offsetTop)).size > 1) return;

  // La hauteur visée est celle des colonnes qu'on NE règle pas (réglages,
  // extension) : ce sont elles qui fixent la taille du salon, les deux
  // autres s'y ajustent.
  const fixes = planches.filter((c) => c !== equipage && c !== pile).map((c) => c.offsetHeight);
  if (!fixes.length) return;
  const cible = Math.max(...fixes);

  if (equipage) {
    let plafond = placeDisponible(lobbyList, equipage, cible);
    // Le plafond tombe sur un nombre entier de rangées. Au pixel près, il
    // coupait la suivante en deux et le liseré qui dépassait se lisait comme
    // une barre de défilement collée en pied de planche.
    const ligne = lobbyList.querySelector('li');
    if (ligne) {
      const ecart = parseFloat(getComputedStyle(lobbyList).rowGap) || 0;
      const pas = ligne.offsetHeight + ecart;
      if (pas > 0) plafond = Math.max(2, Math.floor((plafond + ecart) / pas)) * pas - ecart;
    }
    // Sous deux rangées de matelots, mieux vaut une planche un peu plus haute
    // qu'une liste réduite à une fente.
    if (plafond > 120) lobbyList.style.maxHeight = `${plafond}px`;
  }

  // La discussion, elle, REMPLIT ce qui reste sous le code plutôt que de s'y
  // borner : c'est ce qui met la colonne à la hauteur des autres au lieu de
  // laisser du bois nu en dessous.
  if (lobbyChatLog && pile) {
    const place = placeDisponible(lobbyChatLog, pile, cible);
    if (place > 90) lobbyChatLog.style.height = `${place}px`;
    // Le fil est collé en bas APRÈS la mesure, jamais avant. `ajouterMessage`
    // le fait déjà en posant chaque message, mais sur la hauteur d'alors —
    // celle du plancher CSS. La planche grandit juste après, le `scrollTop`
    // ne suit pas, et le dernier message se retrouvait coupé en deux au ras
    // du formulaire : on voyait « Pablo 19:00 » sans lire ce qu'il disait.
    lobbyChatLog.scrollTop = lobbyChatLog.scrollHeight;
  }
}

// Le paquet, réglé par l'hôte. Deux vignettes plutôt que deux libellés : ce
// qu'on choisit ici, ce sont des images — les nommer sans les montrer
// obligerait à lancer une partie pour savoir ce qu'on vient de prendre. La
// vignette est une vraie carte du paquet, à l'échelle.
const DECK_CHOICES = [
  {
    key: 'classique',
    label: 'Classiques',
    apercu: 'classique-will',
    hint: 'Les cartes peintes : capitaines, sirènes et navire en fuite.',
  },
  {
    key: 'perso',
    label: 'Perso',
    apercu: 'pablo',
    hint: "L'équipage maison sur les Pirates ; le reste du paquet reste classique.",
  },
];

// Chaque ligne de la planche des extensions se survole comme une carte : la
// bulle qui s'ouvre est le texte de règle de la carte elle-même, celui que
// l'infobulle affiche déjà en jeu. Rien à réécrire, rien à tenir en phase —
// il suffit de dire quelle carte représente la ligne. Les numérotées font
// exception : elles en couvrent trois d'un coup.
const EXTENSION_APERCU = {
  // Les numérotées sont la seule ligne qui n'est pas UNE carte : elle en
  // ajoute trois par couleur. D'où un texte écrit à la main, et une fiche
  // qui montre les trois d'un coup, chacune dans une famille différente
  // pour dire qu'elles arrivent dans les quatre.
  numerotees: {
    texte: "Ajoute à chaque couleur un 7, un 8 et une carte 0/14. Le 8 rapporte +5 points à qui remporte le pli, le 7 lui en coûte 5, et le 0/14 se déclare au moment de la pose : 14 est une carte forte, 0 est la plus basse du paquet — elle bat quand même les Fuites.",
    cartes: [
      { kind: 'number', suit: 'vert', value: 7, ext: true },
      { kind: 'number', suit: 'jaune', value: 8, ext: true },
      { kind: 'number', suit: 'violet', value: null, ext: true, wild14: true },
    ],
  },
  joker: { kind: 'wild15' },
  marythorne: { kind: 'pirate', name: 'Mary Thorne' },
  firstmate: { kind: 'firstmate' },
  stingray: { kind: 'stingray' },
  lastvolley: { kind: 'lastvolley' },
  plank: { kind: 'plank' },
  davyjones: { kind: 'davyjones' },
};

// Ce qu'une ligne de la planche a à montrer : une ou plusieurs cartes, et
// le texte de règle. Pour tout le monde sauf les numérotées, ce texte est
// celui de l'infobulle en jeu — rien à réécrire, rien à tenir en phase.
function ficheExtension(module) {
  const apercu = EXTENSION_APERCU[module.key];
  if (!apercu) return { cartes: [], texte: '' };
  if (apercu.cartes) return { cartes: apercu.cartes, texte: apercu.texte };
  return { cartes: [apercu], texte: cardPowerText(apercu) || '' };
}

function ouvrirFiche(titre, fiche) {
  cardModalArt.innerHTML = '';
  fiche.cartes.forEach((carte) => {
    const el = document.createElement('div');
    el.className = `sk-card ${cardClass(carte)}`;
    el.innerHTML = cardFaceHTML(carte);
    cardModalArt.appendChild(el);
  });
  // Trois cartes de front tiennent moins large qu'une seule : la fiche des
  // numérotées les réduit plutôt que d'élargir la modale.
  cardModalArt.classList.toggle('sk-card-modal-art--trio', fiche.cartes.length > 1);
  cardModalTitle.textContent = titre;
  cardModalRule.textContent = fiche.texte;
  cardModal.classList.remove('hidden');
}

// La planche des extensions : un interrupteur maître, puis une ligne par
// apport. Le maître ne s'allume que si les huit le sont — un interrupteur à
// moitié allumé mentirait sur ce qu'il y a dans le paquet. Les autres joueurs
// voient tout en lecture seule, comme le paquet et les manches.
function renderExtensionCard(extensions, modules, deckSize, maxPlayers, isHost) {
  const actives = extensions || {};
  const lignes = modules || [];
  const toutes = lignes.length > 0 && lignes.every((m) => actives[m.key]);

  btnExtension.classList.toggle('sk-extension-toggle--on', toutes);
  btnExtension.setAttribute('aria-pressed', String(toutes));
  btnExtension.disabled = !isHost;
  btnExtension.classList.toggle('sk-extension-toggle--readonly', !isHost);

  extList.innerHTML = '';
  lignes.forEach((module) => {
    const on = Boolean(actives[module.key]);
    const li = document.createElement('li');
    li.className = 'sk-ext-line';

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sk-ext-switch' + (on ? ' sk-extension-toggle--on' : '');
    b.disabled = !isHost;
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML =
      '<span class="sk-extension-toggle-track"><span class="sk-extension-toggle-knob"></span></span>' +
      `<span class="sk-ext-name">${escapeHTML(module.label)}</span>`;
    const fiche = ficheExtension(module);
    if (fiche.texte) {
      b.title = fiche.texte;
      attachTooltip(b, fiche.texte);
    }
    if (isHost) {
      b.addEventListener('click', () => socket.emit('skullking-toggle-extension-module', { module: module.key }));
    }
    li.appendChild(b);

    // Le « ? », collé au nom. La bulle de survol dit déjà la règle, mais
    // jamais à quoi la carte ressemble — et c'est la question qu'on se pose
    // en hésitant à cocher une ligne. Il reste cliquable pour tout le monde,
    // y compris ceux qui ne peuvent pas régler le paquet : consulter n'est
    // pas régler.
    if (fiche.cartes.length) {
      const q = document.createElement('button');
      q.type = 'button';
      q.className = 'sk-ext-help';
      q.textContent = '?';
      q.setAttribute('aria-label', `Voir la carte : ${module.label}`);
      q.addEventListener('click', () => ouvrirFiche(module.label, fiche));
      li.appendChild(q);
    }

    const n = document.createElement('span');
    n.className = 'sk-ext-count';
    n.textContent = `+${module.cards}`;
    li.appendChild(n);
    extList.appendChild(li);
  });

  // Le pied de planche : la seule conséquence des huit lignes qui ne se
  // devine pas en les lisant. Le plafond de joueurs sort du paquet lui-même
  // (sa taille divisée par la manche la plus chargée), pas d'une constante —
  // douze cartes de plus ouvrent un huitième siège, une seule non.
  extensionHint.textContent = `${deckSize} cartes — 3 à ${maxPlayers} joueurs`;
}

function renderDeckPicker(style, isHost) {
  const choisi = style === 'perso' ? 'perso' : 'classique';
  deckGrid.innerHTML = '';
  DECK_CHOICES.forEach((deck) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sk-deck-choice' + (deck.key === choisi ? ' is-on' : '');
    b.disabled = !isHost;
    b.setAttribute('aria-pressed', String(deck.key === choisi));
    b.innerHTML =
      `<span class="sk-deck-vignette sk-card--art-${deck.apercu}"></span>` +
      `<span class="sk-deck-nom">${deck.label}</span>`;
    if (isHost) {
      b.addEventListener('click', () => socket.emit('skullking-set-deck', { deckStyle: deck.key }));
    }
    deckGrid.appendChild(b);
  });
  const actif = DECK_CHOICES.find((d) => d.key === choisi);
  deckHint.textContent = actif ? actif.hint : '';
}

// Le nombre de manches, réglé par l'hôte. Un bouton par valeur plutôt qu'un
// menu déroulant : l'écart est de huit valeurs, et un jeton par manche dit
// directement de quoi il s'agit — c'est la même piste que celle du bandeau.
// Les autres joueurs voient le réglage en lecture seule, comme l'extension.
function renderRoundsPicker(total, mini, maxi, isHost) {
  const min = mini || 3;
  const max = maxi || 10;
  const choisi = total || max;
  roundsGrid.innerHTML = '';
  for (let n = min; n <= max; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sk-round-choice' + (n === choisi ? ' is-on' : '');
    b.textContent = n;
    b.disabled = !isHost;
    b.setAttribute('aria-pressed', String(n === choisi));
    if (isHost) {
      b.addEventListener('click', () => socket.emit('skullking-set-rounds', { totalRounds: n }));
    }
    roundsGrid.appendChild(b);
  }
  // La dernière manche est la plus longue : elle dit à elle seule la durée
  // de la partie mieux que le nombre de manches.
  roundsHint.textContent = isHost
    ? `${choisi} manches — la dernière se joue à ${choisi} cartes par joueur.`
    : `${choisi} manches.`;
}

socket.on('skullking-lobby-update', ({ code, players, hostId, isHost, canStart, minPlayers, maxPlayers, extensions, extensionModules, deckSize, deckStyle: deck, totalRounds, minRounds, maxRounds, chat, myId: id }) => {
  if (id) myId = id;
  saveActiveRoom(code, myNickname);
  showReconnectingOverlay(false);
  myIsHost = isHost;
  showScreen('waiting');
  joinModal.classList.add('hidden');
  lobbyPlayers.classList.remove('hidden');
  lobbyList.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    const piece = pieceFor(p);
    const badge = document.createElement('span');
    badge.className = 'sk-lobby-piece';
    badge.style.setProperty('--sk-av-color', piece.color);
    badge.innerHTML = pieceSVG(piece);
    li.appendChild(badge);
    // Le pseudo porte la couleur de sa pièce, comme partout ailleurs (roue,
    // courbe, récap) : sur une liste de sept lignes toutes crème, on cherchait
    // la sienne au médaillon seul, qui est petit et sombre.
    const nom = document.createElement('span');
    nom.className = 'sk-lobby-nom';
    nom.textContent = p.nickname;
    nom.style.color = couleurJoueur(p);
    li.appendChild(nom);
    if (p.id === hostId) li.classList.add('lobby-host');
    // Renvoyer un bot au port. Même régime que le bouton qui les ajoute :
    // outil de test, hôte seulement — et jamais sur un joueur humain, ce que
    // le serveur revérifie de son côté. Sans ça, un bot ajouté en trop
    // bloquait le salon jusqu'à ce qu'on le refasse.
    if (DEV_TOOLS && isHost && p.isBot) {
      const vire = document.createElement('button');
      vire.type = 'button';
      // Pas de classe sk-dev-tool ici : elle porte le cadre en pointillés du
      // bouton « Ajouter un bot », qui ferait de cette croix une case à
      // cocher géante au milieu du rôle. La condition DEV_TOOLS juste
      // au-dessus suffit à la réserver aux tests.
      vire.className = 'sk-lobby-vire';
      vire.textContent = '✕';
      vire.title = `Retirer ${p.nickname}`;
      vire.setAttribute('aria-label', `Retirer ${p.nickname}`);
      vire.addEventListener('click', () => socket.emit('skullking-remove-bot', { playerId: p.id }));
      li.appendChild(vire);
    }
    lobbyList.appendChild(li);
  });
  renderPiecePicker(players);
  lobbyCount.textContent = players.length;
  lobbyRange.textContent = `${minPlayers} à ${maxPlayers}`;

  // Extensions : cliquables par l'hôte uniquement (imposé aussi côté
  // serveur), lecture seule pour les autres - tout le monde voit le même
  // état en temps réel via ce même événement de lobby.
  renderExtensionCard(extensions, extensionModules, deckSize, maxPlayers, isHost);

  // Le paquet est appliqué tout de suite, pas seulement au lancement : les
  // vignettes du salon en sont déjà tirées.
  setDeckStyle(deck);
  renderDeckPicker(deck, isHost);

  renderRoundsPicker(totalRounds, minRounds, maxRounds, isHost);

  // Le fil est le même qu'en jeu : l'historique arrive avec le salon, et
  // ajouterMessage écarte tout seul ce qui a déjà été posé.
  renderChat({ chat });

  // Après tout le reste : le plafond se déduit de la hauteur des voisines,
  // qui dépendent du paquet, des manches et des lignes d'extension.
  ajusterHauteurSalon();

  btnStartGame.classList.toggle('hidden', !isHost);
  // Outil de test : jamais proposé aux vrais joueurs (voir DEV_TOOLS).
  btnAddBot.classList.toggle('hidden', !(DEV_TOOLS && isHost && players.length < maxPlayers));
  btnStartGame.disabled = !canStart;
  if (isHost) {
    waitingHint.textContent = canStart
      ? 'Prêt ! Lance la partie quand tu veux.'
      : `Il faut entre ${minPlayers} et ${maxPlayers} joueurs pour commencer…`;
  } else {
    waitingHint.textContent = "En attente que l'hôte lance la partie…";
  }
  // On repasse par le salon avant chaque nouvelle partie (y compris une
  // revanche) : c'est le point sûr pour réarmer la roue de tirage au sort et
  // le repère de pli déjà animé (sinon la manche 1 / pli 1 de la partie
  // suivante porterait la même clé que celui de la partie précédente).
  startRevealPlayed = false;
  lastDevouredTrick = null;
  lastPlankedTrick = null;
  lastDavyTrick = null;
  lastWonTrick = null;
});

window.addEventListener('resize', ajusterHauteurSalon);

btnExtension.addEventListener('click', () => {
  if (!myIsHost) return;
  socket.emit('skullking-toggle-extension');
});

socket.on('skullking-error', (message) => {
  setCreateBusy(false);
  if (!joinModal.classList.contains('hidden')) {
    joinModalError.textContent = message;
    btnJoinModal.disabled = false;
    return;
  }
  if (!screens.home.classList.contains('hidden')) {
    homeError.textContent = message;
    return;
  }
  showToast(message);
});

// Pouvoir de Pirate : bannière plein écran, pas un toast. Le toast est une
// ligne de texte gris tout en haut de la page - personne ne comprenait ce
// qui venait de se passer, alors qu'un pouvoir change la suite de la manche
// (qui mène, quelle annonce, quelle carte imposée). Will et Juanita n'en
// envoient pas : ils ne changent rien de visible pour les autres (voir
// powerResultMessage côté serveur).
const powerAnnounceEl = document.getElementById('sk-power-announce');
const powerAnnounceTitle = document.getElementById('sk-power-announce-title');
const powerAnnounceDetail = document.getElementById('sk-power-announce-detail');
let powerAnnounceTimer = null;

socket.on('skullking-power-result', ({ title, detail }) => {
  if (!title && !detail) return;
  clearTimeout(powerAnnounceTimer);
  powerAnnounceTitle.textContent = title || '';
  powerAnnounceDetail.textContent = detail || '';
  // Retire puis remet la classe pour rejouer l'animation quand deux pouvoirs
  // s'enchaînent (Mat le Forban ou le Skull King qui en hérite plusieurs).
  powerAnnounceEl.classList.add('hidden');
  void powerAnnounceEl.offsetWidth;
  powerAnnounceEl.classList.remove('hidden');
  powerAnnounceTimer = setTimeout(() => powerAnnounceEl.classList.add('hidden'), 3600);
});

socket.on('skullking-player-left', ({ nickname, reason }) => {
  if (reason) {
    showToast(`${nickname} a quitté la partie — retour au classement actuel.`);
  } else {
    showToast(`${nickname} a quitté le salon.`);
  }
});

btnStartGame.addEventListener('click', () => socket.emit('skullking-start-game'));

btnJoinModal.addEventListener('click', () => {
  const nickname = joinModalNickname.value.trim().slice(0, 16);
  if (!nickname) {
    joinModalError.textContent = 'Entre un pseudo avant de continuer.';
    return;
  }
  joinModalError.textContent = '';
  btnJoinModal.disabled = true;
  myNickname = nickname;
  socket.emit('skullking-join-room', { code: roomFromUrl.toUpperCase(), nickname, token: getPlayerToken() });
});

// --- Partie en cours ---

const roundIndicator = document.getElementById('sk-round-indicator');
const btnEndGame = document.getElementById('sk-btn-end-game');
const tableEl = document.getElementById('sk-table');
const trickCaptionEl = document.getElementById('sk-trick-caption');
const verdictEl = document.getElementById('sk-trick-verdict');
const verdictPieceEl = document.getElementById('sk-verdict-piece');
const verdictTexteEl = document.getElementById('sk-verdict-texte');
const turnIndicator = document.getElementById('sk-turn-indicator');
const bidChoices = document.getElementById('sk-bid-choices');
const tigressChoiceEl = document.getElementById('sk-tigress-choice');
const btnTigressPirate = document.getElementById('sk-btn-tigress-pirate');
const btnTigressEscape = document.getElementById('sk-btn-tigress-escape');
const handEl = document.getElementById('sk-hand');
const scoreboardRows = document.getElementById('sk-scoreboard-rows');
const chainEl = document.getElementById('sk-chain');
const scrollEl = document.getElementById('sk-round-scroll');
const mineEl = document.getElementById('sk-mine');
const mineNotches = document.getElementById('sk-mine-notches');
const mineValue = document.getElementById('sk-mine-v');
const mineScore = document.getElementById('sk-mine-score');

let latestState = null;
let startRevealPlayed = false;
let pendingTigressCardId = null;

// Même principe que la table de l'Ascenseur : moi toujours en bas, les
// autres répartis dans l'ordre du tour. Le 2-joueurs (absent de l'Ascenseur)
// est juste face à face.
const SEAT_POSITIONS = {
  2: [[50, 90], [50, 10]],
  3: [[50, 90], [14, 34], [86, 34]],
  4: [[50, 90], [8, 52], [50, 10], [92, 52]],
  5: [[50, 90], [7, 60], [24, 16], [76, 16], [93, 60]],
  6: [[50, 90], [6, 64], [16, 25], [50, 9], [84, 25], [94, 64]],
  7: [[50, 90], [6, 66], [13, 32], [34, 11], [66, 11], [87, 32], [94, 66]],
  // 8 et 9 joueurs : configurations légitimes dès que l'extension officielle
  // est activée (MAX_PLAYERS_EXTENDED = 9 côté serveur). Valeurs issues de
  // computeSeatPositions() ci-dessous, figées ici pour rester lisibles.
  8: [[50, 90], [10, 66], [7, 40], [23, 19], [50, 10], [77, 19], [93, 40], [90, 66]],
  9: [[50, 90], [10, 66], [7, 44], [17, 24], [38, 12], [62, 12], [83, 24], [93, 44], [90, 66]],
};

// Répartition sur une ellipse (centre 50/50, rayons 44/40 en % de la table) :
// moi toujours en bas au centre [50, 90], les autres étalés symétriquement de
// part et d'autre en laissant un large écart en bas pour ma propre main.
// Sert de calcul de repli : renvoie toujours exactement `count` positions,
// donc aucun siège ne peut se retrouver sans position, quel que soit l'effectif.
const SEAT_ELLIPSE = { cx: 50, cy: 50, rx: 44, ry: 40, startDeg: 66 };

// En paysage le tapis devient beaucoup plus large que haut : les tables figées
// ci-dessus, réglées pour un tapis presque rond de 340px, y collaient les
// sièges des extrémités au liseré (c'était la réserve laissée lors du
// correctif 8/9 joueurs). On y répartit donc les joueurs régulièrement sur
// toute l'ellipse, en partant du bas — la méthode retenue sur la maquette,
// qui tient aussi bien à 3 joueurs qu'à 9.
// Les rayons sont exprimés dans le PLAN DE JEU (u,v), pas en pixels : c'est
// surFeutre() qui les projette ensuite dans le trapèze peint. Un rayon de 50
// tombe donc pile sur le bord du feutre, quel que soit son évasement. On
// reste juste en deçà pour que le jeton morde le liseré doré sans le sauter.
const SEAT_ELLIPSE_LANDSCAPE = { cx: 50, cy: 50, rx: 47, ry: 45 };
const landscapeTable = window.matchMedia('(min-width: 1000px)');
// Sur téléphone, le tapis est étroit et les étiquettes de siège débordaient
// des deux côtés (« B… », « L… » posés hors du bois) : on resserre l'ellipse
// pour que le siège entier tienne à l'intérieur du feutre.
const narrowTable = window.matchMedia('(max-width: 680px)');
const SEAT_ELLIPSE_NARROW = { cx: 50, cy: 50, rx: 33, ry: 32 };

function computeSeatPositionsEven(count, ellipse) {
  const { cx, cy, rx, ry } = ellipse;
  const n = Math.max(1, count);
  return Array.from({ length: n }, (_, i) => {
    // i = 0 → angle droit vers le bas : moi, toujours au centre en bas.
    const angle = Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [Math.round(cx + rx * Math.cos(angle)), Math.round(cy + ry * Math.sin(angle))];
  });
}

function computeSeatPositions(count) {
  const { cx, cy, rx, ry, startDeg } = SEAT_ELLIPSE;
  const n = Math.max(1, count);
  const positions = [[cx, cy + ry]]; // moi, en bas au centre
  const others = n - 1;
  if (others > 0) {
    // On balaie l'arc startDeg → (360 - startDeg) dans le sens anti-horaire
    // (donc le voisin suivant apparaît à ma gauche, comme dans les tables ci-dessus).
    const span = 360 - 2 * startDeg;
    const step = others > 1 ? span / (others - 1) : 0;
    for (let i = 0; i < others; i++) {
      const angle = ((others > 1 ? startDeg + i * step : 180) * Math.PI) / 180;
      positions.push([
        Math.round(cx - rx * Math.sin(angle)),
        Math.round(cy + ry * Math.cos(angle)),
      ]);
    }
  }
  return positions;
}

function seatOrder(players) {
  const myIndex = players.findIndex((p) => p.id === myId);
  if (myIndex === -1) return players;
  return [...players.slice(myIndex), ...players.slice(0, myIndex)];
}

function nicknameOf(state, id) {
  const p = state.players.find((pp) => pp.id === id);
  return p ? p.nickname : '?';
}

// --- Le feutre est un trapèze ----------------------------------------
// Le plateau est peint en légère plongée : le bord du fond est plus étroit
// que celui du premier plan. Les sièges et les cartes se calculent donc
// dans un plan de jeu carré (u, v dans [0,1], v = 0 au fond), puis se
// projettent sur le feutre. Les fractions ci-dessous ont été relevées sur
// plateau-taverne.webp ; elles ne valent que parce que le fond est posé en
// `100% 100%`, l'image épousant exactement la boîte (voir skullking.css).
// Deux scènes peintes coexistent, choisies par `?scene=2` dans l'URL — le
// temps de trancher laquelle garder. Chacune a SON feutre : les fractions
// ci-dessous sont relevées sur l'image, et se tromper de jeu décale tous
// les sièges sans rien casser d'autre, donc sans qu'on s'en aperçoive.
const SCENE_V2 = new URLSearchParams(location.search).get('scene') === '2';
if (SCENE_V2) {
  document.querySelector('.sk-scene')?.classList.add('sk-scene--v2');
  document.getElementById('sk-screen-game')?.classList.add('sk-v2');
}

const FEUTRE = SCENE_V2
  ? { haut: 0, bas: 1, gHaut: 0.070, dHaut: 0.923, gBas: 0, dBas: 1 }
  : { haut: 0, bas: 1, gHaut: 0.030, dHaut: 0.904, gBas: 0, dBas: 1 };

// Rend une position en POURCENTAGES de la boîte .sk-table, prête pour
// style.left / style.top.
function surFeutre(u, v) {
  const g = FEUTRE.gHaut + (FEUTRE.gBas - FEUTRE.gHaut) * v;
  const d = FEUTRE.dHaut + (FEUTRE.dBas - FEUTRE.dHaut) * v;
  return {
    x: (g + (d - g) * u) * 100,
    y: (FEUTRE.haut + (FEUTRE.bas - FEUTRE.haut) * v) * 100,
  };
}

// Ce qui est loin est petit. Sans cette réduction, une carte posée au fond
// du tapis paraît une fois et demie celle du premier plan.
function echelleProfondeur(v) {
  return 0.72 + 0.38 * v;
}

function seatLayout(state) {
  const ordered = seatOrder(state.players);
  let positions;
  if (landscapeTable.matches) {
    positions = computeSeatPositionsEven(ordered.length, SEAT_ELLIPSE_LANDSCAPE);
  } else if (narrowTable.matches) {
    positions = computeSeatPositionsEven(ordered.length, SEAT_ELLIPSE_NARROW);
  } else {
    // On ne garde la table figée que si elle couvre vraiment tout le monde ;
    // sinon on calcule, jamais de repli partiel (source du TypeError à 8/9 joueurs).
    const tuned = SEAT_POSITIONS[ordered.length];
    positions =
      tuned && tuned.length === ordered.length ? tuned : computeSeatPositions(ordered.length);
  }
  const map = new Map();
  ordered.forEach((p, i) => map.set(p.id, positions[i]));
  return { ordered, map };
}

// Résultat de MES manches passées, accumulé au fil de la partie (le serveur
// n'envoie l'historique complet que sur demande, à l'ouverture de la modale).
// Sert à frapper les doublons du bandeau : laiton = contrat tenu, cuivre
// oxydé = raté.
const myRoundResults = new Map();

// Rang gravé dans le registre : c'est lui qui bouge d'une manche à l'autre,
// jamais la place de la ligne (voir renderScoreboard).
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];

// --- Le bandeau du haut : la mémoire ET l'horloge de la partie ---------
// Dix doublons, un par manche. Celui de la manche en cours s'ouvre sur un
// cartouche qui porte le nombre de cartes et une encoche par pli, frappée au
// fur et à mesure : c'est la seule façon de savoir combien de plis il reste
// pour tenir son contrat, information qui n'était affichée nulle part.
function renderRoundIndicator(state) {
  roundIndicator.textContent =
    `Manche ${state.roundNumber} sur ${state.totalRounds}, ${state.cardsInRound} carte` +
    `${state.cardsInRound > 1 ? 's' : ''} par joueur.`;

  // Le cartouche du bandeau : la manche en cours, en toutes lettres.
  scrollEl.innerHTML = '';
  const t = document.createElement('span');
  t.className = 'sk-scroll-t';
  t.textContent = `Manche ${state.roundNumber} — ${state.cardsInRound} carte${state.cardsInRound > 1 ? 's' : ''}`;
  scrollEl.appendChild(t);
  scrollEl.appendChild(trickNotches(state));

  // La piste : deux embouts et une alvéole par manche. La barre peinte est
  // débitée en trois pièces (barre-bout-g / barre-cellule / barre-bout-d)
  // précisément pour ça — son dessin d'origine portait dix alvéoles en dur,
  // et une partie en 5 manches en aurait laissé cinq vides.
  //
  // La matière dit tout : laiton frappé = contrat tenu, cuivre oxydé =
  // raté, laiton vierge = manche à venir, liseré gravé = manche en cours.
  // Quatre états qui se distinguent à la forme, pas seulement à la couleur.
  chainEl.innerHTML = '';
  const capG = document.createElement('i');
  capG.className = 'sk-chain-bout sk-chain-bout--g';
  chainEl.appendChild(capG);

  for (let i = 1; i <= state.totalRounds; i++) {
    const cell = document.createElement('i');
    cell.className = 'sk-chain-alveole';

    const past = myRoundResults.get(i);
    const face = i === state.roundNumber ? 'courant'
      : past === true ? 'tenu'
      : past === false ? 'rate'
      : 'vierge';
    const d = document.createElement('img');
    d.className = 'sk-dbl' + (i === state.roundNumber ? ' sk-dbl--now' : '');
    d.src = `assets/skin/doublon-${face}.webp`;
    d.alt = '';
    d.title = i === state.roundNumber
      ? `Manche ${i} — en cours`
      : past !== undefined ? `Manche ${i} : contrat ${past ? 'tenu' : 'raté'}` : `Manche ${i}`;
    cell.appendChild(d);
    chainEl.appendChild(cell);
  }

  const capD = document.createElement('i');
  capD.className = 'sk-chain-bout sk-chain-bout--d';
  chainEl.appendChild(capD);
}

// Une encoche par pli de la manche : frappée quand le pli est joué, cerclée
// de rouge pour celui qui est en cours.
function trickNotches(state) {
  const wrap = document.createElement('span');
  wrap.className = 'sk-notches';
  const current = state.phase === 'playing' || state.phase === 'power' ? state.trickNumber || 1 : 0;
  for (let t = 1; t <= state.cardsInRound; t++) {
    const n = document.createElement('i');
    if (current && t < current) n.className = 'is-won';
    else if (current && t === current) n.className = 'is-now';
    wrap.appendChild(n);
  }
  return wrap;
}

// Mon contrat, en toutes lettres et en encoches. Jamais « 1/0 » : le même
// glyphe voulait dire deux choses opposées selon l'écran où on le lisait.
function renderMine(state) {
  const me = (state.players || []).find((p) => p.id === myId);
  const row = (state.scoreboard || []).find((r) => r.id === myId);
  if (!me) {
    mineEl.classList.add('hidden');
    return;
  }
  mineEl.classList.remove('hidden');
  mineScore.textContent = row ? row.total : 0;

  mineNotches.innerHTML = '';
  if (state.phase === 'bidding' || me.bid === undefined || me.bid === null) {
    mineValue.textContent = me.hasBid ? 'annonce faite' : 'à annoncer';
    mineEl.classList.remove('sk-mine--over', 'sk-mine--exact');
    return;
  }
  mineValue.textContent = `${me.tricksWon} sur ${me.bid}`;
  // Une encoche par pli annoncé : pleine = acquis, creuse = encore attendu,
  // barrée = pli en trop. La forme porte le sens, la couleur ne fait que
  // redoubler — un vert et un rouge sont la même couleur pour un deutan.
  const shown = Math.max(me.bid, me.tricksWon);
  for (let i = 1; i <= shown; i++) {
    const n = document.createElement('i');
    if (i > me.bid) n.className = 'is-over';
    else if (i <= me.tricksWon) n.className = 'is-won';
    mineNotches.appendChild(n);
  }
  mineEl.classList.toggle('sk-mine--over', me.tricksWon > me.bid);
  mineEl.classList.toggle('sk-mine--exact', me.tricksWon === me.bid);
}

// Vert = l'annonce est pile tenue à cet instant, rouge = déjà dépassée,
// donc irrattrapable. Neutre tant qu'on annonce (rien n'est encore joué).
function bidStateSuffix(state, p) {
  if (state.phase === 'bidding' || p.bid === undefined || p.bid === null) return '';
  if (p.tricksWon > p.bid) return '--over';
  if (p.tricksWon === p.bid) return '--hit';
  return '';
}

// --- Pièces de joueur ---
// Chacun choisit sa pièce dans le salon, comme au Monopoly. Avant, tous les
// sièges portaient le même drapeau pirate sur le même rond bordeaux : autour
// d'une table à 7 ou 9, plus rien ne distinguait les joueurs que le pseudo
// écrit en petit. Des figures dessinées plutôt que des emojis, parce qu'un
// emoji dépend de la police du système, ne se cale pas au pixel dans son
// rond, et n'a pas la même allure d'un appareil à l'autre.
//
// Tracé commun : boîte 24x24, trait de 2, bouts arrondis, couleur héritée -
// une seule silhouette lisible à 30px comme à 60px.
//
// `color` n'est PAS une teinte choisie à la main : c'est la couleur du
// cerclage émaillé du médaillon peint, relevée sur le .webp lui-même
// (briefs/couleur-cerclage.py, médiane de la couronne r=0.78..0.94). C'est ce
// qui fait qu'un joueur porte la même couleur partout — son secteur de roue,
// sa ligne de score, sa pastille de légende — et que cette couleur est
// exactement celle de la pièce qu'il a prise. Toucher au .webp sans relancer
// le script, c'est désaccorder les deux.
const PIECES = [
  {
    key: 'crane', label: 'Crâne', color: '#890e05',
    svg: '<circle cx="12" cy="9.5" r="6.6"/><circle cx="9.6" cy="9.2" r="1.7" fill="currentColor" stroke="none"/><circle cx="14.4" cy="9.2" r="1.7" fill="currentColor" stroke="none"/><path d="M8.2 15.6h7.6v3a1.6 1.6 0 0 1-1.6 1.6H9.8a1.6 1.6 0 0 1-1.6-1.6z"/><path d="M10.7 15.8v4.3M13.3 15.8v4.3"/>',
  },
  {
    key: 'ancre', label: 'Ancre', color: '#1c3044',
    svg: '<circle cx="12" cy="4.4" r="2.3"/><path d="M12 6.7V21"/><path d="M8 10h8"/><path d="M4.8 14.3c0 3.7 3.2 6.7 7.2 6.7s7.2-3 7.2-6.7"/>',
  },
  {
    key: 'voilier', label: 'Voilier', color: '#2b4807',
    svg: '<path d="M12 2.8v12.6"/><path d="M13.3 4.6l5 10.8h-5z" fill="currentColor" stroke="none"/><path d="M10.7 6.8 6.2 15.4h4.5z"/><path d="M3.4 17.2h17.2l-2.7 3.9H6.1z"/>',
  },
  {
    key: 'sabre', label: 'Sabre', color: '#5d1740',
    svg: '<path d="M20.2 3.8 9.7 14.3"/><path d="M6.9 12.9l4.2 4.2"/><path d="M8.3 15.7 4.9 19.1"/><circle cx="3.9" cy="20.1" r="1.5"/>',
  },
  {
    key: 'boussole', label: 'Boussole', color: '#ab6006',
    svg: '<circle cx="12" cy="12" r="8.6"/><path d="M15.4 8.6l-2 4.8-4.8 2 2-4.8z" fill="currentColor" stroke="none"/>',
  },
  {
    key: 'coffre', label: 'Coffre', color: '#115746',
    svg: '<path d="M3.6 10.6h16.8V19a1.6 1.6 0 0 1-1.6 1.6H5.2A1.6 1.6 0 0 1 3.6 19z"/><path d="M3.6 10.6A8.6 8.6 0 0 1 12 5.6a8.6 8.6 0 0 1 8.4 5"/><path d="M3.6 13.8h16.8"/><rect x="10.6" y="12.1" width="2.8" height="4" rx="0.7" fill="currentColor" stroke="none"/>',
  },
  {
    key: 'barre', label: 'Barre', color: '#b33706',
    svg: '<circle cx="12" cy="12" r="7.4"/><circle cx="12" cy="12" r="3.4"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><path d="M12 2.4v6.2M12 15.4v6.2M2.4 12h6.2M15.4 12h6.2M5.2 5.2l4.4 4.4M14.4 14.4l4.4 4.4M18.8 5.2l-4.4 4.4M9.6 14.4l-4.4 4.4"/>',
  },
  {
    key: 'bouteille', label: 'Bouteille', color: '#141902',
    svg: '<path d="M10.1 3h3.8v3.4c0 1 .4 1.6 1 2.3.9 1 1.5 2.1 1.5 3.5V19a2 2 0 0 1-2 2H9.6a2 2 0 0 1-2-2v-6.8c0-1.4.6-2.5 1.5-3.5.6-.7 1-1.3 1-2.3z"/><path d="M7.6 14.2h8.8"/>',
  },
  {
    key: 'crochet', label: 'Crochet', color: '#900d2f',
    svg: '<path d="M9.4 3.4h5.2"/><path d="M12 3.4v6.4"/><path d="M12 9.8a5 5 0 0 1 5 5v1.1a4 4 0 0 1-8 0"/>',
  },
];

const PIECE_BY_KEY = Object.fromEntries(PIECES.map((p) => [p.key, p]));

// Repli quand un joueur n'a rien choisi (partie en cours lancée avant cette
// fonctionnalité, ou bot) : une pièce tirée du pseudo, donc stable et
// différente d'un joueur à l'autre sans qu'on ait à trancher côté serveur.
function pieceFor(player) {
  const chosen = player && player.piece && PIECE_BY_KEY[player.piece];
  if (chosen) return chosen;
  const nickname = (player && player.nickname) || '';
  let hash = 0;
  for (let i = 0; i < nickname.length; i++) hash = (hash * 31 + nickname.charCodeAt(i)) >>> 0;
  return PIECES[hash % PIECES.length];
}

// L'émail des médaillons est peint sombre — c'est ce qui lui donne son
// épaisseur sur le bois clair du plateau. Sur le fond noir du récap de fin,
// ces mêmes couleurs disparaissent : #1c3044 sur #000, on ne voit plus la
// ligne. On garde donc la TEINTE de la pièce (c'est elle qui identifie le
// joueur) et on remonte seulement sa clarté au-dessus d'un plancher lisible.
// La saturation est encadrée des deux côtés : un plancher, sinon le cerclage
// d'acier de la Bouteille remonte en gris fade indistinct du texte crème ; un
// plafond, sinon l'émail vire au fluo et la courbe ne ressemble plus au reste
// du jeu (le plateau est peint, pas néon).
function surFondSombre(hex, clarteMin = 0.56) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const v = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const mx = Math.max(r, v, b);
  const mn = Math.min(r, v, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let t = 0;
  if (d !== 0) {
    if (mx === r) t = ((v - b) / d) % 6;
    else if (mx === v) t = (b - r) / d + 2;
    else t = (r - v) / d + 4;
    t *= 60;
    if (t < 0) t += 360;
  }
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const L = Math.max(l, clarteMin);
  const S = Math.min(Math.max(sat, 0.24), 0.58);
  // HSL -> RGB
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((t / 60) % 2) - 1));
  const m = L - c / 2;
  const [r2, v2, b2] =
    t < 60 ? [c, x, 0] : t < 120 ? [x, c, 0] : t < 180 ? [0, c, x] :
    t < 240 ? [0, x, c] : t < 300 ? [x, 0, c] : [c, 0, x];
  const oct = (u) => Math.round((u + m) * 255).toString(16).padStart(2, '0');
  return `#${oct(r2)}${oct(v2)}${oct(b2)}`;
}

// Le SVG porte la couleur de la pièce sur son trait ; le rond du siège prend
// la même teinte en fond, en plus sombre (voir --sk-av-color).
// Les pièces sont désormais des médaillons peints, un fichier par figure.
// Leur cerclage émaillé porte déjà la couleur du joueur : on ne la repeint
// donc plus par-dessus. Elle reste dans PIECES parce que le registre et les
// étiquettes de siège s'en servent pour teinter du texte, pas une figure.
// La marque du jeton d'entame. Ni lettre ni chiffre : un « D » ne disait que
// la mécanique de la distribution, un « 1 » se lisait comme une annonce ou un
// nombre de plis. Une rose des vents dit qui donne le cap, et c'est déjà la
// langue de la maison — le gouvernail du tirage au sort, le compas des
// parchemins. Gravée en creux : sur du laiton clair, un dessin clair ne se
// lit pas.
const ROSE_DES_VENTS =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M12 1.4 14.05 9.95 22.6 12 14.05 14.05 12 22.6 9.95 14.05 1.4 12 9.95 9.95Z"/>' +
  '<path d="M12 12 17.6 6.4 16.2 11.1ZM12 12 6.4 17.6 7.8 12.9ZM12 12 17.6 17.6 12.9 16.2ZM12 12 6.4 6.4 11.1 7.8Z" opacity=".55"/>' +
  '</svg>';

function pieceSVG(piece) {
  return `<img class="sk-piece-img" src="assets/skin/piece-${piece.key}.webp" alt="" aria-hidden="true" />`;
}

function renderSeats(state) {
  const { ordered, map } = seatLayout(state);
  tableEl.querySelectorAll('.sk-seat').forEach((el) => el.remove());

  ordered.forEach((p) => {
    // left/top sont les coordonnées du PLAN de jeu, en pourcentages ; c'est
    // la projection qui les pose sur le feutre.
    const [left, top] = map.get(p.id);
    const v = top / 100;
    const pos = surFeutre(left / 100, v);
    const seat = document.createElement('div');
    seat.className = 'sk-seat' + (p.id === myId ? ' sk-seat--me' : '');
    // renderTrick vient chercher le siège par son joueur : la carte du pli se
    // pose à côté du médaillon RÉELLEMENT rendu, mesuré, et pas à côté d'une
    // taille supposée.
    seat.dataset.player = p.id;
    seat.style.left = pos.x + '%';
    seat.style.top = pos.y + '%';
    seat.style.transform = `translate(-50%, -50%) scale(${echelleProfondeur(v).toFixed(3)})`;
    if (!p.connected) seat.classList.add('sk-seat--disconnected');
    // Le halo doré ne dit plus qu'une seule chose : « c'est à lui d'agir,
    // maintenant ». Il suivait jusqu'ici leaderPlayerId dès qu'on n'était pas
    // en phase de jeu, c'est-à-dire le meneur du pli PRÉCÉDENT pendant un
    // pouvoir de Pirate : le halo se posait alors sur un siège qui n'avait
    // rien à faire, et celui qui l'avait se croyait au trait alors que le
    // jeton de donneur et le pouvoir en cours désignaient quelqu'un d'autre.
    const activeId =
      state.phase === 'playing'
        ? state.turnPlayerId
        : state.phase === 'power' && state.pendingPower
          ? state.pendingPower.playerId
          : null;
    if (activeId && p.id === activeId) {
      seat.classList.add('sk-seat--turn');
      seat.title = p.id === myId ? "C'est à toi d'agir" : `C'est à ${p.nickname} d'agir`;
    }

    // Plis gagnés / annoncés, posé au-dessus du jeton : c'est l'information
    // qu'on cherche en regardant un adversaire (« il en a fait combien sur
    // ce qu'il a annoncé ? »), elle vivait jusqu'ici uniquement dans le
    // panneau de droite, loin du tapis. Rien pendant l'annonce, où les
    // annonces sont encore secrètes.
    if (landscapeTable.matches && state.phase !== 'bidding' && p.bid != null) {
      const tally = document.createElement('div');
      // En pilule sous le pseudo, dans le flux du siège : c'est ce que la
      // carte du pli mesure quand elle cherche à se dégager (voir renderTrick).
      tally.className = 'sk-seat-tally';
      const won = p.tricksWon || 0;
      tally.textContent = `${won} sur ${p.bid}`;
      // Vert tant que l'annonce reste tenable, rouge dès qu'elle est dépassée.
      if (won > p.bid) tally.classList.add('sk-seat-tally--over');
      else if (won === p.bid) tally.classList.add('sk-seat-tally--exact');
      tally.title = `${won} pli(s) remporté(s) sur ${p.bid} annoncé(s)`;
      seat.appendChild(tally);
    }

    // Jeton du joueur : en paysage il porte la mise en avant du tour (halo
    // doré) et donne au siège une silhouette lisible de loin. Masqué sous
    // 1000px, où la place manque et l'étiquette seule suffit.
    const avatar = document.createElement('div');
    avatar.className = 'sk-seat-av';
    const piece = pieceFor(p);
    avatar.innerHTML = pieceSVG(piece);
    avatar.style.setProperty('--sk-av-color', piece.color);
    avatar.title = piece.label;
    seat.appendChild(avatar);

    const label = document.createElement('div');
    label.className = 'sk-seat-label';
    const name = document.createElement('span');
    name.className = 'sk-seat-name';
    name.textContent = (p.connected ? '' : '⚑ ') + p.nickname;
    label.appendChild(name);

    // Annonce et plis gagnés vivent dans le panneau de droite, pas sur le
    // tapis : en portrait l'étiquette du siège reste le seul endroit où les
    // lire, on ne les y garde donc que là.
    if (!landscapeTable.matches) {
      const bidEl = document.createElement('span');
      const bidState = bidStateSuffix(state, p);
      bidEl.className = 'sk-seat-bid' + (bidState ? ` sk-seat-bid${bidState}` : '');
      if (state.phase === 'bidding') {
        bidEl.textContent = p.hasBid ? '✓' : '…';
      } else {
        bidEl.textContent = p.bid === undefined || p.bid === null ? '?' : `${p.tricksWon} sur ${p.bid}`;
      }
      label.appendChild(bidEl);
    }

    // Le jeton d'entame : qui ouvre le pli en cours. Posé dès la donne sur le
    // voisin de gauche du donneur, il reste sur le tapis toute la manche et
    // passe à qui remporte chaque pli — c'est le seul jeton permanent du jeu.
    // Accroché au SIÈGE, pas à l'étiquette du nom : dans l'étiquette il se
    // posait sur les premières lettres du pseudo, qui est justement ce qu'on
    // cherche à lire. Sur le siège, il vient au coin du médaillon.
    //
    // Le donneur avait le sien, en face : deux pastilles au même bord du même
    // médaillon se lisaient l'une pour l'autre, et personne ne joue en
    // fonction de qui distribue — la rotation du donneur se lit déjà dans
    // celle de l'entame, qui est son voisin de gauche à chaque donne.
    //
    // À ne pas confondre avec le halo doré du siège, qui dit « à lui d'agir,
    // maintenant » : pendant l'annonce, tout le monde annonce à la fois et
    // personne n'a le halo, mais le jeton, lui, désigne déjà l'entame.
    if (p.id === state.leaderPlayerId) {
      const chip = document.createElement('span');
      chip.className = 'sk-seat-leader';
      chip.innerHTML = ROSE_DES_VENTS;
      // Le survol dit ce que la rose ne peut pas dire toute seule. En bulle de
      // parchemin plutôt qu'en title natif : le title met une seconde à
      // paraître et ne se style pas, et un jeton qu'on survole est justement
      // un jeton dont on ne comprend pas le dessin. Le title reste posé pour
      // le clavier et les lecteurs d'écran.
      const message = `${p.nickname} commence à jouer ce pli.`;
      chip.title = message;
      attachTooltip(chip, message);
      seat.appendChild(chip);
    }

    // Alliance Butin : une fois formée, elle reste marquée à côté de chaque
    // allié jusqu'à la fin de la manche. Un simple pictogramme sur les deux
    // (ou trois) sièges concernés se lit mieux qu'un trait tracé entre eux.
    // Posé DANS le pseudo, pas à côté : en paysage l'étiquette est une
    // colonne, un frère du pseudo tomberait sur la ligne du dessous.
    if ((state.lootAllies || []).includes(p.id)) {
      const coin = document.createElement('span');
      coin.className = 'sk-seat-loot';
      coin.textContent = '💰';
      coin.title = 'Allié par un Butin cette manche';
      name.appendChild(coin);
    }

    seat.appendChild(label);
    tableEl.appendChild(seat);
  });
}

// La couleur imposée se lit sur une pastille peinte aux teintes de la
// maison — un emoji dépend de la police du système et détonne au milieu de
// gravures. Le nom de la couleur reste écrit à côté : la pastille ne porte
// jamais l'information seule.
// Ce qui détruit le pli, nommé. « Le pli est détruit » ne dit pas par quoi, et
// la carte fautive n'est pas celle qu'on soupçonne : une Raie posée en
// troisième annule des Pirates joués APRÈS elle, si bien que le dernier Pirate
// posé croit avoir gagné. Un joueur a cherché la faute dans la Planche du
// voisin, qui n'y était pour rien.
//
// La Baleine et la Raie ne détruisent le pli que dans un cas : quand elles
// n'ont AUCUNE numérotée à départager. La phrase le dit, sinon on comprend
// qu'elles le détruisent par nature, ce qui est faux.
//
// Deux formes, parce qu'il y a deux places et qu'elles n'ont pas la même
// largeur. `cause` s'écrit sur le bois au-dessus du feutre, où une ligne
// entière tient ; `annonce` se pose au centre du feutre pendant qu'on joue
// encore, dans une bande de 84 % de la largeur du tapis — au-delà d'une
// ligne elle retombe sur les sièges du haut.
const PLI_DETRUIT = {
  kraken: {
    cause: 'Le Kraken s\'empare du pli…',
    annonce: 'Le Kraken détruira ce pli.',
  },
  whale: {
    cause: "La Baleine blanche n'a aucune numérotée à départager : le pli se défait…",
    annonce: 'La Baleine blanche détruira ce pli.',
  },
  stingray: {
    cause: "La Raie Tachetée n'a aucune numérotée à départager : le pli se défait…",
    annonce: 'La Raie Tachetée détruira ce pli.',
  },
};

function pliDetruit(genre, forme) {
  const dit = PLI_DETRUIT[genre];
  if (dit) return dit[forme];
  return forme === 'cause' ? 'Le pli se défait…' : 'Ce pli sera détruit.';
}

function suitDot(suit) {
  return `<i class="sk-suit-dot sk-suit-dot--${suit}" aria-hidden="true"></i>`;
}

// Largeur d'une carte du pli à l'échelle 1, mesurée sur une carte réellement
// posée dans le tapis puis retirée. `--sk-trick-scale` est neutralisé le
// temps de la mesure : c'est la largeur PLEINE qu'on cherche, celle sur
// laquelle l'échelle va justement se calculer.
function largeurCarteDuPli() {
  tableEl.style.setProperty('--sk-trick-scale', '1');
  const sonde = document.createElement('div');
  sonde.className = 'sk-trick-card';
  sonde.style.visibility = 'hidden';
  sonde.style.animation = 'none';
  const carte = document.createElement('div');
  carte.className = 'sk-card';
  sonde.appendChild(carte);
  tableEl.appendChild(sonde);
  const l = carte.offsetWidth;
  sonde.remove();
  return l || 84;
}

// Le rectangle d'un élément, ramené aux coordonnées du tapis. `null` s'il
// n'est pas affiché — un élément masqué mesure 0 et bornerait tout.
function rectDansLeTapis(el, boite) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x0: r.left - boite.left, x1: r.right - boite.left, y0: r.top - boite.top, y1: r.bottom - boite.top };
}

// Sort la carte d'une bande de texte qu'elle recouvrirait, du côté vers
// lequel elle penchait déjà — vers le haut si son centre est au-dessus de
// celui de la bande, vers le bas sinon. Rien à faire si les deux ne se
// touchent pas, ce qui est le cas le plus fréquent.
function ecarterDe(x, y, demiL, demiH, bande, marge) {
  if (x + demiL <= bande.x0 || x - demiL >= bande.x1) return y;
  if (y + demiH <= bande.y0 || y - demiH >= bande.y1) return y;
  return y < (bande.y0 + bande.y1) / 2 ? bande.y0 - demiH - marge : bande.y1 + demiH + marge;
}

function borner(v, min, max) {
  return max < min ? (min + max) / 2 : Math.min(Math.max(v, min), max);
}

// Les cartes se posent à l'extérieur des sièges : elles débordent donc
// forcément du feutre sur le bois peint. Ce qu'elles n'ont pas le droit de
// recouvrir, c'est ce qui porte du texte — le bandeau du haut et le panneau
// de droite. On rend le rectangle qui reste libre, en coordonnées du tapis.
function zoneDesCartes(boite) {
  const scene = document.querySelector('.sk-scene');
  const r = scene ? scene.getBoundingClientRect() : boite;
  const marge = Math.max(8, r.width * 0.008);
  let x0 = r.left + marge;
  let x1 = r.right - marge;
  let y0 = r.top + marge;
  const y1 = r.bottom - marge;

  const bandeau = document.querySelector('.sk-game-header');
  if (bandeau) {
    const b = bandeau.getBoundingClientRect();
    if (b.height) y0 = Math.max(y0, b.bottom + marge);
  }
  // En scène le panneau de droite est en `display: contents` : il n'a pas de
  // boîte à lui, ce sont ses parchemins qui en ont une.
  document.querySelectorAll('.sk-objective, .sk-carnet, .sk-chat-livre').forEach((n) => {
    const b = n.getBoundingClientRect();
    if (b.width && b.left > r.left + r.width * 0.5) x1 = Math.min(x1, b.left - marge);
  });

  return { x0: x0 - boite.left, x1: x1 - boite.left, y0: y0 - boite.top, y1: y1 - boite.top };
}

// Deux bornes, et on garde la plus basse.
//
// La hauteur d'abord : une carte du pli ne dépasse pas 42 % de la hauteur du
// feutre. À la taille d'avant (les cartes se rejoignaient au centre, où l'on
// pouvait empiler) une seule carte couvrait les deux tiers du tapis ; posée
// contre un nom, elle recouvrait la moitié de la scène. Les 42 % ne sont pas
// un chiffre rond : c'est ce qu'il faut pour que MA carte, la plus haute des
// neuf puisqu'elle est au premier plan, s'arrête sous le bandeau du centre
// où s'écrit l'issue du pli. Un cran au-dessus et elle le recouvrait.
//
// La couronne ensuite : chaque carte a besoin d'un arc à elle sur le tour du
// feutre. Jusqu'à six joueurs il y en a de reste ; à neuf, les voisines se
// toucheraient. Jamais en deçà de 55 %, où les chiffres deviennent illisibles.
function echelleCouronne(effectif, largeurPleine, L, H) {
  const hauteur = (0.42 * H * 0.7) / largeurPleine;
  const a = 0.47 * L;
  const b = 0.45 * H;
  // Périmètre d'ellipse, approximation de Ramanujan.
  const tour = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  const arc = tour / Math.max(1, effectif) / (largeurPleine * 1.25);
  return Math.max(0.55, Math.min(1, hauteur, arc));
}

// Manche 1 : chacun tient sa carte tournée vers les autres. Tout le monde la
// voit sauf son porteur, et c'est là-dessus qu'on annonce. Elle était posée en
// vignette de 44 px contre le médaillon du siège, penchée de quatre degrés :
// à cette taille l'illustration d'un Pirate ne se distinguait plus d'une
// numérotée, et c'était la seule manche où les cartes ne se lisaient pas là
// où on a appris à les chercher.
//
// On fabrique donc un pli qui n'en est pas un : les cartes révélées passent
// par la couronne comme n'importe quel pli, chacune à l'extérieur du nom de
// qui la porte. La mienne rejoint le lot, face cachée — c'est la seule chose
// que la manche 1 change, et elle se voit mieux ainsi qu'en creux.
function cartesDeLaManche1(state) {
  if (state.phase !== 'bidding') return [];
  const cartes = state.players
    .filter((p) => p.revealedCard)
    .map((p) => ({ playerId: p.id, card: p.revealedCard }));
  if (!cartes.length) return [];
  // La mienne : le serveur ne m'en envoie que l'id (voir stateFor), ce qui
  // est exactement ce qu'il faut pour poser un dos de carte.
  const mienne = (state.hand || []).find((c) => c.kind === 'hidden');
  if (mienne) cartes.push({ playerId: myId, card: mienne });
  return cartes;
}

// La couronne : chaque carte du pli se pose CONTRE le nom de qui l'a jouée,
// du côté extérieur au tapis — au-dessus des sièges du haut, à gauche de
// ceux de gauche, à droite de ceux de droite. Seule la mienne fait l'inverse
// et monte vers le feutre : à l'extérieur, elle tomberait dans ma main.
//
// Les cartes convergeaient jusqu'ici vers le centre. À cinq joueurs elles y
// formaient un tas de cartes jointives où plus personne ne retrouvait la
// sienne : la carte n'était plus rattachée à son joueur que par une
// direction, et cette direction se perdait dès que deux cartes se
// chevauchaient. Posée contre le nom, la carte n'a plus besoin d'être lue
// pour qu'on sache à qui elle est.
//
// Ce que la couronne coûte : les cartes débordent du feutre sur le bois
// peint, puisque les sièges sont déjà au bord. C'est voulu — le tapis est le
// plateau, le bois est la table. Ce qu'elle rend : le centre du feutre reste
// vide, et c'est là que s'écrit l'issue du pli.
// Ce que le tapis montre, en une chaîne : le pli, les cartes qui le
// composent, les joueurs assis et la taille du feutre. Tout ce qui change le
// dessin du tapis y est, et RIEN d'autre — surtout pas la phase : c'est
// justement le passage en `power` qui rediffuse un état sans que le pli ait
// bougé d'un pixel.
function empreinteDuTapis(state, trick, boite) {
  return [
    cleDuPli(state),
    Math.round(boite.width),
    Math.round(boite.height),
    (state.players || []).map((p) => p.id).join(','),
    trick
      .map((t) => [t.playerId, t.card.id, t.card.kind, t.card.chosenAs || '',
                   t.card.suit || '', t.card.value ?? ''].join(':'))
      .join('|'),
  ].join('#');
}

let empreinteRendue = null;

function renderTrick(state) {
  const { map } = seatLayout(state);
  const trick = state.currentTrick && state.currentTrick.length ? state.currentTrick : cartesDeLaManche1(state);

  const boite = tableEl.getBoundingClientRect();

  // Pendant la pause de fin de pli, le même pli est rediffusé à chaque
  // broadcast : un pouvoir de Pirate qui s'ouvre, un joueur qui se
  // reconnecte, la file de Mat le Forban qui enchaîne. Redessiner recrée les
  // cases, donc RANNULE les animations en cours — les cartes que la gagnante
  // venait d'avaler réapparaissaient à leur place, et le garde-fou qui
  // empêche de rejouer deux fois l'animation du même pli (lastWonTrick) les
  // y laissait. D'où des cartes qui revenaient sans raison visible.
  //
  // Tant que le tapis montre exactement la même chose, on n'y touche pas.
  // Le garde ne vaut que pendant la pause : le reste du temps, chaque état
  // apporte une carte de plus et il faut bien la poser.
  if (state.trickPaused
      && empreinteRendue === empreinteDuTapis(state, trick, boite)
      && tableEl.querySelector('.sk-trick-card')) {
    return;
  }

  tableEl.querySelectorAll('.sk-trick-card').forEach((el) => el.remove());
  empreinteRendue = empreinteDuTapis(state, trick, boite);
  const L = boite.width || 1;
  const H = boite.height || 1;

  const MARGE = 8;

  // Une carte du pli ne fait pas la même largeur selon la mise en page — 76 px
  // en portrait, 86 en paysage, 22,5 % du feutre sur la scène peinte. Plutôt
  // que de recopier ces trois valeurs ici (où elles se seraient désaccordées
  // au premier réglage de CSS), on en pose une à blanc et on la mesure.
  const largeurPleine = largeurCarteDuPli();

  // L'échelle se calcule sur l'EFFECTIF, pas sur le nombre de cartes déjà
  // posées : indexée sur le pli en cours, elle rapetissait toutes les cartes
  // à chaque nouvelle venue, et le tapis tressautait à chaque tour.
  const echelle = echelleCouronne(map.size, largeurPleine, L, H);
  tableEl.style.setProperty('--sk-trick-scale', echelle.toFixed(3));
  const CARTE_L = largeurPleine * echelle;
  const CARTE_H = CARTE_L / 0.7;

  // Le centre du plan de jeu, projeté sur le feutre : c'est de lui que part
  // la direction « vers l'extérieur ».
  const centre = surFeutre(0.5, 0.5);
  const cxTapis = (centre.x / 100) * L;
  const cyTapis = (centre.y / 100) * H;
  const cadre = zoneDesCartes(boite);
  // Trois bandes de texte traversent la scène sans en border un côté : la
  // consigne du tour et la bannière de pouvoir au-dessus du feutre, ma main
  // en dessous. Un rectangle de cadrage ne sait pas les éviter — elles se
  // traitent carte par carte.
  const bandes = ['sk-turn-indicator', 'sk-power-banner', 'sk-hand']
    .map((id) => rectDansLeTapis(document.getElementById(id), boite))
    .filter(Boolean);

  // Les sièges viennent d'être rendus : on les mesure plutôt que de les
  // supposer. Un pseudo long, un compteur de plis, le jeton d'entame — la
  // hauteur d'un siège n'est pas une constante.
  const sieges = new Map();
  tableEl.querySelectorAll('.sk-seat').forEach((el) => sieges.set(el.dataset.player, el));

  // Pendant que le pli se joue, la liste vient de l'aperçu ; une fois tombé,
  // du résultat — sans quoi le voile sauterait à la seconde même où il sert
  // le plus, celle où l'on comprend ce qui vient de se passer.
  const neutralisees = new Set(
    (state.trickPaused && state.lastTrickResult
      ? state.lastTrickResult.neutralisedCardIds
      : state.trickNeutralisedCardIds) || []
  );

  // UN JOUEUR PEUT AVOIR DEUX CARTES DANS LE MÊME PLI. C'est le seul effet de
  // la Dernière Salve : celui qui la pose rejoue après tout le monde. Les
  // deux cartes se posaient alors exactement au même endroit, contre son
  // siège — la seconde recouvrait la première, entièrement. On ne voyait donc
  // pas que la Salve avait été jouée, seulement une carte devant son nom, et
  // quand cette carte-là remportait le pli tout portait à croire que c'était
  // la Salve qui l'avait gagné. Elles s'écartent maintenant l'une de l'autre.
  const combienParJoueur = new Map();
  const rangDeLaCarte = new Map();
  trick.forEach((t) => {
    const n = combienParJoueur.get(t.playerId) || 0;
    rangDeLaCarte.set(t.card.id, n);
    combienParJoueur.set(t.playerId, n + 1);
  });

  trick.forEach((t) => {
    const seatPos = map.get(t.playerId);
    if (!seatPos) return;
    const vSiege = seatPos[1] / 100;
    const k = echelleProfondeur(vSiege);

    const slot = document.createElement('div');
    slot.className = 'sk-trick-card';
    // L'id de la carte sert à retrouver la case après coup (animation du
    // Skull King qui dévore les Pirates, voir playDevourAnimation).
    slot.dataset.cardId = t.card.id;
    slot.dataset.kind = t.card.kind;
    // Voile des cartes que la Baleine ou la Raie a mises hors course. La
    // liste vient du moteur (voir resolveTrick) : la règle est trop
    // contre-intuitive pour être redevinée ici, et elle a des coins — un
    // 0/14 déclaré à 0 en fait partie sous la Raie.
    if (neutralisees.has(t.card.id)) slot.classList.add('sk-trick-card--neutralisee');
    // De qui est la carte, en clair : le ciblage de la Planche s'en sert
    // pour annoncer sa cible à un lecteur d'écran, qui ne voit ni le tapis
    // ni de qui la carte est voisine.
    slot.dataset.nomCarte = `${t.card.name || (t.card.kind === 'tigress' ? 'la Tigresse' : 'le Pirate')} de ${nicknameOf(state, t.playerId)}`;

    const el = sieges.get(t.playerId);
    const rs = el ? el.getBoundingClientRect() : null;
    const posSiege = surFeutre(seatPos[0] / 100, vSiege);
    const sx = rs ? rs.left + rs.width / 2 - boite.left : (posSiege.x / 100) * L;
    const sy = rs ? rs.top + rs.height / 2 - boite.top : (posSiege.y / 100) * H;
    const demiSiegeL = rs ? rs.width / 2 : 52 * k;
    const demiSiegeH = rs ? rs.height / 2 : 40 * k;

    // Vers l'extérieur pour les autres, vers le tapis pour moi.
    let dx = sx - cxTapis;
    let dy = sy - cyTapis;
    const norme = Math.hypot(dx, dy) || 1;
    dx /= norme;
    dy /= norme;
    if (t.playerId === myId) {
      dx = -dx;
      dy = -dy;
    }

    // Distance minimale à laquelle les deux rectangles — le siège et la
    // carte — cessent de se recouvrir. Se séparer sur UN seul axe suffit,
    // d'où le minimum : sur une diagonale, exiger le dégagement complet des
    // deux axes enverrait la carte trois fois trop loin.
    const demiCarteL = (CARTE_L * k) / 2;
    const demiCarteH = (CARTE_H * k) / 2;
    const EPS = 0.02;
    const ecart = Math.min(
      Math.abs(dx) > EPS ? (demiSiegeL + demiCarteL + MARGE) / Math.abs(dx) : Infinity,
      Math.abs(dy) > EPS ? (demiSiegeH + demiCarteH + MARGE) / Math.abs(dy) : Infinity
    );

    // Perpendiculairement à la direction siège → carte, pour que la paire
    // reste à la même distance du tapis et se lise comme une paire : deux
    // cartes du même joueur, côte à côte, pas une devant l'autre.
    const combien = combienParJoueur.get(t.playerId) || 1;
    let ecartFrere = 0;
    if (combien > 1) {
      ecartFrere = (rangDeLaCarte.get(t.card.id) - (combien - 1) / 2) * demiCarteL * 1.25;
    }
    const x = borner(sx + dx * ecart - dy * ecartFrere, cadre.x0 + demiCarteL, cadre.x1 - demiCarteL);
    let y = borner(sy + dy * ecart + dx * ecartFrere, cadre.y0 + demiCarteH, cadre.y1 - demiCarteH);
    bandes.forEach((bande) => {
      y = ecarterDe(x, y, demiCarteL, demiCarteH, bande, MARGE);
    });
    slot.style.left = `${(x / L) * 100}%`;
    slot.style.top = `${(y / H) * 100}%`;
    // La profondeur reste celle du SIÈGE : la carte appartient à sa place
    // autour de la table, pas à la ligne où elle a fini par se poser.
    slot.style.setProperty('--sk-depth', k.toFixed(3));
    if (t.playerId === state.leadingPlayerId) {
      slot.classList.add('sk-trick-card--leading');
      // Le pli est tombé : ce n'est plus « celle qui mène », c'est celle qui
      // emporte. Elle passe au premier plan et respire, pour qu'on la trouve
      // sans relire les cinq autres.
      if (state.trickPaused && !(state.lastTrickResult && state.lastTrickResult.destroyed)) {
        slot.classList.add('sk-trick-card--gagnante');
      }
    }

    const cardEl = document.createElement('div');
    cardEl.className = `sk-card ${cardClass(t.card)}`;
    cardEl.innerHTML = cardFaceHTML(t.card);
    attachPowerTooltip(cardEl, t.card);
    slot.appendChild(cardEl);

    tableEl.appendChild(slot);
  });

  // Le centre ne porte plus que les moments qui comptent : la consigne pendant
  // l'annonce, puis l'issue du pli. Qui mène se lit déjà au liseré vert de la
  // carte, la couleur demandée aux cartes grisées dans la main.
  if (state.phase === 'bidding') {
    retirerVerdict();
    trickCaptionEl.textContent = 'Tout le monde annonce son nombre de plis…';
  } else if (state.trickPaused) {
    if (state.lastTrickResult && state.lastTrickResult.destroyed) {
      // Le Kraken vient chercher le pli au centre du feutre (voir
      // playKrakenAnimation) : ce qui est écrit ici ne doit pas se retrouver
      // sous les cartes qui convergent. La classe ne fait que retarder son
      // apparition jusqu'à ce que le tas ait fini de s'effacer — la ligne
      // arrive donc sur un feutre vide, et elle dit la conséquence, pendant
      // que la consigne au-dessus du feutre dit la cause.
      retirerVerdict();
      const parLeKraken = !!state.lastTrickResult.krakenCardId;
      // Le tas met d'autant plus de temps à s'effacer qu'il a de cartes à
      // avaler (playKrakenAnimation les étale de 75 ms) : à neuf joueurs, une
      // attente fixe aurait fait s'écrire la ligne sous le retournement, au
      // pixel près à l'endroit qu'elle est censée attendre.
      const aAvaler = Math.max(0, (state.currentTrick || []).length - 1);
      trickCaptionEl.style.setProperty('--sk-attente', `${(1.54 + aAvaler * 0.075).toFixed(2)}s`);
      // Le centre ne porte que la conséquence, et courte : la cause est
      // nommée au-dessus du feutre, où il y a la place de l'écrire.
      trickCaptionEl.textContent = parLeKraken
        ? 'Le pli est englouti — personne ne le remporte.'
        : 'Le pli est détruit — personne ne le remporte.';
      trickCaptionEl.classList.toggle('sk-trick-caption--apres-kraken', parLeKraken);
    } else {
      // Le verdict n'est pas une consigne de plus : c'est la ligne qu'on
      // cherche quand le pli tombe. Il se lit d'un coup — la pièce, puis le
      // nom dans sa couleur, celle du médaillon du siège et de la courbe du
      // récap. Le bandeau de texte lui laisse la place.
      trickCaptionEl.textContent = '';
      const gagnant = state.players.find((p) => p.id === state.leadingPlayerId);
      if (gagnant) poserVerdict(`${state.roundNumber}-${state.trickNumber}`, gagnant);
      else retirerVerdict();
    }
  } else if (state.trickWillBeDestroyed) {
    retirerVerdict();
    trickCaptionEl.classList.remove('sk-trick-caption--apres-kraken');
    trickCaptionEl.textContent = pliDetruit(state.trickDestroyedBy, 'annonce');
  } else {
    retirerVerdict();
    trickCaptionEl.classList.remove('sk-trick-caption--apres-kraken');
    trickCaptionEl.textContent = '';
  }
}

// LE VERDICT DU PLI, posé une seule fois par pli. renderTrick est rappelé à
// chaque état reçu pendant la pause : masquer puis réafficher le bandeau à
// chaque passage empêchait toute animation d'entrée de repartir — le
// navigateur ne recalcule rien entre le `add` et le `remove` du même passage,
// il ne voit donc aucun changement à animer, et le verdict apparaissait d'un
// coup. D'où le repère de pli : on ne touche au bandeau que quand il change
// vraiment de contenu.
function poserVerdict(cle, gagnant) {
  if (verdictEl.dataset.pli === cle) return;
  verdictEl.dataset.pli = cle;
  verdictPieceEl.innerHTML = pieceSVG(pieceFor(gagnant));
  verdictTexteEl.innerHTML = gagnant.id === myId
    ? `<b class="sk-verdict-nom" style="color:${couleurJoueur(gagnant)}">Tu</b> remportes le pli`
    : `<b class="sk-verdict-nom" style="color:${couleurJoueur(gagnant)}">${escapeHTML(gagnant.nickname)}</b> remporte le pli`;
  verdictEl.classList.remove('hidden');
  // Le retard laisse passer ce qui a un sort particulier — dévoré, englouti,
  // jeté par-dessus bord. Ces gestes disent POURQUOI le pli tombe comme ça ;
  // le verdict tranche ensuite, en même temps que le ramassage.
  verdictEl.animate(
    [
      { opacity: 0, transform: 'translateY(10px) scale(0.94)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: 360, delay: 900, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }
  );
}

function retirerVerdict() {
  if (!verdictEl.dataset.pli) return;
  verdictEl.dataset.pli = '';
  verdictEl.classList.add('hidden');
}

// --- Marcher sur la Planche : le Pirate passe par-dessus bord ---
// Le pouvoir marchait depuis toujours — le Pirate était bien retiré du pli
// pour le gagnant, les bonus et les pouvoirs hérités — mais rien ne le
// disait à l'écran : la carte restait posée sur le tapis, intacte, et on en
// concluait que la Planche n'avait rien fait. Elle bascule maintenant et
// tombe hors du tapis, dans la direction opposée à la Planche qui l'y
// envoie.
let lastPlankedTrick = null;

function playPlankAnimation(state) {
  const res = state.lastTrickResult;
  const ids = (res && res.plankedCardIds) || [];
  if (!state.trickPaused || !ids.length) return;

  // Même repère que la dévoration : un pli est rediffusé à chaque broadcast
  // pendant la pause, l'animation ne doit partir qu'une fois.
  const key = `${state.roundNumber}-${state.trickNumber}`;
  if (lastPlankedTrick === key) return;
  lastPlankedTrick = key;

  const planche = tableEl.querySelector('.sk-trick-card[data-kind="plank"]');
  if (!planche) return;

  // Le Pirate tombe DANS la Planche, comme les Pirates tombent dans le Skull
  // King : c'est le même geste pour la même chose — une carte qui en retire
  // une autre du pli. Il partait auparavant en chute libre hors du tapis, ce
  // qui racontait bien la planche mais ne rattachait le départ à rien : on
  // voyait une carte tomber, jamais qui l'avait poussée.
  //
  // Plus lentement que le Skull King et avec un demi-tour complet : le Skull
  // King dévore, la Planche fait marcher — la carte bascule en chemin.
  const avalees = avalerCartes(planche, ids, { duree: 980, retard: 160, pas: 140, tour: 190 });
  pulsationAvaleuse(planche, avalees, { duree: 620, retard: 900, pas: 140, ampleur: 1.12, eclat: 1.3 });

  // La Planche accuse le coup : une secousse, au moment où elle pousse.
  const carte = planche.querySelector('.sk-card');
  if (carte) {
    carte.animate(
      [
        { transform: 'translateX(0) rotate(0deg)' },
        { transform: 'translateX(-3px) rotate(-2.5deg)', offset: 0.3 },
        { transform: 'translateX(3px) rotate(2deg)', offset: 0.62 },
        { transform: 'translateX(0) rotate(0deg)' },
      ],
      { duration: 520, delay: 160, easing: 'ease-out' }
    );
  }
}

// --- AVALER UNE CARTE ---
// Le même geste sert quatre fois : le Skull King qui dévore les Pirates, le
// Coffre de Davy Jones qui engloutit les Monstres Marins, Marcher sur la
// Planche qui pousse son Pirate par-dessus bord, et le vainqueur qui ramasse
// le pli. La carte part vers celle qui la prend, grossit d'un temps en chemin
// puis s'écrase dedans. Ce qui change d'un cas à l'autre, ce sont les
// réglages — une durée, un tour, un éclat — pas le geste.
//
// Pilotée par l'API Web Animations plutôt qu'en CSS : la distance dépend de
// la position réelle des cases sur le tapis, qui change à chaque pli et à
// chaque nombre de joueurs.
//
// Distances prises sur offsetLeft/offsetTop, pas sur getBoundingClientRect :
// les cases viennent d'être créées et leur animation d'apparition
// (sk-card-drop) est encore en cours, donc leur boîte mesurée est décalée et
// la carte n'atterrissait pas sur celle qui l'avale (35 px d'écart mesurés).
// Les offsets, eux, sont la position de mise en page, insensible aux
// transformations en cours.
function avalerCartes(cible, ids, { duree = 850, retard = 120, pas = 90, tour = 14 } = {}) {
  let n = 0;
  ids.forEach((id) => {
    const slot = tableEl.querySelector(`.sk-trick-card[data-card-id="${CSS.escape(id)}"]`);
    if (!slot || slot === cible) return;
    const dx = cible.offsetLeft - slot.offsetLeft;
    const dy = cible.offsetTop - slot.offsetTop;
    // La case porte déjà une échelle de profondeur : la reprendre évite que
    // la carte grossisse d'un coup au premier pas de l'animation.
    const k = parseFloat(slot.style.getPropertyValue('--sk-depth')) || 1;
    slot.style.zIndex = '4';
    slot.animate(
      [
        { transform: `translate(-50%, -50%) scale(${k})`, opacity: 1 },
        { transform: `translate(-50%, -50%) translate(${dx * 0.25}px, ${dy * 0.25}px) scale(${k * 1.08}) rotate(-6deg)`, opacity: 1, offset: 0.28 },
        { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(${k * 0.15}) rotate(${tour}deg)`, opacity: 0 },
      ],
      { duration: duree, delay: retard + n * pas, easing: 'cubic-bezier(0.5, -0.3, 0.7, 1)', fill: 'forwards' }
    );
    n += 1;
  });
  return n;
}

// Celle qui avale encaisse : une pulsation au moment où les cartes arrivent.
function pulsationAvaleuse(cible, avalees, { duree = 700, retard = 700, pas = 90, ampleur = 1.14, eclat = 1.5 } = {}) {
  const carte = cible && cible.querySelector('.sk-card');
  if (!carte || !avalees) return;
  carte.animate(
    [
      { transform: 'scale(1)', filter: 'brightness(1)' },
      { transform: `scale(${ampleur})`, filter: `brightness(${eclat})`, offset: 0.55 },
      { transform: 'scale(1)', filter: 'brightness(1)' },
    ],
    { duration: duree, delay: retard + (avalees - 1) * pas, easing: 'ease-out' }
  );
}

// Un même pli est rediffusé à chaque broadcast pendant la pause : sans ces
// repères, les animations repartiraient à zéro à chaque état reçu.
let lastDevouredTrick = null;
let lastDavyTrick = null;
let lastWonTrick = null;

function cleDuPli(state) {
  return `${state.roundNumber}-${state.trickNumber}`;
}

// --- Le Skull King dévore les Pirates du pli ---
function playDevourAnimation(state) {
  const res = state.lastTrickResult;
  const ids = (res && res.devouredCardIds) || [];
  if (!state.trickPaused || !ids.length) return;
  const key = cleDuPli(state);
  if (lastDevouredTrick === key) return;
  lastDevouredTrick = key;

  const king = tableEl.querySelector('.sk-trick-card[data-kind="skullking"]');
  if (!king) return;
  const avalees = avalerCartes(king, ids);
  pulsationAvaleuse(king, avalees);
}

// --- Le Coffre de Davy Jones engloutit les Monstres Marins ---
// Il les détruisait sans que rien ne le montre : le Kraken restait posé,
// entier, à côté d'un coffre qui venait pourtant de l'effacer du pli. Les
// Monstres tombent maintenant dedans, un par un, et le coffre tressaute.
// Plus lentement que le Skull King, et sans éclat doré : un coffre qui se
// referme n'a pas la même faim qu'un roi.
function playDavyAnimation(state) {
  const res = state.lastTrickResult;
  const davy = res && res.davyJones;
  if (!state.trickPaused || !davy || !davy.ids.length) return;
  const key = cleDuPli(state);
  if (lastDavyTrick === key) return;
  lastDavyTrick = key;

  const coffre = tableEl.querySelector(`.sk-trick-card[data-card-id="${CSS.escape(davy.chestId)}"]`);
  if (!coffre) return;
  const avalees = avalerCartes(coffre, davy.ids, { duree: 950, retard: 140, pas: 130, tour: -18 });
  pulsationAvaleuse(coffre, avalees, { duree: 620, retard: 820, pas: 130, ampleur: 1.1, eclat: 1.25 });
}

// --- LE KRAKEN ENGLOUTIT LE PLI ---
// Un pli détruit s'effaçait exactement comme un pli remporté : les cartes
// disparaissaient d'un coup au ramassage, et seule une ligne de texte
// distinguait « personne ne gagne » de « quelqu'un a gagné ». Le geste dit
// maintenant la règle — le Kraken vient prendre le centre du feutre, les
// cartes lui tombent dedans en tournoyant sur elles-mêmes, puis le tas se
// retourne face contre table et s'efface. Personne ne le ramasse : il n'y a
// personne vers qui le faire partir, et c'est justement ce qu'on veut voir.
//
// Le centre du FEUTRE, pas le centre du tapis : le tapis déborde du feutre
// sur le bois peint depuis que les cartes se posent contre leur siège, et le
// tas doit tomber sur le drap, là où le pli se joue.
//
// Distances prises sur offsetLeft/offsetTop pour la même raison que la
// dévoration : les cases viennent d'être créées et leur animation
// d'apparition fausse encore leur boîte mesurée.
let lastKrakenTrick = null;

function playKrakenAnimation(state) {
  const res = state.lastTrickResult;
  const krakenId = res && res.destroyed && res.krakenCardId;
  if (!state.trickPaused || !krakenId) return;
  const key = cleDuPli(state);
  if (lastKrakenTrick === key) return;
  lastKrakenTrick = key;

  const kraken = tableEl.querySelector(`.sk-trick-card[data-card-id="${CSS.escape(krakenId)}"]`);
  if (!kraken) return;

  const centre = surFeutre(0.5, 0.5);
  const cx = (centre.x / 100) * tableEl.clientWidth;
  const cy = (centre.y / 100) * tableEl.clientHeight;
  const kKraken = parseFloat(kraken.style.getPropertyValue('--sk-depth')) || 1;

  // 1. Le Kraken prend le centre. Il grossit en chemin : ce n'est plus une
  //    carte parmi les autres, c'est ce dans quoi les autres vont tomber.
  const dxK = cx - kraken.offsetLeft;
  const dyK = cy - kraken.offsetTop;
  kraken.classList.add('sk-trick-card--kraken');
  const versLeCentre = `translate(-50%, -50%) perspective(900px) translate(${dxK}px, ${dyK}px) scale(${kKraken * 1.22})`;
  kraken.animate(
    [
      { transform: `translate(-50%, -50%) perspective(900px) scale(${kKraken})` },
      { transform: `${versLeCentre} rotate(-4deg)`, offset: 0.7 },
      { transform: versLeCentre },
    ],
    { duration: 620, easing: 'cubic-bezier(0.34, 1.25, 0.64, 1)', fill: 'forwards' }
  );

  // 2. Les autres cartes lui tombent dedans en tournoyant. Ce qui a déjà été
  //    jeté par-dessus bord par la Planche n'est plus sur le tapis.
  const dejaParties = new Set(res.plankedCardIds || []);
  let n = 0;
  tableEl.querySelectorAll('.sk-trick-card').forEach((slot) => {
    if (slot === kraken || dejaParties.has(slot.dataset.cardId)) return;
    const dx = cx - slot.offsetLeft;
    const dy = cy - slot.offsetTop;
    const k = parseFloat(slot.style.getPropertyValue('--sk-depth')) || 1;
    // Le sens de rotation vient du côté d'où la carte arrive : elles sont
    // aspirées dans le même tourbillon, pas chacune dans le sien.
    const sens = dx === 0 ? 1 : Math.sign(dx);
    slot.style.zIndex = '4';
    slot.animate(
      [
        { transform: `translate(-50%, -50%) scale(${k}) rotate(0deg)`, opacity: 1 },
        {
          transform: `translate(-50%, -50%) translate(${dx * 0.2}px, ${dy * 0.2}px) scale(${k * 1.06}) rotate(${sens * -60}deg)`,
          opacity: 1,
          offset: 0.3,
        },
        {
          transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(${k * 0.12}) rotate(${sens * 620}deg)`,
          opacity: 0,
        },
      ],
      { duration: 780, delay: 380 + n * 75, easing: 'cubic-bezier(0.55, -0.25, 0.75, 1)', fill: 'forwards' }
    );
    n += 1;
  });

  // 3. Le tas se retourne, puis s'efface.
  //
  //    En deux temps et en scaleX, pas en rotateY : le demi-tour 3D suppose
  //    un contexte `preserve-3d` que la case ne peut pas tenir — elle porte
  //    une opacité et un empilement animés, et Chrome aplatit le contexte dès
  //    qu'un de ces groupages apparaît. Le dos se retrouvait alors dans le
  //    plan du dessin, tous deux masqués par leur backface, et le tas
  //    disparaissait au quart de tour sans jamais montrer de dos.
  //
  //    Sur la tranche, ce qui est visible est échangé : le dessin s'efface,
  //    le dos peint prend sa place. C'est le même geste à l'écran, et il ne
  //    dépend d'aucune propriété de composition.
  if (!kraken.querySelector('.sk-kraken-dos')) {
    const dos = document.createElement('i');
    dos.className = 'sk-kraken-dos';
    dos.setAttribute('aria-hidden', 'true');
    kraken.appendChild(dos);
  }
  const retournement = 480 + n * 75;
  const surLaTranche = `${versLeCentre} scaleX(0.02)`;
  const DUREE = 1060;
  // L'instant de la tranche, en fraction de l'animation : c'est là que le
  // dessin cède la place au dos. Les trois animations le partagent — le
  // retournement n'est un retournement que si l'échange tombe pile au
  // moment où la carte n'a plus de largeur.
  const TRANCHE = 0.42;

  kraken.animate(
    [
      { transform: versLeCentre, opacity: 1 },
      // Le temps où il encaisse ce qu'il vient d'avaler, juste avant de se
      // retourner : sans lui, le demi-tour part sur une carte immobile et on
      // ne rattache plus le retournement à ce qui vient de tomber dedans.
      { transform: `${versLeCentre} scale(1.08)`, opacity: 1, offset: TRANCHE * 0.45 },
      { transform: surLaTranche, opacity: 1, offset: TRANCHE },
      { transform: versLeCentre, opacity: 1, offset: 0.66 },
      { transform: `${versLeCentre} scale(0.84) translateY(18px)`, opacity: 0 },
    ],
    { duration: DUREE, delay: retournement, easing: 'ease-in-out', fill: 'forwards' }
  );

  // L'échange des deux faces, en escalier : rien ne s'estompe, l'un s'éteint
  // et l'autre s'allume dans le même quart de milliseconde, sur la tranche.
  const echange = (el, avant, apres) => {
    if (!el) return;
    el.animate(
      [
        { opacity: avant, offset: 0 },
        { opacity: avant, offset: TRANCHE - 0.005 },
        { opacity: apres, offset: TRANCHE },
        { opacity: apres, offset: 1 },
      ],
      { duration: DUREE, delay: retournement, fill: 'forwards' }
    );
  };
  echange(kraken.querySelector('.sk-card'), 1, 0);
  echange(kraken.querySelector('.sk-kraken-dos'), 0, 1);
}

// --- Le vainqueur ramasse le pli ---
// La carte gagnante restait seule, immobile, cerclée de son halo, pendant que
// les autres attendaient d'être effacées d'un coup au ramassage. Elles lui
// tombent maintenant dedans — c'est ce que « remporter le pli » veut dire, et
// ça se voit sans lire le bandeau.
//
// Après les autres : ce qui a déjà été dévoré, englouti ou jeté par-dessus
// bord n'est plus sur le tapis, on ne le ramasse pas une seconde fois.
function playTrickWinAnimation(state) {
  const res = state.lastTrickResult;
  if (!state.trickPaused || !res || res.destroyed) return;
  const key = cleDuPli(state);
  if (lastWonTrick === key) return;
  lastWonTrick = key;

  const gagnante = tableEl.querySelector('.sk-trick-card--gagnante');
  if (!gagnante) return;

  const dejaParties = new Set([
    ...(res.devouredCardIds || []),
    ...(res.plankedCardIds || []),
    ...((res.davyJones && res.davyJones.ids) || []),
  ]);
  const ids = [...tableEl.querySelectorAll('.sk-trick-card')]
    .map((slot) => slot.dataset.cardId)
    .filter((id) => id && !dejaParties.has(id));

  // Le retard laisse les animations de carte se finir : elles racontent
  // POURQUOI le pli tombe comme ça, le ramassage n'en est que la conclusion.
  const avalees = avalerCartes(gagnante, ids, { duree: 620, retard: 1150, pas: 55, tour: 10 });
  pulsationAvaleuse(gagnante, avalees, { duree: 620, retard: 1500, pas: 55, ampleur: 1.12, eclat: 1.35 });

}

// Annonce en deux temps : on choisit un chiffre (sélection locale, rien n'est
// envoyé), puis on confirme. Avant, le clic envoyait directement et un simple
// texte disait « annonce enregistrée — modifiable » : on ne savait pas si on
// avait validé quelque chose, et un clic de trop changeait l'annonce sans
// qu'on s'en aperçoive. L'annonce reste modifiable tant que tout le monde n'a
// pas confirmé — il suffit de choisir un autre chiffre et de reconfirmer.
let pendingBid = null;
let bidRoundRef = null;

function renderBidChoices(state) {
  bidChoices.innerHTML = '';
  bidChoices.classList.toggle('hidden', state.phase !== 'bidding');
  if (state.phase !== 'bidding') {
    pendingBid = null;
    return;
  }

  // La manche 1 se joue à l'aveugle : ta carte reste cachée et tu annonces
  // sur celles que tu vois chez les autres. La barre n'a donc pas la même
  // place qu'aux autres manches — c'est la CSS de la scène qui s'en sert
  // (voir .sk-scene #sk-bid-choices), pas le JS.
  bidChoices.dataset.manche = state.roundNumber === 1 ? '1' : 'n';

  // Nouvelle manche : on repart d'une sélection vide plutôt que de traîner
  // le chiffre de la manche précédente.
  if (bidRoundRef !== state.roundNumber) {
    bidRoundRef = state.roundNumber;
    pendingBid = null;
  }
  // À la reconnexion, on retrouve l'annonce déjà envoyée comme sélection.
  if (pendingBid === null && state.myBid !== undefined) pendingBid = state.myBid;

  for (let n = 0; n <= state.cardsInRound; n++) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (pendingBid === n ? ' btn-primary' : '');
    btn.textContent = n;
    btn.addEventListener('click', () => {
      pendingBid = n;
      renderBidChoices(state);
    });
    bidChoices.appendChild(btn);
  }

  // La grille se répartit en rangées ÉGALES. À six colonnes fixes, la manche
  // 6 donnait une rangée pleine suivie d'un « 6 » tout seul, et la manche 1
  // deux jetons calés à gauche d'une pilule vide aux trois quarts — passable
  // dans un coin, voyant une fois la pilule centrée. On garde six colonnes
  // au plus (au-delà les jetons deviennent illisibles), mais on répartit :
  // sept jetons font 4 + 3, onze font 6 + 5, deux font 2.
  const jetons = state.cardsInRound + 1;
  const rangees = Math.ceil(jetons / 6);
  bidChoices.style.setProperty('--sk-bid-cols', Math.ceil(jetons / rangees));

  const confirme = pendingBid !== null && pendingBid === state.myBid;
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn sk-bid-confirm' + (confirme ? ' sk-bid-confirm--done' : '');
  confirmBtn.disabled = pendingBid === null || confirme;
  confirmBtn.textContent = confirme ? 'Annonce envoyée' : 'Confirmer';
  confirmBtn.addEventListener('click', () => {
    if (pendingBid === null) return;
    socket.emit('skullking-bid', { bid: pendingBid });
  });
  bidChoices.appendChild(confirmBtn);

  // Rappel discret à droite, dans la barre d'actions elle-même.
  const hint = document.createElement('span');
  hint.className = 'sk-bar-hint';
  hint.textContent = confirme
    ? 'Modifiable tant que tout le monde n\'a pas annoncé'
    : pendingBid === null
      ? 'Choisis ton annonce'
      : 'Confirme pour envoyer';
  bidChoices.appendChild(hint);
}

function renderTurnIndicator(state) {
  if (state.phase === 'power') {
    turnIndicator.textContent = ''; // le bandeau de pouvoir porte déjà le message
    return;
  }
  if (state.phase === 'bidding') {
    if (state.myBid === undefined) {
      turnIndicator.textContent =
        state.roundNumber === 1
          ? 'Ta carte reste cachée — base ton annonce sur celles que tu vois des autres.'
          : 'Combien de plis vas-tu remporter cette manche ?';
    } else {
      const waiting = state.players.filter((p) => !p.hasBid).map((p) => p.nickname);
      turnIndicator.textContent = waiting.length
        ? `Annonce envoyée (${state.myBid}) — tu peux encore changer d'avis tant que tout le monde n'a pas annoncé. En attente de : ${waiting.join(', ')}…`
        : 'Tout le monde a annoncé, révélation…';
    }
    return;
  }
  // Marcher sur la Planche : tant qu'on désigne sa cible, la consigne est
  // celle-là et rien d'autre. Écrite ICI plutôt que dans appliquerCiblage-
  // Planche parce que renderTurnIndicator passe AVANT renderTrick : les
  // cartes du pli s'écartent des bandes de texte qu'elles trouvent en place,
  // et une consigne posée après coup se serait retrouvée sous l'une d'elles.
  // Courte pour la même raison : la bande ne doit pas s'élargir de moitié.
  if (ciblagePlanche) {
    turnIndicator.textContent = 'Clique le Pirate à jeter par-dessus bord.';
    return;
  }
  if (state.trickPaused) {
    // La consigne est écrite sur le bois, au-dessus du feutre : c'est le seul
    // endroit que l'engloutissement ne traverse pas. Elle dit ce qui est en
    // train de se passer pendant que ça se passe ; le centre du feutre, lui,
    // n'écrit la conséquence qu'une fois le tas effacé.
    const res = state.lastTrickResult;
    if (res && res.destroyed) {
      turnIndicator.textContent = pliDetruit(res.krakenCardId ? 'kraken' : res.destroyedBy, 'cause');
      return;
    }
    turnIndicator.textContent = 'Le pli se ramasse…';
    return;
  }
  if (state.sittingOutThisTrick) {
    turnIndicator.textContent = 'Tu as joué la Dernière Salve : tu avais deux cartes à poser dans un même pli, il ne t\'en reste plus pour celui-ci.';
    return;
  }
  if (!state.isMyTurn) {
    turnIndicator.textContent = `${nicknameOf(state, state.turnPlayerId)} joue…`;
    return;
  }
  // En paysage on a la place de rappeler la couleur demandée dans la consigne,
  // comme sur la maquette : c'est l'info qui manque le plus au moment de jouer.
  const led = landscapeTable.matches ? ledSuitOf(state.currentTrick || []) : null;
  if (!led) {
    turnIndicator.textContent = 'À toi de jouer !';
  } else if (mustFollowSuit(state.hand || [], led)) {
    turnIndicator.innerHTML = `${suitDot(led)} À toi de jouer — tu dois suivre le <b>${led}</b>`;
  } else {
    turnIndicator.innerHTML = `${suitDot(led)} À toi de jouer — tu n'as pas de <b>${led}</b>, joue ce que tu veux`;
  }
}

function hideAllChoicePanels() {
  tigressChoiceEl.classList.add('hidden');
  jokerChoiceEl.classList.add('hidden');
  declareChoiceEl.classList.add('hidden');
  plankChoiceEl.classList.add('hidden');
  // Le ciblage de la Planche vit sur le tapis, pas dans le panneau : le
  // cacher ne suffit pas à éteindre les cartes qu'il a allumées.
  if (ciblagePlanche) {
    ciblagePlanche = null;
    appliquerCiblagePlanche();
  }
}

function playCard(cardId, extra) {
  const payload = { cardId, ...(extra || {}) };
  socket.emit('skullking-play-card', payload);
  pendingTigressCardId = null;
  pendingJokerCardId = null;
  pendingDeclareCardId = null;
  hideAllChoicePanels();
}

btnTigressPirate.addEventListener('click', () => {
  if (pendingTigressCardId) playCard(pendingTigressCardId, { chosenAs: 'pirate' });
});
btnTigressEscape.addEventListener('click', () => {
  if (pendingTigressCardId) playCard(pendingTigressCardId, { chosenAs: 'escape' });
});

// Le cadre couvre tout l'écran : sans porte de sortie, un clic de travers sur
// la Tigresse bloquerait le tour. Fermer ne joue rien — la carte retourne
// simplement dans l'éventail.
function fermerChoixTigresse() {
  pendingTigressCardId = null;
  tigressChoiceEl.classList.add('hidden');
}

document.getElementById('sk-btn-tigress-annuler').addEventListener('click', fermerChoixTigresse);
tigressChoiceEl.addEventListener('click', (e) => {
  if (e.target === tigressChoiceEl) fermerChoixTigresse();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tigressChoiceEl.classList.contains('hidden')) fermerChoixTigresse();
});

// --- Extension : choix au moment de la pose (Joker, 0/14, Marcher sur la Planche) ---

const jokerChoiceEl = document.getElementById('sk-joker-choice');
const declareChoiceEl = document.getElementById('sk-declare-choice');
const plankChoiceEl = document.getElementById('sk-plank-choice');

// --- MARCHER SUR LA PLANCHE : on désigne le Pirate SUR LE TAPIS ---------
//
// C'était une rangée de boutons portant des noms — « Harry le Géant »,
// « Tigresse ». Il fallait donc se rappeler qui avait joué quoi, alors que
// les cartes sont posées devant leur joueur, à l'écran, au même instant. On
// clique maintenant la carte elle-même : la question « qui passe par-dessus
// bord » se répond en regardant le tapis, pas en lisant une liste.
//
// Le ciblage est un état LOCAL : rien n'est envoyé au serveur tant que la
// cible n'est pas choisie. Comme le pli est redessiné à chaque état reçu
// (un message de discussion suffit), la décoration est réappliquée après
// chaque rendu plutôt que posée une fois pour toutes.
let ciblagePlanche = null;

function appliquerCiblagePlanche() {
  tableEl.classList.toggle('sk-table--ciblage', !!ciblagePlanche);
  // La consigne, elle, s'écrit sur le bois au-dessus du feutre (voir
  // renderTurnIndicator) : posée sur le feutre, elle formait un pavé au
  // milieu des cartes qu'elle demande justement de cliquer. Le panneau ne
  // porte plus que la porte de sortie, qui n'a pas besoin de place.
  document.body.classList.toggle('sk-ciblage', !!ciblagePlanche);

  tableEl.querySelectorAll('.sk-trick-card').forEach((slot) => {
    const visee = !!ciblagePlanche && ciblagePlanche.cibles.has(slot.dataset.cardId);
    slot.classList.toggle('sk-trick-card--visee', visee);
    if (visee) {
      slot.setAttribute('role', 'button');
      slot.setAttribute('tabindex', '0');
      slot.setAttribute('aria-label', `Envoyer ${slot.dataset.nomCarte || 'ce Pirate'} par-dessus bord`);
    } else {
      slot.removeAttribute('role');
      slot.removeAttribute('tabindex');
      slot.removeAttribute('aria-label');
    }
  });
}

function annulerCiblagePlanche() {
  ciblagePlanche = null;
  plankChoiceEl.classList.add('hidden');
  appliquerCiblagePlanche();
  // La consigne reprend celle du tour : on a repris la carte en main.
  if (dernierEtatJeu) renderTurnIndicator(dernierEtatJeu);
}

function choisirCiblePlanche(slot) {
  if (!ciblagePlanche || !slot) return;
  const removesId = slot.dataset.cardId;
  if (!ciblagePlanche.cibles.has(removesId)) return;
  const carteId = ciblagePlanche.carteId;
  ciblagePlanche = null;
  playCard(carteId, { removesId });
}

// Un seul écouteur, posé sur le tapis : les cases du pli sont recréées à
// chaque rendu, leur en attacher un chacune les perdrait au premier état
// reçu pendant qu'on hésite.
tableEl.addEventListener('click', (e) => {
  if (!ciblagePlanche) return;
  choisirCiblePlanche(e.target.closest('.sk-trick-card--visee'));
});
tableEl.addEventListener('keydown', (e) => {
  if (!ciblagePlanche || (e.key !== 'Enter' && e.key !== ' ')) return;
  const slot = e.target.closest('.sk-trick-card--visee');
  if (!slot) return;
  e.preventDefault();
  choisirCiblePlanche(slot);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ciblagePlanche) annulerCiblagePlanche();
});
document.getElementById('sk-btn-plank-cancel').addEventListener('click', annulerCiblagePlanche);
let pendingJokerCardId = null;
let pendingDeclareCardId = null;

document.querySelectorAll('.sk-btn-joker-color').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (pendingJokerCardId) playCard(pendingJokerCardId, { chosenSuit: btn.dataset.suit });
  });
});
document.getElementById('sk-btn-declare-0').addEventListener('click', () => {
  if (pendingDeclareCardId) playCard(pendingDeclareCardId, { declaredValue: 0 });
});
document.getElementById('sk-btn-declare-14').addEventListener('click', () => {
  if (pendingDeclareCardId) playCard(pendingDeclareCardId, { declaredValue: 14 });
});

// Mode spécial du pouvoir de Will le Bandit : au lieu de jouer une carte, on
// clique pour choisir 2 cartes à défausser dans sa main (les 2 piochées y
// sont déjà mêlées).
let willDiscardSelection = new Set();
let willConfirmBtn = null;

// Pouvoir de Juanita Jade : les cartes sont retournées une à une par le
// joueur (survol ou tap), pas révélées d'un coup avec un minuteur fixe -
// sans ça il n'y avait pas le temps de toutes les lire. juanitaSessionKey
// identifie l'instance en cours (les ids de cartes changent à chaque
// déclenchement, jamais réutilisés) pour repartir de zéro à chaque fois.
let juanitaSessionKey = null;
let juanitaFlipped = new Set();
let juanitaDoneTimer = null;

function updateWillConfirmButton() {
  if (!willConfirmBtn) return;
  willConfirmBtn.textContent = `Défausser (${willDiscardSelection.size}/2 choisies)`;
  willConfirmBtn.disabled = willDiscardSelection.size !== 2;
}

function renderHand(state) {
  handEl.innerHTML = '';
  // Manche 1, pendant l'annonce : ma carte est posée sur le tapis, face
  // cachée, devant mon nom. La garder AUSSI dans l'éventail la montrait deux
  // fois — deux dos de carte pour la seule carte que j'aie en main. Elle
  // revient dans la main dès qu'il faut la jouer.
  if (state.phase === 'bidding' && (state.hand || []).some((c) => c.kind === 'hidden')) return;
  const hand = sortHandForDisplay(state.hand || []);
  const canPlay = state.phase === 'playing' && state.isMyTurn;
  const willMode = state.phase === 'power' && state.pendingPower && state.pendingPower.kind === 'will' && state.pendingPower.mine;
  const willDrawnIds = willMode ? new Set(state.pendingPower.drawnCardIds || []) : null;
  const trick = state.currentTrick || [];

  const n = hand.length;
  const maxSpread = Math.min(6 * Math.max(n - 1, 0), 40);
  const step = n > 1 ? maxSpread / (n - 1) : 0;

  hand.forEach((card, i) => {
    const angle = n > 1 ? -maxSpread / 2 + i * step : 0;
    const normalized = n > 1 ? Math.abs(i - (n - 1) / 2) / ((n - 1) / 2) : 0;
    const lift = normalized * normalized * 8;

    const arc = document.createElement('div');
    arc.className = 'sk-card-arc';
    arc.style.transform = `rotate(${angle}deg) translateY(${lift}px)`;

    const el = document.createElement('div');
    el.className = `sk-card ${cardClass(card)}`;
    el.innerHTML = cardFaceHTML(card);
    attachPowerTooltip(el, card);
    // Pouvoir de Mary Thorne : une seule carte précise reste jouable, peu
    // importe la couleur imposée ou tout autre effet.
    const playable = !canPlay || (state.forcedCardId ? card.id === state.forcedCardId : isCardPlayable(card, hand, trick));
    if (canPlay && !playable) {
      el.classList.add('sk-card--unplayable');
      el.title = state.forcedCardId
        ? 'Le pouvoir de Mary Thorne t\'oblige à jouer une autre carte précise ce pli-ci.'
        : 'Tu dois suivre la couleur demandée : cette carte est bloquée tant que tu en as une en main.';
      // Un bandeau de gabier collé sur la carte, plutôt qu'un message en
      // haut de page : au doigt, le toast apparaissait à 700 px du doigt et
      // on retapait trois fois la même carte avant de comprendre.
      const led = ledSuitOf(trick);
      const why = document.createElement('span');
      why.className = 'sk-card__why';
      why.textContent = state.forcedCardId ? 'Carte imposée' : `Suis le ${led}`;
      el.appendChild(why);
    }
    if (willMode) {
      // Repère les deux cartes tout juste piochées au milieu du reste de la
      // main - sans ça, rien ne les distingue une fois mêlées à l'éventail.
      if (willDrawnIds.has(card.id)) el.classList.add('sk-card--will-drawn');
      if (willDiscardSelection.has(card.id)) el.classList.add('sk-card--selected');
      el.addEventListener('click', () => {
        if (willDiscardSelection.has(card.id)) willDiscardSelection.delete(card.id);
        else if (willDiscardSelection.size < 2) willDiscardSelection.add(card.id);
        renderHand(state);
        updateWillConfirmButton();
      });
    } else if (canPlay && !playable) {
      // La raison est déjà collée sur la carte (bandeau de gabier) ; le
      // message reprend la couleur imposée plutôt qu'une règle générale.
      el.addEventListener('click', () => {
        if (suppressNextTap) return;
        const led = ledSuitOf(trick);
        showToast(
          state.forcedCardId
            ? "Mary Thorne t'oblige à jouer une autre carte ce pli-ci."
            : `Tu dois suivre le ${led} : cette carte reste bloquée tant que tu en as une.`
        );
      });
    } else if (canPlay) {
      el.addEventListener('click', () => {
        if (suppressNextTap) return;
        if (card.kind === 'tigress') {
          pendingTigressCardId = card.id;
          hideAllChoicePanels();
          tigressChoiceEl.classList.remove('hidden');
          bidChoices.classList.add('hidden');
          return;
        }
        // 0/14 : la valeur n'est jamais fixée avant la pose.
        if (card.kind === 'number' && card.wild14 && card.value == null) {
          pendingDeclareCardId = card.id;
          hideAllChoicePanels();
          declareChoiceEl.classList.remove('hidden');
          bidChoices.classList.add('hidden');
          return;
        }
        // Joker : choix de couleur seulement si rien n'est encore imposé
        // (sinon le serveur prend directement la couleur déjà imposée, ou
        // le laisse sans couleur si c'est le noir).
        if (card.kind === 'wild15') {
          const led = ledSuitOf(trick);
          if (led === null) {
            pendingJokerCardId = card.id;
            hideAllChoicePanels();
            jokerChoiceEl.classList.remove('hidden');
            bidChoices.classList.add('hidden');
            return;
          }
          playCard(card.id);
          return;
        }
        // Marcher sur la Planche : choix du Pirate à retirer seulement s'il
        // y en a plusieurs dans le pli en cours. Une Tigresse compte comme
        // candidate potentielle même si on ne sait pas si elle a été jouée
        // comme Pirate ou comme Fuite : ce choix (chosenAs) reste caché aux
        // autres joueurs pour préserver son bluff (voir stateFor côté
        // serveur), donc le client ne peut pas trancher lui-même. Le serveur
        // connaît la vraie réponse et valide/complète le choix (voir
        // eligiblePlankTargets côté serveur) : s'il n'y a qu'une vraie cible
        // possible il l'impose de toute façon, quoi que le joueur ait cliqué.
        if (card.kind === 'plank') {
          const piratesInTrick = trick.filter(
            (t) => t.card.kind === 'pirate' || t.card.kind === 'tigress'
          );
          if (piratesInTrick.length > 1) {
            hideAllChoicePanels();
            ciblagePlanche = {
              carteId: card.id,
              cibles: new Set(piratesInTrick.map((t) => t.card.id)),
            };
            appliquerCiblagePlanche();
            renderTurnIndicator(state);
            plankChoiceEl.classList.remove('hidden');
            bidChoices.classList.add('hidden');
            return;
          }
          playCard(card.id);
          return;
        }
        playCard(card.id);
      });
    }

    arc.appendChild(el);
    handEl.appendChild(arc);
  });

  // Mon tour : la main s'allume. C'est de la vision périphérique, pas de la
  // lecture — le texte de consigne, lui, est au centre et se rate.
  handEl.classList.toggle('sk-hand--mine', canPlay);
  layoutHand();
}

// Chevauchement de l'éventail, calculé sur la place réellement disponible.
// Une carte recouverte n'expose que sa bande gauche : on ne recouvre donc
// que si la rangée déborde, et jamais au point de manger le pied, qui est
// le seul endroit où se lisent le chiffre et le motif de famille.
// La borne haute est la largeur du pied plus sa marge : au-delà, on
// préfère laisser la main défiler plutôt que rendre les cartes muettes.
function layoutHand() {
  const cards = handEl.querySelectorAll('.sk-card-arc');
  const n = cards.length;
  if (!n) return;
  const first = cards[0].firstElementChild;
  const w = first ? first.getBoundingClientRect().width : 84;
  if (!w) return;
  const styles = getComputedStyle(handEl);
  const room =
    handEl.clientWidth - parseFloat(styles.paddingLeft || 0) - parseFloat(styles.paddingRight || 0);
  const GUTTER = 8;
  const MAX_LAP = Math.round(w * 0.36); // il reste au moins 64 % de la carte
  let lap = -GUTTER;
  if (n > 1) {
    const needed = n * w + (n - 1) * GUTTER;
    if (needed > room) lap = Math.min(MAX_LAP, Math.ceil((n * w - room) / (n - 1)));
  }
  handEl.style.setProperty('--lap', `${lap}px`);
}

// La largeur disponible change avec la fenêtre : l'éventail se recalcule,
// sinon il reste chevauché après un agrandissement (ou déborde après une
// réduction).
let handLayoutTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(handLayoutTimer);
  handLayoutTimer = setTimeout(() => {
    layoutHand();
    const row = powerPanel.querySelector('.sk-juanita-row');
    if (row) ajusterGrilleJuanita(row, row.childElementCount);
  }, 120);
});

// Grille de Juanita Jade : on cherche la plus grande carte telle que les
// `n` cartes tiennent ENTIÈREMENT dans le panneau, sans une seule ligne de
// défilement. La hauteur suit la largeur (ratio 7:10, celui de toutes les
// cartes du jeu) et le reste de l'habillage — pied, chiffre, sceau, équerre —
// est mis à la même échelle par --sk-flip-k, sinon une carte de 30 px se
// retrouve avec un pied de 30 px.
const JUANITA_GAP = 6;
function ajusterGrilleJuanita(row, n) {
  if (!n) return;
  requestAnimationFrame(() => {
    if (!row.isConnected) return;
    const dispo = row.getBoundingClientRect();
    const panneau = powerPanel.getBoundingClientRect();
    const styles = getComputedStyle(powerPanel);
    // Hauteur laissée à la grille : le panneau moins ce qui l'accompagne
    // (la consigne au-dessus, le bouton de sortie en dessous).
    let occupe = parseFloat(styles.paddingTop || 0) + parseFloat(styles.paddingBottom || 0);
    [...powerPanel.children].forEach((el) => {
      if (el !== row) occupe += el.getBoundingClientRect().height + JUANITA_GAP;
    });
    const largeurDispo = dispo.width || panneau.width;
    const hauteurDispo = panneau.height - occupe;
    if (largeurDispo <= 0 || hauteurDispo <= 0) return;

    let choisie = 26;
    for (let w = 96; w >= 26; w -= 1) {
      const h = w / 0.7;
      const colonnes = Math.max(1, Math.floor((largeurDispo + JUANITA_GAP) / (w + JUANITA_GAP)));
      const lignes = Math.ceil(n / colonnes);
      if (lignes * h + (lignes - 1) * JUANITA_GAP <= hauteurDispo) {
        choisie = w;
        break;
      }
    }
    row.style.setProperty('--sk-flip-w', choisie + 'px');
    row.style.setProperty('--sk-flip-k', (choisie / 84).toFixed(3));
  });
}

// « Ce qu'il te reste à faire » : la phrase qu'on se répète en jouant et qui
// n'était écrite nulle part. Réécrite à chaque pli, elle dit combien de plis
// il reste à prendre et avec combien de cartes — et surtout quand l'annonce
// est déjà perdue, ce qui change complètement la façon de jouer la fin de
// manche (on cherche alors à en donner, plus à en prendre).
const objectiveEl = document.getElementById('sk-objective');
const objectiveTextEl = document.getElementById('sk-objective-text');

function objectiveState(state) {
  const me = state.players.find((p) => p.id === myId);
  if (!me) return null;

  if (state.phase === 'bidding') {
    return me.hasBid
      ? { ton: 'ok', texte: 'Annonce envoyée. On attend les autres.' }
      : { ton: 'todo', texte: 'Annonce combien de plis tu comptes remporter.' };
  }
  if (state.phase !== 'playing' && state.phase !== 'power') return null;
  if (me.bid == null) return null;

  const reste = me.bid - (me.tricksWon || 0);
  const cartes = (state.hand || []).length;

  if (reste < 0) {
    const trop = -reste;
    return { ton: 'perdu', texte: `Annonce dépassée de ${trop} pli${trop > 1 ? 's' : ''} — la manche est perdue, limite les dégâts.` };
  }
  if (reste === 0) {
    if (cartes === 0) return { ton: 'ok', texte: 'Annonce tenue ! Manche réussie.' };
    return { ton: 'ok', texte: `N'en prends plus aucun — encore ${cartes} carte${cartes > 1 ? 's' : ''} à écouler.` };
  }
  if (reste > cartes) {
    return { ton: 'perdu', texte: `Il te faudrait ${reste} plis mais il ne te reste que ${cartes} carte${cartes > 1 ? 's' : ''} : c'est déjà manqué.` };
  }
  if (reste === cartes) {
    return { ton: 'tendu', texte: `Il faut remporter tous tes ${cartes} derniers plis. Aucune marge.` };
  }
  return { ton: 'todo', texte: `Encore ${reste} pli${reste > 1 ? 's' : ''} à prendre, avec ${cartes} carte${cartes > 1 ? 's' : ''} en main.` };
}

function renderObjective(state) {
  const o = objectiveState(state);
  if (!o) {
    objectiveEl.classList.add('hidden');
    return;
  }
  objectiveEl.classList.remove('hidden');
  objectiveEl.className = `sk-objective sk-objective--${o.ton}`;

  // Les nombres sont ce qu'on vient lire ici : combien de plis il reste à
  // prendre, combien de cartes en main. On les détache du reste de la
  // phrase. Construit en noeuds plutôt qu'en innerHTML — la règle du
  // fichier, tenue même quand le texte est fabriqué localement.
  objectiveTextEl.textContent = '';
  o.texte.split(/(\d+)/).forEach((bout, i) => {
    if (!bout) return;
    if (i % 2 === 1) {
      const n = document.createElement('b');
      n.className = 'sk-obj-n';
      n.textContent = bout;
      objectiveTextEl.appendChild(n);
    } else {
      objectiveTextEl.appendChild(document.createTextNode(bout));
    }
  });
}

// --- Chat du salon ---
// Les messages sont posés en textContent, jamais en innerHTML : le texte
// vient d'un autre joueur et le serveur le stocke tel quel (il ne fait que
// borner la longueur et écraser les espaces). C'est ici, au rendu, que se
// joue la sécurité — deux failles XSS ont déjà été trouvées dans ce projet
// par ce chemin exact.
// Deux endroits où la discussion s'écrit et se lit : la planche du salon et
// le carnet de la table. Ce sont deux vues du MÊME fil — le serveur n'en
// connaît qu'un, et l'historique arrive avec l'état comme avant. D'où une
// liste de vues plutôt qu'un couple de variables : chaque message est posé
// dans toutes, une seule fois (chatSeen est commun).
const chatSeen = new Set();
const CHAT_VUES = [
  {
    log: document.getElementById('sk-chat-log'),
    form: document.getElementById('sk-chat-form'),
    input: document.getElementById('sk-chat-input'),
  },
  {
    log: document.getElementById('sk-lobby-chat-log'),
    form: document.getElementById('sk-lobby-chat-form'),
    input: document.getElementById('sk-lobby-chat-input'),
  },
].filter((v) => v.log && v.form && v.input);


function chatHeure(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function chatAuBas(log) {
  // Ne recolle en bas que si on y était déjà : sinon on arrache la lecture à
  // quelqu'un en train de remonter l'historique.
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}

// Une ligne neuve à chaque vue : un même nœud ne peut pas être dans deux
// endroits du document à la fois.
function ligneChat(m) {
  const ligne = document.createElement('div');
  ligne.className = 'sk-chat-line' + (m.playerId === myId ? ' sk-chat-line--me' : '');

  const tete = document.createElement('span');
  tete.className = 'sk-chat-who';
  tete.textContent = m.playerId === myId ? 'Toi' : m.nickname;
  const heure = document.createElement('span');
  heure.className = 'sk-chat-time';
  heure.textContent = chatHeure(m.at);
  tete.appendChild(heure);

  const corps = document.createElement('span');
  corps.className = 'sk-chat-text';
  corps.textContent = m.text;

  ligne.append(tete, corps);
  return ligne;
}

function ajouterMessage(m) {
  if (!m || chatSeen.has(m.id)) return;
  chatSeen.add(m.id);
  CHAT_VUES.forEach((vue) => {
    const colle = chatAuBas(vue.log);
    vue.log.appendChild(ligneChat(m));
    while (vue.log.childElementCount > 80) vue.log.removeChild(vue.log.firstChild);
    if (colle) vue.log.scrollTop = vue.log.scrollHeight;
  });
}

function renderChat(state) {
  (state.chat || []).forEach(ajouterMessage);
}

socket.on('skullking-chat-message', ajouterMessage);

CHAT_VUES.forEach((vue) => {
  vue.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = vue.input.value.trim();
    if (!text) return;
    socket.emit('skullking-chat', { text });
    vue.input.value = '';
  });
});

function renderScoreboard(state) {
  renderObjective(state);
  renderChat(state);
  scoreboardRows.innerHTML = '';
  const byId = new Map(state.players.map((p) => [p.id, p]));
  // Rang calculé à part : c'est lui qui bouge, jamais la place de la ligne.
  const ranks = new Map();
  [...state.scoreboard]
    .sort((a, b) => b.total - a.total)
    .forEach((s, i) => ranks.set(s.id, i + 1));
  // L'ordre affiché est celui du tour de table, figé pour toute la partie.
  const byPlayerOrder = state.players
    .map((p) => state.scoreboard.find((s) => s.id === p.id))
    .filter(Boolean);
  byPlayerOrder
    .forEach((s) => {
      const row = document.createElement('div');
      row.className = 'sk-score-row' + (s.id === myId ? ' sk-score-row--me' : '');
      // Le registre porte la PIÈCE du joueur, pas son pseudo : à 9 joueurs les
      // noms étaient tronqués à trois lettres et ne servaient plus à rien,
      // alors que le médaillon est le même repère que sur le tapis, dans la
      // roue et au bout de la courbe. Le pseudo reste lisible au survol et
      // pour un lecteur d'écran — il n'a pas disparu, il a quitté l'aplomb.
      const name = document.createElement('span');
      name.className = 'sk-score-row-name';
      name.title = s.nickname;
      const rank = document.createElement('i');
      rank.className = 'sk-rank';
      rank.textContent = ROMAN[ranks.get(s.id)] || '';
      name.appendChild(rank);
      const piece = pieceFor(byId.get(s.id) || s);
      const medaillon = document.createElement('span');
      medaillon.className = 'sk-score-row-piece';
      medaillon.innerHTML = pieceSVG(piece);
      name.appendChild(medaillon);
      const nom = document.createElement('span');
      nom.className = 'visually-hidden';
      nom.textContent = s.nickname;
      name.appendChild(nom);
      const total = document.createElement('span');
      total.className = 'sk-score-row-total';
      total.textContent = s.total;
      row.appendChild(name);

      // Colonne plis/annonce : en paysage le tableau devient le vrai poste de
      // pilotage, on y lit d'un coup qui tient son contrat et qui l'a déjà raté.
      const p = byId.get(s.id);
      if (p) {
        const bidState = bidStateSuffix(state, p);
        const bidEl = document.createElement('span');
        bidEl.className = 'sk-score-row-bid' + (bidState ? ` sk-score-row-bid${bidState}` : '');
        if (state.phase === 'bidding') bidEl.textContent = p.hasBid ? '✓' : '…';
        else bidEl.textContent = p.bid === undefined || p.bid === null ? '–' : `${p.tricksWon} sur ${p.bid}`;
        row.appendChild(bidEl);
      }

      row.appendChild(total);
      scoreboardRows.appendChild(row);
    });

  // Rien à consulter tant qu'aucune manche n'est terminée.
  btnHistory.classList.toggle('hidden', state.roundNumber <= 1);
}

// --- Pouvoirs des pirates nommés ---

const powerBanner = document.getElementById('sk-power-banner');
const powerPanel = document.getElementById('sk-power-panel');
const POWER_LABEL = {
  rosie: "Rosie la Douce",
  will: 'Will le Bandit',
  rascal: 'Rascal le Flambeur',
  juanita: 'Juanita Jade',
  harry: 'Harry le Géant',
  marythorne: 'Mary Thorne',
};

function renderPower(state) {
  powerBanner.classList.add('hidden');
  powerPanel.classList.add('hidden');
  powerPanel.classList.remove('sk-power-panel--juanita');
  powerPanel.innerHTML = '';
  willConfirmBtn = null;

  const pending = state.pendingPower;
  if (state.phase !== 'power' || !pending) {
    willDiscardSelection.clear();
    juanitaSessionKey = null;
    juanitaFlipped.clear();
    clearTimeout(juanitaDoneTimer);
    return;
  }
  if (pending.kind !== 'juanita') {
    juanitaSessionKey = null;
    juanitaFlipped.clear();
    clearTimeout(juanitaDoneTimer);
  }

  powerBanner.textContent = `${nicknameOf(state, pending.playerId)} déclenche le pouvoir de ${POWER_LABEL[pending.kind]} !`;
  powerBanner.classList.remove('hidden');

  if (!pending.mine) {
    willDiscardSelection.clear();
    return;
  }
  powerPanel.classList.remove('hidden');

  const hint = document.createElement('p');
  hint.className = 'hint';
  powerPanel.appendChild(hint);

  if (pending.kind === 'rosie') {
    hint.textContent = 'Qui entame le pli suivant ?';
    pending.options.forEach((o) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = o.id === myId ? `${o.nickname} (toi)` : o.nickname;
      btn.addEventListener('click', () => socket.emit('skullking-power-rosie', { leaderId: o.id }));
      powerPanel.appendChild(btn);
    });
  } else if (pending.kind === 'marythorne') {
    hint.textContent = "Dans la main de qui tirer une carte au hasard (à jouer obligatoirement au pli suivant) ?";
    pending.options.forEach((o) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.disabled = o.handCount === 0;
      btn.textContent = `${o.id === myId ? `${o.nickname} (toi)` : o.nickname} — ${o.handCount} carte${o.handCount > 1 ? 's' : ''}`;
      btn.addEventListener('click', () => socket.emit('skullking-power-marythorne', { targetId: o.id }));
      powerPanel.appendChild(btn);
    });
  } else if (pending.kind === 'rascal') {
    hint.textContent = 'Mise secondaire sur ta propre annonce de cette manche :';
    [0, 10, 20].forEach((stake) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = stake === 0 ? 'Ne pas miser' : `Miser ${stake}`;
      btn.addEventListener('click', () => socket.emit('skullking-power-rascal', { stake }));
      powerPanel.appendChild(btn);
    });
  } else if (pending.kind === 'harry') {
    hint.textContent = `Ton annonce actuelle : ${pending.currentBid}. La modifier ?`;
    [-1, 0, 1].forEach((delta) => {
      const newBid = pending.currentBid + delta;
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = delta === 0 ? 'Ne pas changer' : `${delta > 0 ? '+1' : '-1'} (→ ${newBid})`;
      btn.disabled = newBid < 0 || newBid > state.cardsInRound;
      btn.addEventListener('click', () => socket.emit('skullking-power-harry', { delta }));
      powerPanel.appendChild(btn);
    });
  } else if (pending.kind === 'juanita') {
    const cards = pending.revealCards || [];
    const key = cards.map((c) => c.id).join(',');
    if (juanitaSessionKey !== key) {
      juanitaSessionKey = key;
      juanitaFlipped.clear();
      clearTimeout(juanitaDoneTimer);
    }
    // Le pouvoir montre TOUT le reste du paquet : jusqu'à 85 cartes aux
    // premières manches. Dans la barre du bas de l'écran, elles débordaient
    // et il fallait descendre puis faire défiler le panneau pour en voir la
    // moitié. La grille passe donc au centre de l'écran, et les cartes sont
    // taillées à la volée pour tenir d'un seul tenant (voir ajusterGrilleJuanita).
    powerPanel.classList.add('sk-power-panel--juanita');
    const majHint = () => {
      hint.textContent =
        juanitaFlipped.size === cards.length
          ? 'Toutes retournées — la partie reprend dans un instant…'
          : `Cartes non distribuées ce tour-ci — survole (ou touche) chacune pour la retourner (${juanitaFlipped.size}/${cards.length}).`;
    };
    majHint();
    const row = document.createElement('div');
    // Plus de classe .sk-hand ici : elle apportait tout l'habillage de
    // l'éventail (défilement horizontal, hauteur minimale, survol qui
    // soulève la carte) à une grille qui n'en est pas un.
    row.className = 'sk-juanita-row';
    cards.forEach((card) => {
      const flip = document.createElement('div');
      flip.className = 'sk-flip-card' + (juanitaFlipped.has(card.id) ? ' sk-flip-card--flipped' : '');
      const inner = document.createElement('div');
      inner.className = 'sk-flip-card-inner';
      const back = document.createElement('div');
      back.className = 'sk-flip-card-face sk-flip-card-back';
      const front = document.createElement('div');
      front.className = `sk-flip-card-face sk-card ${cardClass(card)}`;
      front.innerHTML = cardFaceHTML(card);
      attachPowerTooltip(front, card);
      inner.appendChild(back);
      inner.appendChild(front);
      flip.appendChild(inner);
      // Une carte retournée le reste : le survol ne fait que la découvrir,
      // il ne la referme jamais (ni en repassant dessus, ni en s'en allant).
      const reveal = () => {
        if (juanitaFlipped.has(card.id)) return;
        juanitaFlipped.add(card.id);
        flip.classList.add('sk-flip-card--flipped');
        flip.title = 'Déjà retournée — elle reste face visible';
        majHint();
        if (juanitaFlipped.size === cards.length) {
          clearTimeout(juanitaDoneTimer);
          juanitaDoneTimer = setTimeout(() => socket.emit('skullking-power-juanita-done'), 2000);
        }
      };
      flip.addEventListener('mouseenter', reveal);
      flip.addEventListener('click', reveal);
      row.appendChild(flip);
    });
    powerPanel.appendChild(row);

    // Le panneau couvre maintenant l'écran : il lui faut une sortie, sinon on
    // attend les 25 s du minuteur serveur sans rien pouvoir faire.
    const doneBtn = document.createElement('button');
    doneBtn.className = 'btn sk-juanita-done';
    doneBtn.textContent = "J'ai fini de regarder";
    doneBtn.addEventListener('click', () => {
      clearTimeout(juanitaDoneTimer);
      socket.emit('skullking-power-juanita-done');
    });
    powerPanel.appendChild(doneBtn);

    ajusterGrilleJuanita(row, cards.length);
  } else if (pending.kind === 'will') {
    hint.textContent = 'Tu piochais 2 cartes non distribuées, les voici — elles ont rejoint ta main. Choisis 2 cartes à défausser ci-dessous (parmi toute ta main, pas forcément celles-ci).';
    const drawnIds = new Set(pending.drawnCardIds || []);
    const drawnRow = document.createElement('div');
    drawnRow.className = 'sk-hand sk-will-drawn-row';
    (state.hand || [])
      .filter((card) => drawnIds.has(card.id))
      .forEach((card) => {
        const el = document.createElement('div');
        el.className = `sk-card sk-card--will-drawn ${cardClass(card)}`;
        el.innerHTML = cardFaceHTML(card);
        attachPowerTooltip(el, card);
        drawnRow.appendChild(el);
      });
    powerPanel.appendChild(drawnRow);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn';
    confirmBtn.disabled = true;
    confirmBtn.addEventListener('click', () => {
      if (willDiscardSelection.size === 2) {
        socket.emit('skullking-power-will', { discardIds: [...willDiscardSelection] });
        willDiscardSelection.clear();
      }
    });
    powerPanel.appendChild(confirmBtn);
    willConfirmBtn = confirmBtn;
    updateWillConfirmButton();
  }
}

// Petite pile au centre de la table qui distribue une carte à chacun, dans
// l'ordre des sièges, au tout début de chaque manche — purement décoratif
// (le serveur a déjà distribué les vraies mains). Plafonné à quelques tours
// de distribution : à 7 joueurs sur la manche 10, animer les 70 cartes une
// par une traînerait inutilement en longueur.
let lastDealAnimatedRound = null;
const DEAL_MAX_WAVES = 5;
const DEAL_WAVE_MS = 190;
const DEAL_FLIGHT_MS = 620;

const roundStartBanner = document.getElementById('sk-round-start-banner');
const roundStartText = document.getElementById('sk-round-start-text');
let roundStartTimer = null;

// Bannière éphémère "Manche N", en plus du compteur permanent en haut de
// l'écran — juste pour marquer le coup au changement de manche.
function showRoundStartBanner(roundNumber) {
  clearTimeout(roundStartTimer);
  roundStartText.textContent = `Manche ${roundNumber}`;
  roundStartBanner.classList.remove('hidden');
  // Relance l'animation CSS même si la bannière était déjà affichée.
  const span = roundStartText;
  span.style.animation = 'none';
  void span.offsetWidth;
  span.style.animation = '';
  roundStartTimer = setTimeout(() => roundStartBanner.classList.add('hidden'), 1800);
}

// --- Révélation des annonces ---
// La phase serveur passe de 'bidding' à 'playing' en un seul saut dès la
// dernière annonce reçue (voir skullking-room.js) : sans ce petit temps fort
// après coup, les chiffres apparaissaient tous en même temps dans le tableau
// des scores, sans qu'on ait eu le temps de les lire.
const bidRevealEl = document.getElementById('sk-bid-reveal');
const bidRevealRows = document.getElementById('sk-bid-reveal-rows');
let bidRevealTimer = null;
let lastPhase = null;

// Les annonces étaient secrètes : on les retourne, une par une, comme des
// cartes posées face cachée. Une pastille qui apparaît disait la même chose
// sans raconter le geste - c'est le retournement qui fait le petit moment.
function showBidReveal(state) {
  clearTimeout(bidRevealTimer);
  bidRevealRows.innerHTML = '';
  const STEP_MS = 260;

  state.players.forEach((p, i) => {
    const slot = document.createElement('div');
    slot.className = 'sk-bid-slot';

    const card = document.createElement('div');
    card.className = 'sk-bid-card';
    card.style.setProperty('--sk-bid-delay', `${i * STEP_MS}ms`);

    const inner = document.createElement('div');
    inner.className = 'sk-bid-card-inner';

    const back = document.createElement('div');
    back.className = 'sk-bid-card-face sk-bid-card-back';

    const front = document.createElement('div');
    front.className = 'sk-bid-card-face sk-bid-card-front';
    // Le chiffre est PEINT, une plaque par valeur : c'est ce que la planche
    // des annonces sait faire de mieux et qu'aucune police ne rendra. Elle ne
    // va que de 0 à 9 ; une annonce de 10 (possible à la dernière manche)
    // retombe donc sur la plaque de parchemin d'avant, chiffre écrit en DOM.
    if (p.bid >= 0 && p.bid <= 9) {
      front.style.setProperty('--sk-annonce', `url('assets/skin/annonce-${p.bid}.webp')`);
      // Le crâne casqué du bas de la plaque reçoit la pièce du joueur : le
      // même médaillon que sur son siège, sur la roue et au bout de sa courbe
      // du récap. C'est lui qui rattache l'annonce à quelqu'un, le pseudo
      // en dessous ne fait que le nommer.
      const piece = PIECE_BY_KEY[p.piece] || pieceFor(p);
      const jeton = document.createElement('img');
      jeton.className = 'sk-bid-piece';
      jeton.src = `assets/skin/piece-${piece.key}.webp`;
      jeton.alt = '';
      jeton.setAttribute('aria-hidden', 'true');
      front.appendChild(jeton);
    } else {
      front.classList.add('sk-bid-card-front--nombre');
      const num = document.createElement('span');
      num.className = 'sk-bid-card-num';
      num.textContent = p.bid;
      front.appendChild(num);
    }

    inner.append(back, front);
    card.appendChild(inner);

    const nom = document.createElement('span');
    nom.className = 'sk-bid-nom';
    nom.textContent = p.id === myId ? 'Toi' : p.nickname;
    nom.style.color = couleurJoueur(p);

    slot.append(card, nom);
    bidRevealRows.appendChild(slot);
  });

  bidRevealEl.classList.remove('hidden');

  // Le retournement est une animation CSS (animation-delay en cascade) et
  // non une transition déclenchée en JS : une transition aurait exigé de
  // peindre l'état "face cachée" avant de basculer la classe, donc un
  // double requestAnimationFrame - or rAF est gelé dans un onglet en
  // arrière-plan, et les annonces se révèlent justement pendant qu'on peut
  // avoir la tête ailleurs. L'animation, elle, part toute seule.

  const total = 1500 + state.players.length * STEP_MS;
  bidRevealTimer = setTimeout(() => bidRevealEl.classList.add('hidden'), total);
}

function maybeAnimateDeal(state) {
  if (state.phase !== 'bidding' || state.roundNumber === lastDealAnimatedRound) return;
  lastDealAnimatedRound = state.roundNumber;
  showRoundStartBanner(state.roundNumber);

  const { ordered, map } = seatLayout(state);
  const waves = Math.min(state.cardsInRound, DEAL_MAX_WAVES);

  const centre = surFeutre(0.5, 0.5);
  const pile = document.createElement('div');
  pile.className = 'sk-deck-pile';
  pile.style.left = `${centre.x}%`;
  pile.style.top = `${centre.y}%`;
  tableEl.appendChild(pile);

  let i = 0;
  for (let w = 0; w < waves; w++) {
    ordered.forEach((p) => {
      const [left, top] = map.get(p.id);
      const arrivee = surFeutre(left / 100, top / 100);
      const card = document.createElement('div');
      card.className = 'sk-flying-card';
      tableEl.appendChild(card);
      const anim = card.animate(
        [
          { left: `${centre.x}%`, top: `${centre.y}%`, transform: 'translate(-50%, -50%) scale(0.8)', opacity: 0 },
          { left: `${centre.x}%`, top: `${centre.y}%`, transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.15 },
          { left: `${arrivee.x}%`, top: `${arrivee.y}%`, transform: 'translate(-50%, -50%) scale(0.8)', opacity: 1 },
        ],
        { duration: DEAL_FLIGHT_MS, delay: i * DEAL_WAVE_MS, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' }
      );
      anim.onfinish = () => card.remove();
      i += 1;
    });
  }
  setTimeout(() => pile.remove(), i * DEAL_WAVE_MS + DEAL_FLIGHT_MS + 150);
}

// Efface ce que le dernier pli a laissé sur le tapis. Appelé quand on cesse
// de rendre le tapis (fin de manche) : le rendu normal s'en charge tout seul
// le reste du temps.
function clearTrickTable() {
  tableEl.querySelectorAll('.sk-trick-card').forEach((el) => el.remove());
  trickCaptionEl.textContent = '';
}

function renderGame(state) {
  latestState = state;
  // Un re-rendu retire les cartes du DOM sans forcément déclencher mouseleave
  // (ex: une carte jouée disparaît sous le curseur) : la bulle resterait
  // affichée sur rien sans ce reset.
  hideCardTooltip();
  renderRoundIndicator(state);
  renderMine(state);
  btnEndGame.classList.toggle('hidden', !state.isHost);
  maybeAnimateDeal(state);
  // AVANT renderTrick : les cartes du pli se posent en couronne autour du
  // feutre et doivent contourner les bandes de texte qui le traversent — la
  // consigne du tour et la bannière de pouvoir. Rendues après, elles étaient
  // encore vides au moment de la mesure, donc hautes de zéro pixel, et la
  // première carte du haut venait se poser dessus.
  renderPower(state);
  renderTurnIndicator(state);
  renderSeats(state);
  renderTrick(state);
  // Après renderTrick : l'animation mesure la position réelle des cases du
  // pli, elles doivent donc déjà être dans le DOM.
  playPlankAnimation(state);
  playDevourAnimation(state);
  playDavyAnimation(state);
  playKrakenAnimation(state);
  playTrickWinAnimation(state);
  // Les cases du pli viennent d'être recréées : si on est en train de
  // désigner un Pirate, elles doivent se rallumer.
  appliquerCiblagePlanche();
  renderBidChoices(state);
  renderHand(state);
  renderScoreboard(state);
  // En dernier : le feutre vient d'être mis à sa taille, c'est le moment où
  // le mesurer donne la bonne réponse.
  publierCentreDuPlateau();
}

// Basculer entre portrait et paysage change la géométrie du tapis : on
// redessine pour que les sièges suivent au lieu de rester sur l'ancienne table.
landscapeTable.addEventListener('change', () => {
  if (latestState) renderGame(latestState);
});

btnEndGame.addEventListener('click', () => socket.emit('skullking-end-game'));

// --- Pop-up de fin de manche ---

const roundPopup = document.getElementById('sk-round-popup');
const roundPopupTitle = document.getElementById('sk-round-popup-title');
const roundPopupRows = document.getElementById('sk-round-popup-rows');
const roundPopupBar = document.getElementById('sk-round-popup-bar');
const btnNextRound = document.getElementById('sk-btn-next-round');

btnNextRound.addEventListener('click', () => socket.emit('skullking-next-round'));

// Détail du calcul (contrat + bonus + mise Rascal + alliance Butin) : sans
// ça le delta total n'explique rien, surtout quand un bonus de capture
// (14/Pirates/Skull King) ou un pouvoir a modifié le résultat.
function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}
function roundBreakdownText(r) {
  const parts = [`${signed(r.base)} contrat`];
  if (r.bonus) parts.push(`${signed(r.bonus)} bonus`);
  if (r.rascalDelta) parts.push(`${signed(r.rascalDelta)} mise Rascal`);
  if (r.lootBonus) parts.push(`${signed(r.lootBonus)} alliance Butin`);
  return parts.join(' · ');
}

// Marque les lignes d'une alliance Butin dans le récapitulatif de fin de
// manche. Un trait tracé entre les deux lignes a été essayé puis abandonné :
// illisible dès que d'autres joueurs s'intercalaient, et redondant avec le
// pictogramme désormais affiché sur les sièges pendant toute la manche.
function markLootRows(links) {
  if (!links || !links.length) return;
  links.forEach((link) => {
    const paid = link.paid !== false;
    [link.a, link.b].forEach((id) => {
      const row = roundPopupRows.querySelector(`[data-player-id="${id}"]`);
      if (!row) return;
      row.classList.add('sk-round-popup-row--loot');
      const coin = document.createElement('span');
      coin.className = 'sk-round-popup-loot';
      // Alliance qui a payé (les deux annonces réussies) contre alliance
      // formée mais restée sans effet : la distinction vaut d'être gardée.
      coin.textContent = paid ? '💰' : '🤝';
      coin.title = paid ? 'Alliance Butin réussie (+20)' : 'Alliance Butin formée, sans bonus';
      row.appendChild(coin);
    });
  });
}

function showRoundPopup(state) {
  const summary = state.roundSummary;
  const mine = summary.results.find((r) => r.id === myId);
  if (mine) myRoundResults.set(summary.round, mine.bid === mine.made);
  roundPopupTitle.textContent = `Manche ${summary.round} terminée`;
  roundPopupRows.innerHTML = '';

  [...summary.results]
    .sort((a, b) => b.delta - a.delta)
    .forEach((r) => {
      const row = document.createElement('div');
      row.className = 'sk-round-popup-row';
      row.dataset.playerId = r.id;
      const left = document.createElement('div');
      left.className = 'sk-round-popup-row-left';
      left.innerHTML = `${escapeHTML(r.nickname)} <span class="sk-round-popup-row-detail">— annoncé ${r.bid}, fait ${r.made}</span><span class="sk-round-popup-row-breakdown">${roundBreakdownText(r)}</span>`;
      const delta = document.createElement('span');
      delta.className = `sk-round-popup-row-delta ${r.delta >= 0 ? 'sk-delta--up' : 'sk-delta--down'}`;
      delta.textContent = r.delta >= 0 ? `+${r.delta}` : r.delta;
      row.appendChild(left);
      row.appendChild(delta);
      roundPopupRows.appendChild(row);
    });

  btnNextRound.classList.toggle('hidden', !myIsHost);
  roundPopup.classList.remove('hidden');
  markLootRows(summary.lootLinks);

  const ms = state.roundEndMs || 7000;
  roundPopupBar.style.transition = 'none';
  roundPopupBar.style.transform = 'scaleX(1)';
  requestAnimationFrame(() => {
    roundPopupBar.style.transition = `transform ${ms}ms linear`;
    roundPopupBar.style.transform = 'scaleX(0)';
  });
}

function hideRoundPopup() {
  roundPopup.classList.add('hidden');
}

// --- Fin de partie ---

const endTitle = document.getElementById('sk-end-title');
const endBody = document.getElementById('sk-end-body');

// Récap de fin : le classement seul ne racontait rien de la partie. On y
// ajoute ce que l'historique des manches permet de dire — annonces tenues,
// plis pris — puis quelques faits marquants qui font parler la table.
// La courbe et les faits marquants ont chacun leur propre planche : ils
// répondent à deux questions différentes (« comment ça s'est joué » et
// « qu'est-ce qu'on retiendra »), les empiler dans le même bloc les faisait
// lire comme une seule liste.
const endCurveEl = document.getElementById('sk-end-curve');
const endFactsEl = document.getElementById('sk-end-facts');
// Rang gravé en chiffres romains, comme au registre de bord — une médaille
// en emoji n'a rien à faire sur un tableau d'équipage.

// La couleur d'un joueur, c'est celle de sa pièce — remontée en clarté pour
// tenir sur le bois sombre (voir surFondSombre). Un seul endroit qui la
// calcule : la roue, la courbe, le salon et le récap doivent tous tomber sur
// la même teinte, sinon le repère ne vaut plus rien.
function couleurJoueur(p) {
  return surFondSombre((PIECE_BY_KEY[p && p.piece] || pieceFor(p)).color);
}

// Le pseudo porté à la couleur de sa pièce : c'est le même repère que le
// médaillon sur le tapis, on retrouve le sien sans lire toute la liste.
function nomColore(p) {
  return `<span class="sk-nom" style="color:${couleurJoueur(p)}">${escapeHTML(p.nickname)}</span>`;
}

function medaillon(p) {
  const piece = PIECE_BY_KEY[p && p.piece] || pieceFor(p);
  return `<img class="sk-nom-piece" src="assets/skin/piece-${piece.key}.webp" alt="" aria-hidden="true" />`;
}

// Les faits marquants ne sont plus des phrases toutes faites : chacun est
// un couple « intitulé + joueur + détail ». C'est ce qui permet de les poser
// dans un cadre en trois colonnes lisibles d'un coup d'œil, et de porter le
// pseudo à la couleur de sa pièce plutôt qu'au milieu d'un paragraphe.
function endFacts(ranking) {
  const facts = [];
  const withRounds = ranking.filter((r) => r.rounds);
  if (!withRounds.length) return facts;

  const bestRound = withRounds
    .filter((r) => r.bestRound)
    .reduce((b, r) => (b === null || r.bestRound.delta > b.bestRound.delta ? r : b), null);
  if (bestRound && bestRound.bestRound.delta > 0) {
    facts.push({
      label: 'Meilleure manche',
      joueur: bestRound,
      detail: `+${bestRound.bestRound.delta} points à la manche ${bestRound.bestRound.round}.`,
    });
  }

  const worstRound = withRounds
    .filter((r) => r.worstRound)
    .reduce((b, r) => (b === null || r.worstRound.delta < b.worstRound.delta ? r : b), null);
  if (worstRound && worstRound.worstRound.delta < 0) {
    facts.push({
      label: 'Pire manche',
      joueur: worstRound,
      detail: `${worstRound.worstRound.delta} points à la manche ${worstRound.worstRound.round}.`,
    });
  }

  const streak = withRounds.reduce((b, r) => (r.bestStreak > b.bestStreak ? r : b));
  if (streak.bestStreak >= 2) {
    facts.push({
      label: 'Plus longue série',
      joueur: streak,
      detail: `${streak.bestStreak} annonces tenues d'affilée.`,
    });
  }

  const zeros = withRounds.reduce((b, r) => (r.zeros > b.zeros ? r : b));
  if (zeros.zeros >= 2) {
    facts.push({
      label: 'Sang-froid',
      joueur: zeros,
      detail: `${zeros.zeros} annonces à zéro tenues.`,
    });
  }

  const tricks = withRounds.reduce((b, r) => (r.tricks > b.tricks ? r : b));
  if (tricks.tricks > 0) {
    facts.push({
      label: 'Plus gros ramasseur',
      joueur: tricks,
      detail: `${tricks.tricks} plis sur la partie.`,
    });
  }
  return facts;
}

// Le cadre des faits marquants : une planche à part, avec une ligne par
// fait — intitulé gravé au laiton, médaillon du joueur, son pseudo à sa
// couleur, puis le détail chiffré.
function renderFactsPanel(ranking) {
  const facts = endFacts(ranking);
  if (!facts.length) return '';
  return (
    `<p class="sk-end-panel-title">Faits marquants</p>` +
    `<ul class="sk-fact-list">` +
    facts
      .map(
        (f) =>
          `<li class="sk-fact">` +
          `<span class="sk-fact-label">${escapeHTML(f.label)}</span>` +
          `<span class="sk-fact-who">${medaillon(f.joueur)}${nomColore(f.joueur)}</span>` +
          `<span class="sk-fact-detail">${escapeHTML(f.detail)}</span>` +
          `</li>`
      )
      .join('') +
    `</ul>`
  );
}

// Courbe des scores de la partie : une ligne par joueur, à la couleur de sa
// pièce (même repère que sur le tapis, on retrouve la sienne sans lire de
// légende). Tracée en SVG à la main plutôt qu'avec une bibliothèque : c'est
// une polyligne et deux axes, rien qui justifie une dépendance.
//
// Deux formats sortent du même tracé. La vignette du récap tient dans un
// tiers d'écran : elle ne garde que la ligne du zéro, tout le reste serait
// illisible à cette taille. La planche agrandie (au clic sur la vignette) a
// la place de porter le quadrillage complet et les valeurs des deux axes —
// c'est là qu'on va chercher « il était à combien à la manche 6 ». Une seule
// fonction de géométrie pour les deux : dédoublée, elles auraient divergé au
// premier réglage.

// Un pas de graduation rond plutôt que l'étendue brute découpée en parts
// égales : « -50, 0, 50, 100 » se lit d'un coup d'œil, « -47, 3, 53 » non.
// On vise `cible` intervalles et on arrondit à 1, 2 ou 5 fois une puissance
// de dix.
function pasGraduation(etendue, cible) {
  const brut = etendue / Math.max(1, cible);
  const mag = Math.pow(10, Math.floor(Math.log10(brut || 1)));
  const norm = brut / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

function courbeSVG(series, grand, hauteur) {
  const W = grand ? 940 : 460;
  // Agrandie, la hauteur est celle que la planche laisse (voir
  // dessinerCourbeAgrandie), exprimée dans la même échelle que W. La vignette,
  // elle, garde son format : elle occupe une case du récap, pas un écran.
  const H = grand ? Math.round(hauteur || 470) : 190;
  const PAD_L = grand ? 64 : 38;
  const PAD_T = grand ? 22 : 12;
  const PAD_B = grand ? 50 : 22;

  const maxRound = Math.max(...series.map((r) => r.curve.length));
  const totaux = series.flatMap((r) => r.curve.map((c) => c.total));
  let min = Math.min(0, ...totaux);
  let max = Math.max(0, ...totaux);
  if (max === min) max = min + 10; // partie à 0 partout : évite une division par zéro
  const ticks = [];
  if (grand) {
    // Agrandie, l'échelle se cale sur des bornes rondes : les lignes du
    // quadrillage doivent tomber sur des valeurs qu'on peut écrire en marge.
    // Le pas est calculé sur l'étendue RÉELLE, avant toute marge — la marge
    // ajoutée d'abord fait sauter d'un cran et laisse un tiers de champ vide.
    const pas = pasGraduation(max - min, 7);
    min = Math.floor(min / pas) * pas;
    max = Math.ceil(max / pas) * pas;
    // Les bornes rondes servent déjà de marge, sauf quand un score tombe
    // pile dessus : on ouvre alors d'un pas pour que la ligne ne longe pas
    // le cadre.
    if (Math.max(...totaux) >= max - pas * 1e-6) max += pas;
    if (Math.min(...totaux) <= min + pas * 1e-6) min -= pas;
    for (let v = min; v <= max + pas * 1e-6; v += pas) ticks.push(Math.round(v * 1000) / 1000);
  } else {
    // Marge haute et basse pour que les lignes ne collent pas au cadre.
    const span = max - min;
    min -= span * 0.08;
    max += span * 0.08;
  }

  // Taille du médaillon de bout de ligne : il doit rester lisible, mais à 9
  // joueurs neuf médaillons pleine taille ne tiennent pas dans la hauteur
  // utile du cadre. On les rétrécit donc à mesure que la table se remplit.
  let dBase = grand
    ? (series.length <= 5 ? 40 : series.length <= 7 ? 34 : 29)
    : (series.length <= 5 ? 22 : series.length <= 7 ? 18 : 15);

  // Les ex æquo se rangent CÔTE À CÔTE, pas empilés. Empilés, deux
  // médaillons se lisent comme deux scores voisins — exactement le contraire
  // de ce qu'ils disent. En rangée, l'égalité se voit : même hauteur, même
  // ligne. Le peloton le plus fourni décide donc de la marge droite, puisque
  // c'est là que la rangée s'étale.
  const finDe = (r) => `${r.curve.length}|${r.curve[r.curve.length - 1].total}`;
  const effectifs = new Map();
  series.forEach((r) => effectifs.set(finDe(r), (effectifs.get(finDe(r)) || 0) + 1));
  const peloton = Math.max(1, ...effectifs.values());
  // Un peloton entier tient sur SA rangée, quel qu'il soit — il n'y a pas de
  // trop-plein qui passe en dessous. Une seconde rangée disait le contraire
  // de ce qu'elle voulait dire : deux médaillons l'un sous l'autre se lisent
  // comme deux scores voisins, et à neuf ex æquo le neuvième se retrouvait
  // seul sur sa ligne, en apparence dernier.
  //
  // La rangée ne déborde donc pas, elle se serre. Elle dispose d'un quart du
  // cadre ; au-delà, les médaillons se recouvrent comme des pièces poussées
  // en éventail — on les compte encore, et surtout on les lit sur la même
  // ligne. Et quand le recouvrement en cacherait plus de la moitié, c'est
  // leur taille qui cède plutôt que la rangée.
  const bande = W * 0.25;
  let ecartH = dBase * 0.92;
  if (peloton > 1) {
    ecartH = Math.min(ecartH, bande / (peloton - 1));
    const dTenable = ecartH / 0.5;
    if (dTenable < dBase) dBase = Math.max(grand ? 20 : 11, dTenable);
  }
  const PAD_R = (grand ? 40 : 16) + (peloton - 1) * ecartH;

  const x = (i) => PAD_L + (maxRound === 1 ? 0 : (i / (maxRound - 1)) * (W - PAD_L - PAD_R));
  const y = (v) => PAD_T + (1 - (v - min) / (max - min)) * (H - PAD_T - PAD_B);

  let svg =
    `<svg class="sk-curve${grand ? ' sk-curve--grand' : ''}" viewBox="0 0 ${W} ${H}"` +
    ` role="img" aria-label="Évolution des scores manche par manche">`;

  // Le quadrillage passe sous tout le reste : c'est un fond de plan, pas un
  // tracé. Les lignes verticales tombent sur les manches, les horizontales
  // sur les graduations rondes calculées plus haut.
  if (grand) {
    ticks.forEach((v) => {
      const yy = y(v).toFixed(1);
      svg += `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" class="sk-curve-grid" />`;
      svg += `<text x="${PAD_L - 12}" y="${(y(v) + 4).toFixed(1)}" class="sk-curve-tick">${v}</text>`;
    });
    for (let i = 0; i < maxRound; i++) {
      const xx = x(i).toFixed(1);
      svg += `<line x1="${xx}" y1="${PAD_T}" x2="${xx}" y2="${H - PAD_B}" class="sk-curve-grid" />`;
    }
    // Les deux axes, plus marqués que le quadrillage : ils ferment le champ.
    svg += `<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" class="sk-curve-axis" />`;
    svg += `<line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" class="sk-curve-axis" />`;
  }

  // Ligne du zéro : le repère qui compte, on passe son temps à repasser
  // au-dessus et en dessous. Elle se pose après le quadrillage pour rester
  // lisible quand une graduation tombe au même endroit.
  const zeroY = y(0);
  svg += `<line x1="${PAD_L}" y1="${zeroY}" x2="${W - PAD_R}" y2="${zeroY}" class="sk-curve-zero" />`;
  if (!grand) svg += `<text x="${PAD_L - 6}" y="${zeroY + 3}" class="sk-curve-tick">0</text>`;

  // Repères de manche en bas : toutes les manches quand on a la place,
  // sinon la première, la dernière et tous les trois pas.
  for (let i = 0; i < maxRound; i++) {
    if (!grand && i !== 0 && (i + 1) % 3 !== 0 && i !== maxRound - 1) continue;
    svg += `<text x="${x(i)}" y="${H - (grand ? 26 : 6)}" class="sk-curve-round">${i + 1}</text>`;
  }

  // Le nom des deux axes : sans lui, agrandie, la courbe reste un dessin.
  if (grand) {
    svg += `<text x="${(PAD_L + (W - PAD_R)) / 2}" y="${H - 6}" class="sk-curve-axis-name">Manche</text>`;
    svg += `<text x="18" y="${(PAD_T + (H - PAD_B)) / 2}" class="sk-curve-axis-name"` +
      ` transform="rotate(-90 18 ${((PAD_T + (H - PAD_B)) / 2).toFixed(1)})">Points</text>`;
  }

  // Les médaillons se posent APRÈS toutes les lignes, dans une seconde passe :
  // sinon la ligne d'un joueur tracée ensuite passerait par-dessus le
  // médaillon d'un autre (SVG n'a pas de z-index, seul l'ordre compte).
  const bouts = [];
  series.forEach((r) => {
    const piece = PIECE_BY_KEY[r.piece] || pieceFor(r);
    const couleur = couleurJoueur(r);
    const pts = r.curve.map((c, i) => `${x(i)},${y(c.total)}`).join(' ');
    const moi = r.id === myId ? ' sk-curve-line--me' : '';
    svg += `<polyline points="${pts}" class="sk-curve-line${moi}" style="stroke:${couleur}" />`;
    // Agrandie, chaque manche porte son point : c'est ce qui permet de lire
    // une valeur sur le quadrillage, et de la nommer au survol.
    if (grand) {
      svg += r.curve
        .map(
          (c, i) =>
            `<circle cx="${x(i).toFixed(1)}" cy="${y(c.total).toFixed(1)}" r="${r.id === myId ? 4.4 : 3.4}"` +
            ` class="sk-curve-dot" style="fill:${couleur}">` +
            `<title>${escapeHTML(r.nickname)} — manche ${i + 1} : ${c.total}</title></circle>`
        )
        .join('');
    }
    const dernier = r.curve[r.curve.length - 1];
    // Le bout de ligne porte la pièce du joueur plutôt qu'un point de
    // couleur : la couleur seule ne suffisait pas à trois rouges voisins, et
    // c'est le même repère que sur le tapis et dans le registre.
    const d = r.id === myId ? dBase + 4 : dBase;
    bouts.push({
      cle: piece.key, d, moi: !!moi, fin: finDe(r),
      cx: x(r.curve.length - 1),
      cy: y(dernier.total),
      titre: `${escapeHTML(r.nickname)} — ${dernier.total}`,
    });
  });

  // Une rangée par score d'arrivée, et une seule : les ex æquo la partagent
  // tous, côte à côte. Le premier reste sur son point, les suivants
  // s'alignent à sa droite — la ligne qui mène au premier ancre toute la
  // rangée à sa hauteur.
  const rangees = [];
  const parFin = new Map();
  bouts.forEach((b) => {
    let rangee = parFin.get(b.fin);
    if (!rangee) {
      rangee = { cy: b.cy, membres: [] };
      rangees.push(rangee);
      parFin.set(b.fin, rangee);
    }
    rangee.membres.push(b);
  });
  rangees.forEach((rangee) => {
    rangee.d = Math.max(...rangee.membres.map((b) => b.d));
    rangee.membres.forEach((b, i) => { b.cx += i * ecartH; });
  });

  // Deux scores voisins verraient leurs rangées se chevaucher, donc
  // illisibles toutes les deux. On les écarte verticalement du strict
  // nécessaire, du haut vers le bas : la rangée quitte un peu son point,
  // mais la ligne qui y mène reste sous elle et la rattache.
  rangees.sort((a, b) => a.cy - b.cy);
  // La plus haute ne doit pas déborder par le haut du cadre avant même qu'on
  // écarte les autres — sinon un peloton en tête sort du SVG.
  if (rangees.length) rangees[0].cy = Math.max(rangees[0].cy, PAD_T - 4 + rangees[0].d / 2);
  for (let i = 1; i < rangees.length; i++) {
    const mini = (rangees[i - 1].d + rangees[i].d) / 2 * 0.82;
    if (rangees[i].cy - rangees[i - 1].cy < mini) rangees[i].cy = rangees[i - 1].cy + mini;
  }
  // Le tas peut alors dépasser par le bas : on le remonte en bloc, ce qui
  // conserve les écarts qu'on vient d'établir.
  const derniere = rangees[rangees.length - 1];
  const debord = rangees.length ? derniere.cy + derniere.d / 2 - (H - PAD_B + 4) : 0;
  if (debord > 0) rangees.forEach((r) => { r.cy -= debord; });
  rangees.forEach((rangee) => rangee.membres.forEach((b) => { b.cy = rangee.cy; }));

  svg += bouts
    .map((b) =>
      `<image href="assets/skin/piece-${b.cle}.webp" x="${(b.cx - b.d / 2).toFixed(1)}" y="${(b.cy - b.d / 2).toFixed(1)}"` +
      ` width="${b.d}" height="${b.d}" class="sk-curve-piece${b.moi ? ' sk-curve-piece--me' : ''}">` +
      `<title>${b.titre}</title></image>`
    )
    .join('');
  svg += '</svg>';
  return svg;
}

function courbeLegende(series) {
  return series
    .map((r) => {
      const couleur = couleurJoueur(r);
      return `<span class="sk-curve-key" style="color:${couleur}"><i style="background:${couleur}"></i>${escapeHTML(r.nickname)}</span>`;
    })
    .join('');
}

function seriesCourbe(ranking) {
  return ranking.filter((r) => r.curve && r.curve.length);
}

// La vignette du récap. Elle est cliquable : c'est un vrai bouton, pas une
// image avec un écouteur — on veut le focus au clavier et l'annonce au
// lecteur d'écran sans les réécrire à la main.
function renderScoreCurve(ranking) {
  const series = seriesCourbe(ranking);
  if (series.length < 1) return '';
  return (
    `<p class="sk-end-panel-title">Évolution des scores</p>` +
    `<div class="sk-curve-wrap">` +
    `<button type="button" id="sk-curve-zoom" class="sk-curve-zoom"` +
    ` aria-label="Agrandir l'évolution des scores">` +
    courbeSVG(series, false) +
    `<span class="sk-curve-loupe" aria-hidden="true">Agrandir</span>` +
    `</button>` +
    `<div class="sk-curve-legend">${courbeLegende(series)}</div>` +
    `</div>`
  );
}

function renderGameEnd(state) {
  const ranking = state.finalRanking;
  const winner = ranking[0];
  // Le vainqueur est nommé à la couleur de sa pièce jusque dans le titre :
  // c'est la première ligne qu'on lit, autant qu'elle porte déjà le repère.
  // Et sa pièce est posée au-dessus du nom, en grand : c'est son médaillon
  // qu'on a suivi toute la partie — sur la roue, au tapis, au bout de sa
  // courbe. Le verdict le rend une dernière fois, à la taille d'un trophée.
  const piece = PIECE_BY_KEY[winner.piece] || pieceFor(winner);
  const trophee =
    `<img class="sk-end-winner-piece" src="assets/skin/piece-${piece.key}.webp" alt="" aria-hidden="true" />`;
  // Le vainqueur est nommé, même quand c'est soi : « Tu remportes la partie »
  // se lit vite, mais c'est la seule ligne de l'écran qui grave un nom, et
  // c'est celle-là qu'on garde en capture. Le pseudo y a sa place.
  endTitle.innerHTML =
    `<span class="sk-end-winner">${trophee}${nomColore(winner)}</span> remporte la partie !`;
  endBody.innerHTML = ranking
    .map((r, i) => {
      const rang = ROMAN[i + 1] || `${i + 1}`;
      // Les parties d'avant ce récap n'ont pas ces champs : on retombe alors
      // sur un tiret plutôt que d'afficher « undefined ».
      const annonces = r.rounds ? `${r.exact} sur ${r.rounds}` : '—';
      const plis = r.tricks == null ? '—' : r.tricks;
      const moi = r.id === myId ? ' class="sk-end-row--me"' : '';
      const nom = `<span class="sk-end-name">${medaillon(r)}${nomColore(r)}</span>`;
      return `<tr${moi}><td>${rang}</td><td class="sk-end-name-cell">${nom}</td><td>${annonces}</td><td>${plis}</td><td><b>${r.total}</b></td></tr>`;
    })
    .join('');

  const courbe = renderScoreCurve(ranking);
  endCurveEl.innerHTML = courbe;
  endCurveEl.classList.toggle('hidden', !courbe);
  // La vignette est refaite à chaque fin de partie : son écouteur aussi.
  // Le classement est retenu de côté, la planche agrandie le retrace à
  // l'ouverture plutôt que de garder un second SVG en mémoire.
  dernierClassement = ranking;
  const zoom = document.getElementById('sk-curve-zoom');
  if (zoom) zoom.addEventListener('click', ouvrirCourbeAgrandie);
  const faits = renderFactsPanel(ranking);
  endFactsEl.innerHTML = faits;
  endFactsEl.classList.toggle('hidden', !faits);
}

// --- La courbe agrandie -----------------------------------------------
// La vignette du récap répond à « qui a décroché quand » ; agrandie, elle
// répond à « il était à combien à la manche 6 ». D'où le quadrillage et les
// valeurs des deux axes, qui n'auraient aucun sens à la taille du panneau.
let dernierClassement = null;
const curveModal = document.getElementById('sk-curve-modal');
const curveModalBody = document.getElementById('sk-curve-modal-body');
const curveModalLegend = document.getElementById('sk-curve-modal-legend');

// Le tracé agrandi n'a PAS de rapport hauteur/largeur imposé : il prend
// toute la largeur de la planche, et la hauteur qui reste une fois la
// légende et le bouton posés. À rapport fixe, une fenêtre basse le réduisait
// des deux côtés à la fois — on se retrouvait à regarder, au milieu d'une
// planche aux deux tiers vide, une courbe plus petite que la vignette sur
// laquelle on venait de cliquer pour l'agrandir.
//
// La hauteur est calculée dans l'échelle du viewBox, à partir de la largeur
// réelle de la case : le SVG remplit alors exactement la place, sans
// étirement — les libellés et les médaillons gardent leur taille.
function dessinerCourbeAgrandie(series) {
  const largeur = Math.max(curveModalBody.clientWidth, 520);
  const dispo = curveModalBody.clientHeight;
  const H = Math.min(560, Math.max(280, (dispo * 940) / largeur));
  curveModalBody.innerHTML = courbeSVG(series, true, H);
  if (curveModalLegend) curveModalLegend.innerHTML = courbeLegende(series);
}

function ouvrirCourbeAgrandie() {
  if (!curveModal || !dernierClassement) return;
  const series = seriesCourbe(dernierClassement);
  if (!series.length) return;
  // Montrée d'abord, mesurée ensuite : une planche encore cachée n'a pas de
  // dimensions, et le tracé se serait calé sur du vide.
  curveModal.classList.remove('hidden');
  dessinerCourbeAgrandie(series);
}

// Tourner un téléphone ou redimensionner une fenêtre change la place
// disponible : le tracé se refait, sinon il garde la hauteur d'avant.
window.addEventListener('resize', () => {
  if (!curveModal || curveModal.classList.contains('hidden') || !dernierClassement) return;
  const series = seriesCourbe(dernierClassement);
  if (series.length) dessinerCourbeAgrandie(series);
});

function fermerCourbeAgrandie() {
  if (curveModal) curveModal.classList.add('hidden');
}

if (curveModal) {
  document.getElementById('sk-btn-close-curve').addEventListener('click', fermerCourbeAgrandie);
  document.getElementById('sk-btn-close-curve-x').addEventListener('click', fermerCourbeAgrandie);
  // Le fond fait office de bouton « fermer » : c'est un agrandissement, on
  // en sort comme on sort d'une loupe. Seul un clic SUR le fond compte, pas
  // un clic sur la planche qu'il porte.
  curveModal.addEventListener('click', (e) => {
    if (e.target === curveModal) fermerCourbeAgrandie();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !curveModal.classList.contains('hidden')) fermerCourbeAgrandie();
  });
}

document.getElementById('sk-btn-rematch').addEventListener('click', () => socket.emit('skullking-rematch'));

// --- Roue de tirage au sort : qui mène le tout premier pli ---
// Même principe que le Rami (les secteurs sont fixes, seule la flèche
// tourne), généralisé à N joueurs : un secteur par joueur, et son étiquette
// posée en vis-à-vis sur le pourtour - la pièce du joueur au-dessus de son
// nom, comme à son siège. Ne joue qu'une fois par partie, sur la toute
// première annonce de la manche 1 (voir applyState) - startRevealPlayed est
// réarmé à chaque retour au salon (nouvelle partie ou revanche).
// Chaque secteur est peint à la couleur de la pièce de SON joueur — l'émail
// du médaillon qu'il a choisi, pas une teinte de rang. On lit donc la roue
// sans rien déchiffrer : on cherche sa propre couleur. Plus de palette fixe
// indexée sur la position, qui repeignait un joueur d'une partie à l'autre.
// Le serveur attribue une pièce libre à qui n'en a pas choisi (voir
// skullking-room.js), deux secteurs ne peuvent donc pas se confondre.

// Durée du tirage, en un seul endroit. Elle était auparavant écrite deux
// fois — dans la transition CSS et dans les minuteries d'ici — ce qui est
// exactement le genre de paire qui se désynchronise au premier réglage.
// C'est le JS qui pose la transition, les timings en découlent.
const ROUE_DUREE = 5400;      // ms de rotation
const ROUE_TOURS = 7;         // tours complets avant de viser le secteur
const ROUE_LECTURE = 2600;    // ms pendant lesquelles le nom reste affiché

function playStartReveal(players, starterId) {
  const overlay = document.getElementById('sk-start-reveal');
  const wheel = document.getElementById('sk-wheel');
  const needle = document.getElementById('sk-wheel-needle');
  const labelsEl = document.getElementById('sk-wheel-labels');
  const text = document.getElementById('sk-start-reveal-text');
  if (!overlay || !players.length) return;

  const n = players.length;
  const step = 360 / n;
  const winnerIndex = Math.max(0, players.findIndex((p) => p.id === starterId));
  const starter = players[winnerIndex];

  // Les secteurs ne sont plus des aplats de couleur mais le TAPIS de chaque
  // joueur : le feutre de sa pièce, frappé de sa figure (voir
  // briefs/decouper-feutres.py). Un conic-gradient ne sait porter que des
  // couleurs, d'où ce SVG : un chemin de camembert par joueur, qui découpe
  // l'image de son feutre. Le découpage suit le nombre de joueurs, c'est le
  // même pas d'angle que les étiquettes et que l'arrêt de la flèche.
  const R = 50;
  const point = (deg) => {
    const a = (deg * Math.PI) / 180;
    // 0° en haut, sens horaire — la convention du conic-gradient qu'on
    // remplace, et celle de la rotation de la flèche plus bas.
    return `${(50 + R * Math.sin(a)).toFixed(3)},${(50 - R * Math.cos(a)).toFixed(3)}`;
  };
  const secteurs = players.map((p, i) => ({
    cle: pieceFor(p).key,
    depart: point(i * step),
    // Un camembert se trace en un arc ; au-delà d'un demi-tour il faut le
    // dire à SVG (large-arc), sinon il prend le petit côté.
    d: n === 1
      ? `M50,0A${R},${R} 0 1 1 50,100A${R},${R} 0 1 1 50,0Z`
      : `M50,50L${point(i * step)}A${R},${R} 0 ${step > 180 ? 1 : 0} 1 ${point((i + 1) * step)}Z`,
  }));
  wheel.style.background = 'none';
  wheel.innerHTML =
    '<svg class="sk-wheel-svg" viewBox="0 0 100 100" aria-hidden="true">' +
    '<defs>' +
    secteurs.map((s, i) => `<clipPath id="sk-roue-s${i}"><path d="${s.d}"/></clipPath>`).join('') +
    '</defs>' +
    secteurs
      .map((s, i) =>
        `<image href="assets/skin/feutre-${s.cle}.webp" x="0" y="0" width="100" height="100"` +
        ` preserveAspectRatio="xMidYMid slice" clip-path="url(#sk-roue-s${i})"/>`)
      .join('') +
    // Une couture sombre sur chaque rayon : deux feutres voisins peuvent être
    // proches de teinte, et sans elle on ne voit plus où l'un finit.
    (n > 1
      ? secteurs.map((s) => `<path class="sk-wheel-seam" d="M50,50L${s.depart}"/>`).join('')
      : '') +
    '</svg>';

  // Étiquettes à l'angle du centre de leur secteur (0° = en haut, sens
  // horaire) - même convention que la rotation de la flèche ci-dessous, pour
  // que l'aiguille s'arrête pile devant le bon nom. On ne pose QUE l'angle :
  // le placement polaire est fait en CSS, autour du même centre que la barre
  // (--sk-roue-cx/cy) - c'était justement le décalage entre ce centre-ci et
  // celui-là qui posait les noms de travers.
  //
  // Le rayon s'écarte quand la table se remplit : posées sur le bois, huit
  // ou neuf étiquettes se chevaucheraient (il faut ~112 px entre deux voisines
  // pour qu'elles ne se touchent pas). Elles sortent alors de la roue.
  labelsEl.innerHTML = '';
  const rayonTags = Math.max(124, Math.round(56 / Math.sin(Math.PI / n)));
  labelsEl.style.setProperty('--sk-roue-etiquettes', `${rayonTags}px`);
  players.forEach((p, i) => {
    const tag = document.createElement('span');
    tag.className = 'sk-wheel-tag';
    tag.style.setProperty('--sk-tag-angle', `${((i + 0.5) * step).toFixed(2)}deg`);
    // La pièce au-dessus du nom : on retrouve son secteur à la figure autant
    // qu'à la couleur, et c'est le même médaillon qu'au siège du joueur.
    const piece = pieceFor(p);
    const medaillon = document.createElement('span');
    medaillon.className = 'sk-wheel-tag-piece';
    medaillon.innerHTML = pieceSVG(piece);
    medaillon.title = piece.label;
    const nom = document.createElement('span');
    nom.className = 'sk-wheel-tag-name';
    nom.textContent = p.nickname;
    tag.append(medaillon, nom);
    labelsEl.appendChild(tag);
  });

  text.textContent = '';
  text.classList.remove('sk-visible');
  overlay.classList.remove('hidden');

  const target = ROUE_TOURS * 360 + (winnerIndex + 0.5) * step;

  // Une seule source pour la durée : le CSS la lit ici.
  document.documentElement.style.setProperty('--sk-roue-duree', `${ROUE_DUREE}ms`);

  needle.style.transition = 'none';
  needle.style.transform = 'rotate(0deg)';

  // Double rAF : garantit que l'angle de repos (0°) est bien peint avant que
  // l'angle cible ne soit posé, sinon le navigateur saute droit à l'état
  // final (bug déjà rencontré sur la roue du Rami).
  //
  // La transition elle-même est déclarée en CSS, pas ici : la poser en JS
  // dans la même image que le changement d'angle n'anime rien du tout. Seule
  // sa DURÉE vient d'ici, par une variable — de sorte qu'elle reste
  // d'accord avec les minuteries ci-dessous, qui en dépendent.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      needle.style.transition = '';
      needle.style.transform = `rotate(${target}deg)`;
    });
  });

  // Le nom se pose quand la barre se pose : 150 ms avant la fin, le temps
  // que l'oeil ait déjà vu où elle s'arrête.
  setTimeout(() => {
    const tags = labelsEl.querySelectorAll('.sk-wheel-tag');
    if (tags[winnerIndex]) tags[winnerIndex].classList.add('sk-wheel-tag--winner');
    text.textContent = `${starter ? starter.nickname : '???'} ouvre la manche`;
    text.classList.add('sk-visible');
  }, ROUE_DUREE - 150);
  setTimeout(() => overlay.classList.add('hidden'), ROUE_DUREE + ROUE_LECTURE);
}

// --- Dispatch d'état ---

// Le dernier état reçu, gardé de côté : quand on sort du ciblage de la
// Planche sans rien jouer, rien n'arrive du serveur et il faut pourtant
// réécrire la consigne du tour.
let dernierEtatJeu = null;

function applyState(state) {
  dernierEtatJeu = state;
  const previousPhase = lastPhase;
  lastPhase = state.phase;
  myId = state.myId;
  myIsHost = state.isHost;
  // Le paquet arrive avec chaque état : une reconnexion en pleine manche ne
  // repasse pas par le salon et n'aurait sinon jamais appris lequel est en
  // jeu.
  setDeckStyle(state.deckStyle);
  showReconnectingOverlay(false);
  joinModal.classList.add('hidden');
  hideAllChoicePanels();
  pendingTigressCardId = null;
  pendingJokerCardId = null;
  pendingDeclareCardId = null;

  if (state.phase === 'bidding' || state.phase === 'playing' || state.phase === 'power') {
    hideRoundPopup();
    showScreen('game');
    renderGame(state);
    if (state.roundNumber === 1 && !startRevealPlayed) {
      startRevealPlayed = true;
      playStartReveal(state.players, state.leaderPlayerId);
    }
    // La toute première annonce venant de tomber (transition bidding → tout
    // le reste) : c'est le seul instant où toutes les annonces sont neuves
    // pour tout le monde en même temps.
    if (state.phase !== 'bidding' && previousPhase === 'bidding') {
      showBidReveal(state);
    }
    return;
  }
  if (state.phase === 'round-end') {
    showScreen('game');
    // À partir d'ici le tapis n'est plus rendu (seule la popup de fin de
    // manche compte) : il faut donc effacer à la main ce qui reste du dernier
    // pli. Sans ça, « X remporte le pli ! » restait affiché derrière la popup
    // puis jusqu'au premier rendu de la manche suivante.
    clearTrickTable();
    showRoundPopup(state);
    return;
  }
  if (state.phase === 'game-end') {
    hideRoundPopup();
    showScreen('end');
    renderGameEnd(state);
  }
}

socket.on('skullking-state', applyState);
socket.on('skullking-rejoin-ok', applyState);

socket.on('skullking-player-disconnected', ({ nickname }) => {
  showToast(`${nickname} a une connexion instable…`);
});

socket.on('skullking-player-reconnected', ({ nickname }) => {
  showToast(`${nickname} est de retour !`);
});

socket.on('skullking-rejoin-failed', (payload) => {
  clearActiveRoom();
  showReconnectingOverlay(false);
  // Distingue "ce salon n'a jamais existe" (code invalide) de "le serveur a
  // redemarre et a perdu son etat" (hebergement gratuit qui se met en veille) -
  // sinon un joueur revenant apres une pause pense avoir tape le mauvais code.
  if (payload && payload.reason === 'server-restarted') {
    showToast("😴 Le serveur a redémarré entre-temps — cette partie a été perdue, il faut en relancer une.");
  }
  const fallback = rejoinFallback;
  rejoinFallback = null;
  if (fallback && fallback !== 'link') {
    myNickname = fallback.nickname;
    socket.emit('skullking-join-room', { code: fallback.code, nickname: fallback.nickname, token: getPlayerToken() });
    return;
  }
  if (fallback === 'link') {
    joinModalError.textContent = '';
    btnJoinModal.disabled = false;
    joinModal.classList.remove('hidden');
    joinModalNickname.focus();
  }
});

socket.on('disconnect', () => {
  showReconnectingOverlay(true);
});

socket.on('connect', () => {
  attemptAutoRejoin(roomFromUrl ? 'link' : null);
});

// --- Choix accueil / rejoindre via lien ---

const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('room');

function attemptAutoRejoin(fallback) {
  const saved = loadActiveRoom();
  const code = (roomFromUrl && roomFromUrl.toUpperCase()) || (saved && saved.code);
  if (!code || !saved || saved.code !== code) return false;
  rejoinFallback = fallback || null;
  showReconnectingOverlay(true);
  socket.emit('skullking-rejoin-room', { code, token: getPlayerToken() });
  return true;
}

if (roomFromUrl) {
  showScreen(null);
  joinModalError.textContent = '';
  btnJoinModal.disabled = false;
  joinModal.classList.remove('hidden');
  joinModalNickname.focus();
} else {
  showScreen('home');
}


// --- Défilement des pages de la colonne ---------------------------------
// Le registre et la discussion vivent dans une page peinte : ils ne peuvent
// pas s'allonger, seulement défiler à l'intérieur. Les flèches ne
// s'affichent que s'il y a vraiment quelque chose au-delà — un bouton
// toujours visible mentirait la moitié du temps.
function brancherDefilement(zone, boite) {
  if (!zone || !boite) return;
  const haut = boite.querySelector('.sk-defiler--haut');
  const bas = boite.querySelector('.sk-defiler--bas');
  if (!haut || !bas) return;

  const PAS = 0.75; // trois quarts de page : on garde une ligne de repère

  function rafraichir() {
    const reste = zone.scrollHeight - zone.clientHeight;
    haut.classList.toggle('is-visible', zone.scrollTop > 2);
    bas.classList.toggle('is-visible', reste > 2 && zone.scrollTop < reste - 2);
  }

  haut.addEventListener('click', () => zone.scrollBy({ top: -zone.clientHeight * PAS, behavior: 'smooth' }));
  bas.addEventListener('click', () => zone.scrollBy({ top: zone.clientHeight * PAS, behavior: 'smooth' }));
  zone.addEventListener('scroll', rafraichir);
  // Le contenu change à chaque pli : on réévalue à chaque mutation plutôt
  // que d'appeler rafraichir() depuis les dix endroits qui l'alimentent.
  new MutationObserver(rafraichir).observe(zone, { childList: true, subtree: true, characterData: true });
  window.addEventListener('resize', rafraichir);
  rafraichir();
}

brancherDefilement(scoreboardRows, document.querySelector('.sk-carnet'));
brancherDefilement(document.getElementById('sk-chat-log'), document.querySelector('.sk-chat-livre'));
