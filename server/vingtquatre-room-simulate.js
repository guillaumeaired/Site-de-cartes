// Couche d'orchestration (salon du 24) : ce que le moteur pur
// (vingtquatre-simulate.js) ne peut pas couvrir, à savoir la machine à états
// du buzzer — qui a le droit d'appuyer, ce que coûte une explication ratée,
// et le gel du chrono pendant qu'un joueur explique.
//
// Même approche que skullking-room-simulate.js : on appelle directement les
// fonctions exportées du salon sur des salles fabriquées à la main, avec un
// io factice. Les minuteurs posés au passage sont inertes (leur rappel
// vérifie que la salle est bien dans la vraie table `rooms`, ce qui n'est
// jamais le cas ici) — on déclenche donc les transitions à la main, ce qui
// est justement ce qu'on veut tester.

const assert = require('assert');
const {
  peutBuzzer,
  chercheursActifs,
  joueursConnectes,
  scoreboard,
  stateFor,
  demarrerClaim,
  echecClaim,
  msDonneRestant,
  ROUND_MS,
  EXPLAIN_MS,
} = require('./vingtquatre-room');

let n = 0;
function check(label, actual, expected) {
  n += 1;
  assert.deepStrictEqual(actual, expected, `${label}\nattendu: ${JSON.stringify(expected)}\nreçu: ${JSON.stringify(actual)}`);
}

const io = { to: () => ({ emit: () => {} }) };

function joueur(id, extra) {
  return { id, nickname: id, connected: true, score: 0, passe: false, elimine: false, ...extra };
}

// Une salle en pleine donne, prête à recevoir un buzz.
function salle(joueurs, extra) {
  return {
    code: 'TEST',
    phase: 'playing',
    hostId: joueurs[0].id,
    players: joueurs,
    roundNumber: 1,
    roundStartedAt: Date.now(),
    roundEndsAt: Date.now() + ROUND_MS,
    msGele: ROUND_MS,
    claimerId: null,
    claimEndsAt: 0,
    donne: {
      cartes: [
        { id: 'c0', value: 8, label: '8', suit: 'pique' },
        { id: 'c1', value: 4, label: '4', suit: 'coeur' },
        { id: 'c2', value: 3, label: '3', suit: 'trefle' },
        { id: 'c3', value: 2, label: '2', suit: 'carreau' },
      ],
      solution: '(8 - 4) * 3 * 2',
      nbSolutions: 7,
      difficulte: 'moyen',
    },
    ...extra,
  };
}

// --- Qui a le droit d'appuyer sur « J'ai ! » -------------------------------

{
  const [a, b] = [joueur('A'), joueur('B')];
  const room = salle([a, b]);
  check('buzzer libre : tout le monde peut appuyer', [peutBuzzer(room, a), peutBuzzer(room, b)], [true, true]);
}

{
  const [a, b] = [joueur('A'), joueur('B')];
  const room = salle([a, b], { claimerId: 'A' });
  check("un seul joueur explique à la fois : les autres n'ont plus le buzzer", peutBuzzer(room, b), false);
  check("et celui qui a déjà la main ne peut pas rebuzzer", peutBuzzer(room, a), false);
}

{
  const a = joueur('A', { passe: true });
  const room = salle([a, joueur('B')]);
  check('un joueur qui a passé ne peut plus buzzer', peutBuzzer(room, a), false);
}

{
  const a = joueur('A', { elimine: true });
  const room = salle([a, joueur('B')]);
  check("un joueur écarté de la donne ne peut plus buzzer", peutBuzzer(room, a), false);
}

{
  const a = joueur('A', { connected: false });
  const room = salle([a, joueur('B')]);
  check('un joueur déconnecté ne peut pas buzzer', peutBuzzer(room, a), false);
}

{
  const a = joueur('A', { gone: true });
  const room = salle([a, joueur('B')]);
  check('un joueur parti ne peut pas buzzer', peutBuzzer(room, a), false);
}

{
  const a = joueur('A');
  check('pas de buzzer pendant la révélation', peutBuzzer(salle([a, joueur('B')], { phase: 'reveal' }), a), false);
  check('pas de buzzer dans le salon d\'attente', peutBuzzer(salle([a, joueur('B')], { phase: 'lobby' }), a), false);
}

// --- Le buzz fige le chrono de la donne ------------------------------------
// C'est le point qui rend le buzzer jouable : sans ça, appuyer à la 55e
// seconde ne laisserait que 5 secondes pour montrer sa combinaison.

{
  const [a, b] = [joueur('A'), joueur('B')];
  // Donne déjà entamée : il ne reste que 12 s de recherche.
  const room = salle([a, b], { roundEndsAt: Date.now() + 12_000 });
  demarrerClaim(io, room, a);

  check('le buzz donne la main à celui qui a appuyé', room.claimerId, 'A');
  check('le chrono de la donne est mis de côté, pas consommé', Math.round(room.msGele / 1000), 12);
  check('le temps affiché reste figé pendant l\'explication', Math.round(msDonneRestant(room) / 1000), 12);
  check(
    'la fenêtre d\'explication ne dépend pas du temps restant sur la donne',
    Math.round((room.claimEndsAt - Date.now()) / 1000),
    EXPLAIN_MS / 1000
  );
  check('le minuteur de donne est désarmé pendant ce temps', room.roundTimer, null);
}

