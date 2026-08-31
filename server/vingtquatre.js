// Logique pure du 24 : le paquet, le tirage d'une donne résoluble, le solveur
// (qui sert à la fois à garantir qu'une donne a bien une solution, à mesurer
// sa difficulté et à l'afficher quand personne ne trouve), et la validation
// d'une suite d'opérations envoyée par un joueur. Aucune dépendance à
// Socket.io : testable seule via vingtquatre-simulate.js.
//
// Le paquet n'est PAS celui de server/game.js : là-bas l'as vaut 14 (il bat le
// roi à la Bataille), ici il vaut 1 — c'est le jeu du 24 classique, quatre
// cartes de 1 à 13.

// --- Fractions exactes ----------------------------------------------------
// Le flottant ne suffit pas : 8 / (3 - 8 / 3) fait exactement 24, mais en
// virgule flottante il fait 23.999999999999996. Comparer à 24 avec une marge
// d'erreur marcherait ici, mais accepterait aussi des solutions fausses de
// très peu ailleurs. Une fraction réduite tranche sans ambiguïté.

function pgcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function frac(n, d = 1) {
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = pgcd(n, d);
  return { n: n / g, d: d / g };
}

const fAdd = (x, y) => frac(x.n * y.d + y.n * x.d, x.d * y.d);
const fSub = (x, y) => frac(x.n * y.d - y.n * x.d, x.d * y.d);
const fMul = (x, y) => frac(x.n * y.n, x.d * y.d);
const fDiv = (x, y) => (y.n === 0 ? null : frac(x.n * y.d, x.d * y.n));
const estEntier = (x) => x.d === 1;
const vaut = (x, entier) => x.d === 1 && x.n === entier;

// Affichage d'une fraction : « 8 » ou « 8/3 ». Les fractions apparaissent
// vraiment à l'écran — diviser 8 par 3 est un coup légitime et souvent la
// bonne piste (8 / (3 - 8/3) = 24) — donc le client sait les afficher.
function texteFraction(x) {
  return estEntier(x) ? String(x.n) : `${x.n}/${x.d}`;
}

const CIBLE = 24;

// --- Le paquet ------------------------------------------------------------

const COULEURS = ['coeur', 'carreau', 'trefle', 'pique'];
const RANGS = [
  { label: 'A', value: 1 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
  { label: '9', value: 9 },
  { label: '10', value: 10 },
  { label: 'V', value: 11 },
  { label: 'D', value: 12 },
  { label: 'R', value: 13 },
];

function creerPaquet() {
  const paquet = [];
  for (const suit of COULEURS) {
    for (const rang of RANGS) paquet.push({ suit, label: rang.label, value: rang.value });
  }
  return paquet;
}

function melanger(paquet) {
  const cartes = [...paquet];
  for (let i = cartes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cartes[i], cartes[j]] = [cartes[j], cartes[i]];
  }
  return cartes;
}

// --- Le solveur -----------------------------------------------------------

// Priorités d'affichage, pour ne poser des parenthèses que là où elles
// changent le sens : « 8-4*3 » se lit sans ambiguïté, « (8-4)*3 » en a besoin.
const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 };
const PREC_FEUILLE = 3;

// Les six résultats possibles d'une paire : la soustraction et la division ne
// sont pas commutatives, elles comptent donc chacune dans les deux sens.
function combinaisons(a, b) {
  return [
    { op: '+', valeur: fAdd(a.valeur, b.valeur), g: a, d: b },
    { op: '-', valeur: fSub(a.valeur, b.valeur), g: a, d: b },
    { op: '-', valeur: fSub(b.valeur, a.valeur), g: b, d: a },
    { op: '*', valeur: fMul(a.valeur, b.valeur), g: a, d: b },
    { op: '/', valeur: fDiv(a.valeur, b.valeur), g: a, d: b },
    { op: '/', valeur: fDiv(b.valeur, a.valeur), g: b, d: a },
  ].filter((c) => c.valeur !== null);
}

function noeud({ op, valeur, g, d }) {
  const prec = PREC[op];
  const gauche = g.prec < prec ? `(${g.texte})` : g.texte;
  // À priorité égale, la droite garde ses parenthèses pour « - » et « / » :
  // 8-(3-1) n'est pas 8-3-1, et 8/(4/2) n'est pas 8/4/2.
  const droite = d.prec < prec || (d.prec === prec && (op === '-' || op === '/')) ? `(${d.texte})` : d.texte;
  return {
    valeur,
    prec,
    texte: `${gauche} ${op} ${droite}`,
    // Forme canonique : sert uniquement à compter les solutions VRAIMENT
    // différentes. Sans elle, « 3*8 » et « 8*3 » gonfleraient le compteur et
    // fausseraient la difficulté annoncée.
    canon: op === '+' || op === '*' ? `${op}(${[g.canon, d.canon].sort().join(',')})` : `${op}(${g.canon},${d.canon})`,
  };
}

function feuille(valeur) {
  return { valeur: frac(valeur), prec: PREC_FEUILLE, texte: String(valeur), canon: String(valeur) };
}

