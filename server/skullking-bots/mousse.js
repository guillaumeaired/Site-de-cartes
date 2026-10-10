// Niveau 1 — le Mousse. Le bot d'origine, tel quel : il annonce au hasard et
// pose une carte jouable au hasard. Il sert de plancher pour mesurer les
// autres, et de bot de test rapide (on suit sans peine ce qu'il fait).

const { ledSuitOf } = require('../skullking');
const { cartesJouables, auHasard } = require('./commun');

function bid(state) {
  // Annonce grossièrement plausible : un peu plus souvent basse que haute.
  const max = state.cardsInRound;
  if (Math.random() < 0.35) return 0;
  return Math.min(max, 1 + Math.floor(Math.random() * Math.max(1, max)));
}

function play(state) {
  const carte = auHasard(cartesJouables(state));
  if (!carte) return null;
  return choixALaPose(carte, state.currentTrick || []);
}

// Certaines cartes exigent un choix au moment de la pose : le serveur refuse
// la pose sans ce choix, le bot doit donc le fournir comme un joueur humain.
function choixALaPose(carte, pli) {
  const payload = { cardId: carte.id };
  if (carte.kind === 'tigress') payload.chosenAs = Math.random() < 0.7 ? 'pirate' : 'escape';
  if (carte.kind === 'number' && carte.wild14 && carte.value == null) payload.declaredValue = 14;
  if (carte.kind === 'wild15' && ledSuitOf(pli) === null) payload.chosenSuit = 'vert';
  return payload;
}

// Renvoie [event, payload] pour le pouvoir en attente, ou null.
function power(state) {
  const pending = state.pendingPower;
  switch (pending.kind) {
    case 'rosie':
      return ['skullking-power-rosie', { leaderId: state.myId }];
    case 'marythorne': {
      const cibles = (pending.options || []).filter((o) => o.handCount > 0);
      const cible = auHasard(cibles) || (pending.options || [])[0];
      return cible ? ['skullking-power-marythorne', { targetId: cible.id }] : null;
    }
    case 'will': {
      const ids = (state.hand || []).slice(0, 2).map((c) => c.id);
      return ids.length === 2 ? ['skullking-power-will', { discardIds: ids }] : null;
    }
    case 'rascal':
      return ['skullking-power-rascal', { stake: 0 }];
    case 'harry':
      return ['skullking-power-harry', { delta: 0 }];
    case 'juanita':
      return ['skullking-power-juanita-done', undefined];
    // Marcher sur la Planche : la cible se désigne une fois le pli complet,
    // pas à la pose - le bot répond donc ici, comme pour un pouvoir.
    case 'plank': {
      const ids = pending.plankTargetIds || [];
      return ids.length ? ['skullking-power-plank', { removesId: ids[0] }] : null;
    }
    default:
      return null;
  }
}

module.exports = {
  key: 'mousse',
  niveau: 1,
  nom: 'Mousse',
  description: 'Facile',
  bid,
  play,
  power,
};
