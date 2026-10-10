// Simulateur de fin de manche pour le Loup de mer (voir
// briefs/bots-skullking.md, § 4.4). Il rejoue la suite d'une manche sur le
// moteur pur, à partir d'une donne IMAGINÉE : c'est une estimation pour
// choisir un coup, jamais un arbitrage — la vraie salle reste seule juge.
//
// Simplifications assumées : les pouvoirs des Pirates sont ignorés, le Butin
// ne forme pas d'alliance, la Planche ne retire personne, la Dernière Salve
// ne donne pas de carte de rab.

const {
  resolveTrick,
  trickBonusForWinner,
  computeRoundScore,
  isCardPlayable,
  ledSuitOf,
} = require('../skullking');
const { rang } = require('./commun');

// --- Donnes imaginées ---------------------------------------------------------

function melanger(liste) {
  const a = [...liste];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Distribue les cartes inconnues entre les adversaires, chacun recevant
// autant de cartes qu'il en tient, sans lui donner de couleur qu'il a
// montré ne plus avoir. `joueurs` : [{ id, n, coupes: Set }]. Les plus
// contraints sont servis d'abord ; si une contrainte ne peut pas être tenue
// (une coupe mal déduite, Mary Thorne passée par là), on la lâche.
function tirerDonne(inconnues, joueurs) {
  const paquet = melanger(inconnues);
  const mains = new Map();
  const ordre = [...joueurs].sort((a, b) => b.coupes.size - a.coupes.size);
  for (const j of ordre) {
    const main = [];
    for (let i = 0; i < paquet.length && main.length < j.n; ) {
      const c = paquet[i];
      if (c.kind === 'number' && j.coupes.has(c.suit)) {
        i += 1;
        continue;
      }
      main.push(c);
      paquet.splice(i, 1);
    }
    while (main.length < j.n && paquet.length) main.push(paquet.shift());
    mains.set(j.id, main);
  }
  return mains;
}

// --- Politique de déroulement --------------------------------------------------

// Comment chacun joue pendant la simulation : la règle du Matelot, réduite
// à ce qui se calcule vite. On veut des plis : la plus petite carte qui prend
// le pli à l'instant (sinon la plus petite tout court). On n'en veut plus : la
// plus grosse carte qui le perd (sinon la plus petite).
function poseRapide(carte, veut, demandee) {
  if (carte.kind === 'tigress') return { ...carte, chosenAs: veut ? 'pirate' : 'escape' };
  if (carte.kind === 'number' && carte.wild14 && carte.value == null) return { ...carte, value: veut ? 14 : 0 };
  if (carte.kind === 'wild15') {
    const suit = demandee === null ? 'vert' : demandee === 'noir' ? undefined : demandee;
    return { ...carte, kind: 'number', suit, value: 15, wild15: true };
  }
  return carte;
}

function choixRapide(main, pli, veut) {
  const cartesPli = pli.map((t) => t.card);
  const demandee = ledSuitOf(pli);
  let meilleur = null;
  let meilleurRang = 0;
  let meilleurGagne = false;
  for (const c of main) {
    if (!isCardPlayable(c, main, pli)) continue;
    const posee = poseRapide(c, veut, demandee);
    const r = rang(posee);
    const res = resolveTrick([...cartesPli, posee]);
    const gagne = !res.destroyed && res.winnerIdx === cartesPli.length;
    // Ce qu'on cherche : gagner si on veut le pli, perdre sinon. Parmi ces
    // coups-là, le moins cher si on gagne, le plus cher si on perd.
    const cible = gagne === veut;
    let mieux;
    if (meilleur === null) mieux = true;
    else if (cible !== (meilleurGagne === veut)) mieux = cible;
    else if (cible) mieux = veut ? r < meilleurRang : r > meilleurRang;
    else mieux = r < meilleurRang;
    if (mieux) {
      meilleur = { carte: c, posee };
      meilleurRang = r;
      meilleurGagne = gagne;
    }
  }
  return meilleur;
}

// --- Déroulement ---------------------------------------------------------------

// Joue la manche jusqu'au bout. `partie` :
//   ordre       : ids des joueurs dans l'ordre des sièges
//   mains       : Map id -> cartes (copiées ici, on peut les vider)
//   pli         : le pli en cours [{ playerId, card }]
//   meneur      : id de qui a mené le pli en cours
//   plis, bonus : Map id -> plis faits / bonus accumulés
//   annonces    : Map id -> annonce
//   force       : { id, posee } — le coup imposé au prochain joueur à poser
//                 (c'est le coup qu'on évalue)
// Renvoie la Map id -> plis faits et la Map id -> bonus.
function derouler(partie) {
  const { ordre } = partie;
  const mains = new Map([...partie.mains].map(([id, m]) => [id, [...m]]));
  const plis = new Map(partie.plis);
  const bonus = new Map(partie.bonus);
  let pli = [...partie.pli];
  let meneur = partie.meneur;
  let force = partie.force || null;

  for (let garde = 0; garde < 200; garde++) {
    // Qui doit encore poser dans ce pli, dans l'ordre à partir du meneur.
    const debut = ordre.indexOf(meneur);
    const ont = new Set(pli.map((t) => t.playerId));
    const aPoser = [];
    for (let k = 0; k < ordre.length; k++) {
      const id = ordre[(debut + k) % ordre.length];
      if (!ont.has(id) && (mains.get(id) || []).length) aPoser.push(id);
    }
    for (const id of aPoser) {
      const main = mains.get(id);
      let carte;
      let posee;
      if (force && force.id === id) {
        carte = main.find((c) => c.id === force.posee.id) || main[0];
        posee = force.posee;
        force = null;
      } else {
        const veut = (partie.annonces.get(id) || 0) - (plis.get(id) || 0) > 0;
        const choix = choixRapide(main, pli, veut);
        carte = choix.carte;
        posee = choix.posee;
      }
      main.splice(main.indexOf(carte), 1);
      pli.push({ playerId: id, card: posee });
    }
    if (!pli.length) break;
    const cartes = pli.map((t) => t.card);
    const res = resolveTrick(cartes);
    if (!res.destroyed) {
      const gagnant = pli[res.winnerIdx].playerId;
      plis.set(gagnant, (plis.get(gagnant) || 0) + 1);
      const b = trickBonusForWinner(cartes, res.winnerIdx, res.excludedIdx) + res.monstersDestroyed * 20;
      bonus.set(gagnant, (bonus.get(gagnant) || 0) + b);
    }
    meneur = pli[res.leaderIdx].playerId;
    pli = [];
    if (![...mains.values()].some((m) => m.length)) break;
  }
  return { plis, bonus };
}

function scoreDe(id, annonce, issue, numeroManche) {
  return computeRoundScore(annonce, issue.plis.get(id) || 0, numeroManche, issue.bonus.get(id) || 0);
}

module.exports = { tirerDonne, choixRapide, derouler, scoreDe, melanger };