// Toutes les solutions distinctes d'une donne, indexées par forme canonique.
// Quatre nombres, c'est quelques milliers de combinaisons : assez rapide pour
// tourner à chaque tirage sans qu'on le sente (voir vingtquatre-simulate.js,
// qui mesure ce coût).
function solutionsDe(valeurs) {
  const trouvees = new Map();

  function explorer(noeuds) {
    if (noeuds.length === 1) {
      if (vaut(noeuds[0].valeur, CIBLE) && !trouvees.has(noeuds[0].canon)) {
        trouvees.set(noeuds[0].canon, noeuds[0].texte);
      }
      return;
    }
    for (let i = 0; i < noeuds.length; i++) {
      for (let j = i + 1; j < noeuds.length; j++) {
        const reste = noeuds.filter((_, k) => k !== i && k !== j);
        for (const c of combinaisons(noeuds[i], noeuds[j])) {
          explorer([...reste, noeud(c)]);
        }
      }
    }
  }

  explorer(valeurs.map(feuille));
  return trouvees;
}

// La difficulté annoncée sur la donne. Le nombre de solutions distinctes est
// un proxy honnête : une donne qui tombe de dix façons se trouve d'un coup
// d'œil, une qui n'en a qu'une se cherche.
function difficulteDe(nbSolutions) {
  if (nbSolutions >= 10) return 'facile';
  if (nbSolutions >= 3) return 'moyen';
  return 'difficile';
}

// Tire quatre cartes qui ont au moins une solution. Environ une donne
// aléatoire sur quatre n'en a aucune : on retire simplement, c'est bien moins
// coûteux que de pré-calculer la table des 1820 combinaisons possibles.
// `dejaVues` (facultatif) évite de reproposer la même donne dans une partie —
// les couleurs changent mais les quatre valeurs, elles, se reconnaissent.
function tirerDonne(dejaVues) {
  const MAX_ESSAIS = 300;
  for (let essai = 0; essai < MAX_ESSAIS; essai++) {
    const cartes = melanger(creerPaquet()).slice(0, 4);
    const valeurs = cartes.map((c) => c.value);
    const cle = [...valeurs].sort((a, b) => a - b).join('-');
    if (dejaVues && dejaVues.has(cle)) continue;
    const solutions = solutionsDe(valeurs);
    if (solutions.size === 0) continue;
    if (dejaVues) dejaVues.add(cle);
    return construireDonne(cartes, solutions, cle);
  }
  // Filet de sécurité : on n'arrive ici que si `dejaVues` a fini par écarter
  // tout ce qui sortait (partie fleuve). On repart alors sur une donne
  // triviale plutôt que de bloquer la manche — et on oublie l'historique,
  // puisque c'est lui qui coince.
  if (dejaVues) dejaVues.clear();
  const secours = [6, 4, 1, 1].map((value, i) => ({
    suit: COULEURS[i],
    label: RANGS.find((r) => r.value === value).label,
    value,
  }));
  return construireDonne(secours, solutionsDe([6, 4, 1, 1]), '1-1-4-6');
}

function construireDonne(cartes, solutions, cle) {
  const textes = [...solutions.values()];
  return {
    // Les identifiants sont fixes : c'est sur eux que le client construit ses
    // fusions et que le serveur les rejoue (voir rejouerEtapes).
    cartes: cartes.map((c, i) => ({ id: `c${i}`, ...c })),
    cle,
    nbSolutions: solutions.size,
    difficulte: difficulteDe(solutions.size),
    // La plus courte à lire : celle qu'on montre quand personne n'a trouvé.
    solution: textes.reduce((a, b) => (b.length < a.length ? b : a)),
  };
}

// --- Validation d'une réponse de joueur -----------------------------------

// Le client fusionne ses cartes tout seul (c'est ce qui rend la manipulation
// instantanée au doigt), puis envoie la suite des trois opérations. Le serveur
// la rejoue intégralement : c'est lui, et lui seul, qui décide qu'une donne
// est résolue.
//
// Convention d'identifiants, partagée avec le client : les quatre cartes sont
// `c0..c3`, et la k-ième fusion produit `r0`, `r1`, `r2`. Le client ne choisit
// donc pas ses identifiants de résultat, il suit le même compteur.
const OPERATIONS = { '+': fAdd, '-': fSub, '*': fMul, '/': fDiv };

function rejouerEtapes(cartes, etapes) {
  if (!Array.isArray(etapes) || etapes.length !== 3) {
    return { ok: false, erreur: 'Il faut exactement trois opérations pour combiner quatre cartes.' };
  }

  const restants = new Map(cartes.map((c) => [c.id, { valeur: frac(c.value), prec: PREC_FEUILLE, texte: String(c.value) }]));

  for (let k = 0; k < etapes.length; k++) {
    const etape = etapes[k] || {};
    const a = restants.get(etape.a);
    const b = restants.get(etape.b);
    const calcul = OPERATIONS[etape.op];
    if (!a || !b || etape.a === etape.b) return { ok: false, erreur: 'Opération impossible : carte déjà utilisée ou inconnue.' };
    if (!calcul) return { ok: false, erreur: 'Opération inconnue.' };

    const valeur = calcul(a.valeur, b.valeur);
    if (valeur === null) return { ok: false, erreur: 'Division par zéro.' };

    restants.delete(etape.a);
    restants.delete(etape.b);
    restants.set(`r${k}`, noeud({ op: etape.op, valeur, g: a, d: b }));
  }

  const [final] = [...restants.values()];
  if (!vaut(final.valeur, CIBLE)) {
    return { ok: false, erreur: `Ça fait ${texteFraction(final.valeur)}, pas 24.`, valeur: final.valeur };
  }
  return { ok: true, formule: final.texte, valeur: final.valeur };
}

module.exports = {
  CIBLE,
  creerPaquet,
  melanger,
  frac,
  texteFraction,
  solutionsDe,
  difficulteDe,
  tirerDonne,
  rejouerEtapes,
};