// --- Une explication ratée coûte la donne, pas la partie --------------------

{
  const [a, b] = [joueur('A'), joueur('B')];
  const room = salle([a, b], { roundEndsAt: Date.now() + 30_000 });
  demarrerClaim(io, room, a);
  echecClaim(io, room, 'temps');

  check('le rateur est écarté de la donne', a.elimine, true);
  check('son score n\'est pas touché', a.score, 0);
  check('il ne peut plus reprendre la main sur cette donne', peutBuzzer(room, a), false);
  check('la main est rendue', room.claimerId, null);
  check('les autres peuvent buzzer à leur tour', peutBuzzer(room, b), true);
  check('la donne continue', room.phase, 'playing');
  check('le chrono repart où il s\'était arrêté', Math.round(msDonneRestant(room) / 1000), 30);
}

{
  // Deux joueurs, les deux se trompent : plus personne ne peut chercher, la
  // donne se termine sans attendre la fin de son chrono.
  const [a, b] = [joueur('A'), joueur('B')];
  const room = salle([a, b]);
  demarrerClaim(io, room, a);
  echecClaim(io, room, 'temps');
  demarrerClaim(io, room, b);
  echecClaim(io, room, 'temps');

  check('plus aucun chercheur', chercheursActifs(room).length, 0);
  check('la donne se termine', room.phase, 'reveal');
  check('personne n\'a trouvé', room.reveal.trouve, false);
  check('la fin est racontée comme un abandon, pas comme un temps écoulé', room.reveal.raison, 'abandon');
  check('la solution est montrée', room.reveal.solution, '(8 - 4) * 3 * 2');
}

{
  // Un joueur qui avait passé ne « réveille » pas la donne quand l'autre rate.
  const a = joueur('A');
  const b = joueur('B', { passe: true });
  const room = salle([a, b]);
  demarrerClaim(io, room, a);
  echecClaim(io, room, 'temps');
  check('un joueur qui a passé ne remet pas la donne en vie', room.phase, 'reveal');
}

{
  // À trois, la donne doit survivre à un raté : il reste des chercheurs.
  const [a, b, c] = [joueur('A'), joueur('B'), joueur('C')];
  const room = salle([a, b, c]);
  demarrerClaim(io, room, a);
  echecClaim(io, room, 'temps');
  check('à trois, un raté ne clôt pas la donne', room.phase, 'playing');
  check('il reste deux chercheurs', chercheursActifs(room).map((p) => p.id), ['B', 'C']);
}

// --- Comptage des chercheurs -----------------------------------------------

{
  const room = salle([
    joueur('A'),
    joueur('B', { passe: true }),
    joueur('C', { elimine: true }),
    joueur('D', { connected: false }),
    joueur('E', { gone: true }),
  ]);
  check('seuls les joueurs encore en lice comptent', chercheursActifs(room).map((p) => p.id), ['A']);
  check('les déconnectés comptent comme absents, les partis aussi', joueursConnectes(room).map((p) => p.id), ['A', 'B', 'C']);
}

// --- Ce que chaque joueur voit à l'écran -----------------------------------

{
  const [a, b] = [joueur('A', { score: 2 }), joueur('B', { score: 5 })];
  const room = salle([a, b]);
  demarrerClaim(io, room, a);

  const vueA = stateFor(room, a);
  const vueB = stateFor(room, b);

  check('celui qui a la main sait qu\'il doit expliquer', vueA.jeExplique, true);
  check('les autres savent qui explique', [vueB.jeExplique, vueB.claimerNickname], [false, 'A']);
  check('le chrono est annoncé figé des deux côtés', [vueA.chronoFige, vueB.chronoFige], [true, true]);
  check('le buzzer est éteint pour tout le monde pendant l\'explication', [vueA.peutBuzzer, vueB.peutBuzzer], [false, false]);
  check('la fenêtre d\'explication est envoyée aux deux', vueA.explainMs, EXPLAIN_MS);
  check(
    'le tableau des scores est trié du plus fort au plus faible',
    scoreboard(room).map((s) => s.nickname),
    ['B', 'A']
  );
  check('le tableau signale qui a la main', scoreboard(room).find((s) => s.id === 'A').claime, true);
}

{
  const [a, b] = [joueur('A'), joueur('B', { elimine: true })];
  const room = salle([a, b]);
  const vueB = stateFor(room, b);
  check('un joueur écarté le sait', vueB.jeSuisElimine, true);
  check('et son buzzer est éteint', vueB.peutBuzzer, false);
  check('celui qui est encore en lice garde le sien', stateFor(room, a).peutBuzzer, true);
  check('le tableau des scores signale les écartés', scoreboard(room).find((s) => s.id === 'B').elimine, true);
}

console.log(`\nvingtquatre-room-simulate.js : ${n}/${n} assertions passées.`);
process.exit(0);
