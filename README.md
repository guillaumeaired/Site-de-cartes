# Guimams

Un site de jeux de cartes à jouer en ligne entre amis. On crée un salon, on
partage son code de quatre caractères, et tout le monde joue depuis son navigateur —
rien à installer, pas de compte à créer.

Quatre jeux, quatre moteurs de règles distincts :

| Jeu | Joueurs | Ce que c'est |
|---|---|---|
| **Bataille** | 2 à 4 | Le grand classique, batailles en chaîne comprises |
| **Rami** | 2 | Rami français, variante maison |
| **L'Ascenseur** | 3 à 7 | On annonce ses plis avant de jouer (variante du *Oh Hell!*) |
| **Skull King** | 3 à 7 | 10 manches de pirates, avec les extensions (Butin, Kraken, Baleine…) |

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

Cinq suites s'enchaînent, sans dépendance externe ni framework : une par moteur
de règles (Bataille, Rami, Ascenseur, Skull King) plus une sur la couche salon du
Skull King. Chacune est un simple script Node qui construit des situations de jeu
et vérifie le résultat. Elles tournent aussi en CI sur chaque push et chaque pull
request, et le déploiement échoue si l'une d'elles casse.

## Comment c'est rangé

Le serveur suit le même découpage pour les quatre jeux :

| Fichier | Rôle |
|---|---|
| `server/<jeu>.js` | Les règles pures : le deck, les coups légaux, qui remporte le pli. Aucune notion de réseau — c'est ce qui rend les tests simples |
| `server/<jeu>-room.js` | Les salons : Socket.io, la table, les reconnexions, la diffusion de l'état à chaque joueur |
| `server/<jeu>-simulate.js` | La suite de tests du moteur correspondant |
| `server/index.js` | Le serveur Express, les salons de Bataille, et les routes techniques |

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
