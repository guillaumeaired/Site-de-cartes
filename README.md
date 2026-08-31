# Guimams

Un site de jeux de cartes à jouer en ligne entre amis. On crée un salon, on
partage son code de quatre caractères, et tout le monde joue depuis son navigateur —
rien à installer, pas de compte à créer.

Cinq jeux, cinq moteurs de règles distincts :

| Jeu | Joueurs | Ce que c'est |
|---|---|---|
| **Bataille** | 2 à 4 | Le grand classique, batailles en chaîne comprises |
| **Rami** | 2 | Rami français, variante maison |
| **L'Ascenseur** | 3 à 7 | On annonce ses plis avant de jouer (variante du *Oh Hell!*) |
| **Skull King** | 3 à 9 | 10 manches de pirates, avec les extensions (Butin, Kraken, Baleine…) |
| **Le 24** | 2 à 8 | Course de calcul mental : quatre cartes, quatre opérations, tomber sur 24 |

## Lancer le site en local

Node 18 ou plus est requis.

```bash
npm ci && npm start
```

Le serveur démarre sur `http://localhost:3000`. Il affiche aussi son adresse sur
le réseau local, pour que les autres joueurs de la maison s'y connectent depuis
leur téléphone.

## Lancer les tests

```bash
npm test
```

Sept suites s'enchaînent, sans dépendance externe ni framework : une par moteur
de règles (Bataille, Rami, Ascenseur, Skull King, Le 24) plus une sur la couche
salon du Skull King et une sur celle du 24. Chacune est un simple script Node qui construit des situations de jeu
et vérifie le résultat. Elles tournent aussi en CI sur chaque push et chaque pull
request, et le déploiement échoue si l'une d'elles casse.

## Comment c'est rangé

Le serveur suit le même découpage pour les cinq jeux :

| Fichier | Rôle |
|---|---|
| `server/<jeu>.js` | Les règles pures : le deck, les coups légaux, qui remporte le pli. Aucune notion de réseau — c'est ce qui rend les tests simples |
| `server/<jeu>-room.js` | Les salons : Socket.io, la table, les reconnexions, la diffusion de l'état à chaque joueur |
| `server/<jeu>-simulate.js` | La suite de tests du moteur correspondant |
| `server/index.js` | Le serveur Express, les salons de Bataille, et les routes techniques |

Le 24 est le seul à ne pas être un jeu de plis, et le seul dont l'écran est
pensé pour un ordinateur (disposition paysage, donne à gauche, suivi de partie
à droite, buzzer à la barre d'espace). Tout le monde reçoit les mêmes quatre
cartes en même temps et cherche **de tête** : rien n'est manipulable tant que
personne n'a appuyé sur « J'ai ! ». Le premier qui appuie prend la main seul,
le chrono de la donne se fige, et il a 20 secondes pour montrer sa combinaison
en fusionnant les cartes ; s'il n'y arrive pas, il est écarté de cette donne et
le chrono repart pour les autres. Les fusions se font entièrement dans le
navigateur (sinon chaque clic coûterait un aller-retour réseau) et le serveur
rejoue la suite d'opérations reçue pour trancher. Son moteur contient aussi un
solveur, qui sert à trois choses : ne jamais distribuer une donne insoluble,
annoncer sa difficulté, et montrer une solution quand personne n'a trouvé.

Deux suites de tests le couvrent plutôt qu'une : `vingtquatre-simulate.js` pour
le moteur (solveur, fractions exactes, validation d'une réponse) et
`vingtquatre-room-simulate.js` pour la machine à états du buzzer — qui a le
droit d'appuyer, ce que coûte une explication ratée, le gel du chrono.

Trois routes techniques : `/healthz` (surveillance de l'hébergeur), `/stats`
(compteurs d'observabilité) et `/play-counts` (nombre de parties lancées par jeu,
qui sert à trier la page d'accueil).

Le front est dans `public/` : une page et un fichier JS par jeu, en JavaScript
natif, **sans étape de build** — on édite, on recharge. `public/apercu-table.html`
n'est pas une page du site mais un banc d'essai : il monte le vrai écran de Skull
King et lui sert un état fabriqué, pour régler une disposition sans ouvrir sept
navigateurs (voir les paramètres d'URL documentés en tête du fichier).

Deux dossiers annexes, hors du site :

- `maquettes/` — les pages de travail du design, autonomes, à ouvrir d'un
  double-clic. Elles ne sont pas servies par le serveur.
- `briefs/` — les scripts Python qui fabriquent les illustrations (`.webp`) à
  partir des planches sources. Les sources brutes ne sont pas versionnées, elles
  sont trop lourdes et ne servent qu'à regénérer ces fichiers.

## Déploiement

Hébergé sur Render, configuré par `render.yaml` (versionné, pour que le réglage
soit lisible ici plutôt que dans un tableau de bord). Chaque push sur `main`
déclenche un déploiement, précédé de `npm ci && npm test` : si la suite de tests
échoue, le déploiement ne part pas.

Sur l'offre gratuite, le serveur s'endort après une période d'inactivité et met
une vingtaine de secondes à se réveiller. Le premier joueur à arriver voit donc
une bannière d'attente — c'est normal, ce n'est pas une panne.

## Droits

Le code est public pour être lu, pas pour être repris : aucune licence n'est
accordée, tous droits réservés. Écrivez-moi si vous voulez en faire quelque
chose.

Les illustrations ont été fabriquées pour ce projet (voir `briefs/`). *Skull
King* est un jeu de Grandpa Beck's Games — seuls les noms des cartes et des
pouvoirs viennent de là, cette implémentation est un projet personnel sans but
commercial et n'est ni affiliée ni approuvée par l'éditeur.
