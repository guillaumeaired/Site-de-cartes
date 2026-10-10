# Bots Skull King à niveaux — spec

But : remplacer le bot unique (qui annonce et joue au hasard) par quatre
niveaux de difficulté croissante, que l'hôte choisit bot par bot dans le
salon, et se donner un banc de mesure qui **prouve** que chaque niveau bat
le précédent. Le modèle appris arrive en dernier, à l'endroit où il rapporte
le plus : l'annonce.

> **Décision du 10 octobre 2026 : trois niveaux, pas quatre.** Mousse
> (Facile), Matelot (Intermédiaire) et Loup de mer (Expert). Le Matelot
> d'aujourd'hui est le Bosco du § 4.3, renommé ; le Matelot du § 4.2 n'est
> plus un niveau — ses outils (évaluer un coup, choisir, répondre aux
> pouvoirs) vivent dans `tactique.js`. Les § 4 et 7 gardent la trace des
> quatre niveaux tels qu'ils ont été construits et mesurés. Mesure à trois
> (60 parties, budget du Loup à 10 ms) : Matelot − Mousse +319 ± 20,
> Loup − Matelot +177 ± 22, zéro coup refusé.

---

## 1. Règles non négociables

### R1 — Un bot ne voit que ce que verrait un humain à sa place

Une stratégie ne reçoit que `stateFor(room, bot)` — la vue exacte qu'aurait
le client d'un humain assis là — plus ce qu'elle a elle-même retenu des
états précédents. Jamais `room`, jamais la main d'un autre. Le niveau le
plus fort *imagine* les mains adverses, il ne les lit pas.

### R2 — Aucune règle n'est réécrite pour les bots

Les actions passent par les vrais handlers (`skullking-bid`,
`skullking-play-card`, `skullking-power-*`), comme aujourd'hui. Ce que le
serveur refuse à un humain, il le refuse à un bot. Seule exception assumée :
le simulateur interne du niveau 4 rejoue des fins de manche avec le moteur
pur (`skullking.js`), en simplifiant les pouvoirs (voir § 4.4) — c'est une
*estimation* pour choisir un coup, pas un arbitrage.

### R3 — Un bot ne gèle pas le serveur

Node est mono-fil : un calcul synchrone de 300 ms fige **toutes** les
salles du serveur pendant 300 ms. Toute décision a un budget de calcul
plafonné (50 ms par défaut, `SK_BOT_BUDGET_MS`), vérifié à l'horloge et non
au nombre d'itérations.

### R4 — L'affichage bureau ne bouge pas

Seule la marque « BOT » du salon change (voir § 5). Rien d'autre dans
`skullking.css`. Vérification par empreinte de géométrie DOM avant/après.

### R5 — Zéro dépendance

Ni TensorFlow ni ONNX côté serveur. Le modèle appris de l'étape 5 est un
fichier JSON de poids, évalué en JS pur.

---

## 2. Architecture

```
server/skullking-bot.js            plomberie : faux socket, minuteur, pilotage (existant)
server/skullking-bots/index.js     registre des niveaux
server/skullking-bots/commun.js    outils partagés : cartes jouables, choix à la pose,
                                   force d'une carte, mémoire de manche
server/skullking-bots/tactique.js  évaluer et choisir un coup, réponses aux pouvoirs
server/skullking-bots/mousse.js    niveau 1, Facile
server/skullking-bots/matelot.js   niveau 2, Intermédiaire (l'ancien Bosco)
server/skullking-bots/loup.js      niveau 3, Expert
server/skullking-bots/simulation.js  donnes imaginées et fin de manche simulée (Loup de mer)
server/skullking-arena.js          banc de mesure sans sockets (§ 3)
server/skullking-bots-simulate.js  tests (branchés dans npm test)
```

### Interface d'une stratégie

```js
{
  key: 'matelot', niveau: 2, nom: 'Matelot',
  observe(state, memoire)          // facultatif : appelé à chaque état reçu
  bid(state, memoire) -> entier
  play(state, memoire) -> { cardId, chosenAs?, declaredValue?, chosenSuit? }
  power(state, memoire) -> [event, payload] | null
}
```

`decide()` de `skullking-bot.js` ne fait plus que router la phase vers la
bonne méthode. `driveBots` ne l'appelle qu'au réveil du bot : à chaque état
diffusé, il se contente de savoir *si* le bot doit agir (`aFaire`, gratuit).
Sans cette séparation, le Monte-Carlo du niveau 4 se serait relancé à chaque
annonce et à chaque carte des autres. Le niveau est porté par le bot (`Map id → niveau`), choisi à
l'ajout et modifiable dans le salon tant que la partie n'est pas lancée.

### La mémoire de manche

`stateFor` ne montre que le pli en cours : les plis précédents de la manche
n'y sont plus. Or `driveBots` est appelé à **chaque** diffusion d'état, donc
après chaque carte posée — le bot voit tout passer. `commun.js` fournit une
mémoire par bot, remise à zéro à chaque nouvelle manche, qui retient :

- les cartes déjà tombées (par `id`) ;
- les **coupes** : un joueur qui pose une numérotée d'une autre couleur que
  celle demandée n'a plus cette couleur (une carte spéciale, jouable
  toujours, ne prouve rien) ;
- les plis gagnés par chacun (déjà dans l'état) et les annonces (révélées en
  phase de jeu).

Les inférences peuvent être fausses (Mary Thorne impose une carte sans que
les autres sachent laquelle) : tout ce qui s'en sert doit tolérer une
contradiction et retomber sur une hypothèse moins contrainte.

Les identifiants de cartes sont déterministes (`createDeck(extensions)` les
numérote dans l'ordre) : le bot reconstruit le paquet de la partie et en
déduit les cartes **inconnues** = paquet − sa main − cartes tombées.

---

## 3. L'arène (prérequis de tout le reste)

`node server/skullking-arena.js --table 1,2,3,4 --parties 400 [--extensions toutes] [--manches 10] [--graine 42]`

### Principe : la vraie salle, une horloge virtuelle

L'arène ne réimplémente rien. Elle :

1. remplace `setTimeout`/`clearTimeout` par un **ordonnanceur virtuel** (file
   triée par échéance) avant de charger les modules — les pauses de pli,
   les minuteurs de pouvoir et la réflexion des bots s'écoulent alors
   instantanément, dans le bon ordre ;
2. neutralise `play-counts` (sinon chaque partie simulée gonflerait le
   compteur du hub) ;
3. crée une salle avec un hôte-bot, assied les bots demandés, lance, et
   déroule l'ordonnanceur jusqu'à `game-end` ;
4. écoute `skullking-error` sur chaque faux socket : **toute erreur est un
   bug de stratégie** (coup illégal), comptée et affichée.

Avantage décisif : pouvoirs, extensions, Butin, Planche, Dernière Salve —
tout est arbitré par le code de production.

### Mesures

Par niveau, sur l'ensemble des parties :

| mesure | définition |
|---|---|
| score moyen | total de fin de partie, ± erreur-type |
| victoires | part des parties terminées 1er (ex æquo partagés) |
| annonces tenues | manches où `made === bid` |
| écart moyen | moyenne de `|made − bid|` |
| erreurs | refus du serveur (doit valoir 0) |
| temps de décision | moyen et max par décision (R3) |

Les sièges tournent d'une partie à l'autre pour annuler l'avantage de
position. `--graine` rend une série reproductible.

### Critère d'acceptation d'un niveau

Sur 400 parties à table mixte `n−1, n` (×2 chacun, 4 joueurs), le niveau
`n` doit avoir un score moyen supérieur au niveau `n−1` d'au moins **deux
erreurs-types de la différence**, et zéro erreur de jeu.

---

## 4. Les niveaux

### 4.1 Niveau 1 — Mousse

Le bot actuel, déplacé tel quel : annonce au hasard (0 dans 35 % des cas),
carte jouable au hasard, pouvoirs par défaut. Sert de plancher et de bot
de test rapide.

### 4.2 Niveau 2 — Matelot

**Annonce** : somme des probabilités de gain de chaque carte, arrondie.
Table de force indicative (à ajuster à l'arène) :

| carte | gain probable |
|---|---|
| Skull King | 0,9 |
| Pirate, Tigresse | 0,75 |
| Sirène | 0,5 |
| numérotée noire | 0,15 + 0,055 × valeur |
| numérotée d'une autre couleur | 13–14 : 0,5 ; 10–12 : 0,25 ; sinon ~0 |
| Fuite, Butin, Kraken, Baleine… | 0 |

La force d'une numérotée baisse avec le nombre de joueurs (plus de chances
qu'un atout ou une carte spéciale passe derrière).

**Jeu** — la règle de base du joueur de plis :

- s'il **manque** des plis : gagner avec la **plus petite** carte qui gagne
  à coup sûr ou presque ; en entame, mener sa meilleure carte ;
- s'il en a **assez** : perdre avec la **plus grosse** carte qui perd
  (pour se débarrasser des cartes dangereuses) ; Fuite en dernier recours.

**Choix à la pose** : Tigresse en Pirate si on veut le pli, en Fuite
sinon ; 0/14 à 14 si on veut le pli, 0 sinon ; Joker dans la couleur où
l'on est le plus court.

**Pouvoirs** : Harry ajuste l'annonce vers les plis réellement faits ;
Will défausse ce qui l'écarte de son annonce ; la Planche retire le Pirate
qui l'arrange ; Rascal mise 0 ; les autres comme le Mousse.

Le Matelot ne se souvient que du pli en cours, et ne lit pas les annonces
des autres.

### 4.3 Niveau 3 — Bosco

Tout le Matelot, plus — par ordre de ce que ça rapporte à l'arène :

- **l'annonce au meilleur gain espéré**, pas l'espérance arrondie. La loi du
  nombre de plis se reconstruit carte par carte, on y ajoute ce que le
  joueur rattrape en jouant (« rattrapage » : 0,8, réglé à 3, 4 et 6
  joueurs), et on garde l'annonce qui rapporte le plus. Un 0 tenu en manche 9
  vaut 90 points, un 1 en vaut 20 : c'est l'essentiel de son avance
  (environ +30 points par partie) ;

- **compte des cartes** (mémoire de manche) : une carte qui « gagne
  presque » devient « gagne à coup sûr » quand tout ce qui la bat est déjà
  tombé ou dans la main du bot. Effet faible à Skull King : à 4 joueurs et
  10 cartes, 34 cartes dorment dans le reliquat, rien n'est jamais sûr ;
- **position** : dernier à jouer, il sait exactement ce qui gagne et prend
  le pli au plus juste ; premier, il entame dans une couleur où les autres
  ont coupé s'il veut perdre ;
- **coupes** des adversaires prises en compte pour estimer si sa carte tient ;
- **chasse aux bonus** quand l'annonce est tenable : faire tomber les 14,
  Pirate sur Sirènes, Skull King sur Pirates, Sirène sur Skull King ;
- **nuisance**, en simple départage : quand il veut perdre et que deux
  coups se valent, celui qui colle le pli à un adversaire qui a déjà son
  compte. Plus forte, elle passait avant le fait de se défaire de ses
  grosses cartes et coûtait 5 points par partie ;
- **pouvoirs** réfléchis : Rosie désigne l'entameur qui l'arrange, Will
  défausse les cartes qui l'écartent de son annonce, Rascal mise 10 ou 20
  quand le contrat est presque sûr, Mary Thorne vise le joueur de tête.

### 4.4 Niveau 4 — Loup de mer

**Monte-Carlo par donnes imaginées** (déterminisation) :

1. tirer N répartitions des cartes inconnues entre les mains adverses (en
   respectant le nombre de cartes de chacun et les coupes observées) ;
2. pour chaque coup légal (et chaque variante : Tigresse Pirate/Fuite,
   0/14 à 0 ou 14), jouer ce coup puis **dérouler la fin de manche** avec la
   politique du Matelot pour tout le monde, sur le moteur pur ;
3. garder le coup au meilleur **score de manche moyen** pour le bot.

L'**annonce** se décide de même : pour chaque annonce possible, simuler la
manche entière sur N donnes imaginées (annonces adverses estimées par le
Matelot) et garder l'annonce à la meilleure espérance.

Simplifications du simulateur (assumées, R2) : les pouvoirs des Pirates
sont ignorés pendant les rollouts, le Butin ne forme pas d'alliance, la
Planche retire le premier Pirate, la Dernière Salve ne donne pas de carte
supplémentaire. Le budget de 50 ms (R3) borne N ; on tire en boucle tant
qu'il reste du temps. L'annonce, une fois par manche, a droit au double.

### 4.5 Réglage fin (facultatif)

Le Loup de mer bat le Bosco de loin (§ 7). Une **température** sur son choix (softmax sur les espérances
plutôt que le maximum) donne un curseur continu de difficulté et des
erreurs plus humaines que le hasard pur. Non exposé dans le salon tant
qu'on n'en a pas besoin.

---

## 5. Interface du salon

- La marque « BOT » porte le niveau en **exposant sur son coin** : BOT¹ …
  BOT³. Info-bulle : « Matelot — niveau 2 sur 3 ». Le chiffre est hors du
  flux : la marque garde sa largeur au pixel près. Les chiffres romains
  prévus d'abord l'élargissaient de 13 px et coupaient « Anne Bonny » sur
  un écran de 1440 px ; un chiffre accolé, de 4 px, la coupait encore.
- Pour l'hôte, la marque est un bouton : un clic fait passer le bot au
  niveau suivant (3 → 1). Événement `skullking-set-bot-level
  { playerId, level }`, mêmes gardes que `skullking-remove-bot` (hôte,
  salon d'attente, cible qui est bien un bot).
- « Ajouter un bot ▾ » ouvre un menu des trois niveaux — chiffre, nom, et
  sous le nom sa difficulté seule (Facile, Intermédiaire, Expert), fournis
  par le serveur (`botLevels`). Rien d'autre dans le cadre. Un clic
  ajoute le bot à ce niveau et referme le menu. Le dernier niveau choisi est
  retenu dans le navigateur, mis en avant et pris d'office au clavier
  (flèches, Entrée, Échap). Le menu se pose au-dessus du bouton, hors du
  flux : fermé, il ne prend aucune place (géométrie du salon identique au
  pixel sur ordinateur, hors la flèche du bouton). Sur téléphone couché, il
  s'ouvre à droite de la colonne, faute de hauteur au-dessus.
- Le niveau voyage dans `broadcastLobby` (`botLevel`) à côté de `isBot`.
- Mode essai : `SK_ESSAI_NIVEAU=1..3` fixe le niveau des bots assis
  d'office (par défaut le Mousse, qui reste le plus rapide à suivre).

---

## 6. Étape 5 — l'annonce apprise

L'annonce est la décision la plus dure à régler à la main et la plus
facile à apprendre.

**Données** : l'arène fait jouer des Bosco / Loups de mer en leur faisant
**explorer** leur annonce (l'annonce heuristique ± 1 ou 2, tirée au
hasard une fois sur trois). Chaque manche de chaque bot donne une ligne :
`(variables de la main, nb joueurs, position, n° de manche, annonce) →
score de manche`.

**Variables** : comptes par catégorie (Skull King, Pirates, Tigresse,
Sirènes, Fuites, Butins, Kraken, Baleine, cartes d'extension), numérotées
par couleur et par tranche de valeur, plus longue couleur, nombre de
couleurs absentes, atouts noirs hauts.

**Modèle** : petit réseau (1 couche cachée de 32) ou régression sur les
variables croisées avec l'annonce, entraîné hors ligne (script Python
autonome ou JS), qui prédit le score attendu de chaque annonce. On joue
l'annonce au meilleur score prédit. Poids exportés dans
`server/skullking-bots/annonce-poids.json`.

**Acceptation** : branché sur le Bosco, il doit battre le Bosco
heuristique selon le critère du § 3.

Plus tard, si besoin : imiter le Loup de mer par un réseau (distillation),
pour avoir sa force sans son coût de calcul.

---

## 7. Plan et état

| étape | contenu | état |
|---|---|---|
| 1 | stratégie interchangeable, niveau par bot, choix dans le salon | fait |
| 2 | arène sans sockets, horloge virtuelle, mesures | fait |
| 3 | Matelot, puis Bosco, validés à l'arène | fait |
| 4 | Loup de mer (Monte-Carlo) | fait |
| 5 | annonce apprise | à faire |

### Mesures (arène, jeu de base, 4 joueurs, 10 manches)

Table mixte 1-2-3-4, 200 parties, sièges tournants, budget du Loup réduit à
10 ms pour que la série tienne en deux minutes (`--graine 30`) :

| niveau | score moyen | victoires | annonces tenues | écart moyen | décision moy / max |
|---|---|---|---|---|---|
| 1 Mousse | −224 ± 8 | 0 % | 20 % | 1,93 | 0,00 / 2,6 ms |
| 2 Matelot | 126 ± 7 | 11 % | 55 % | 0,55 | 0,04 / 2,2 ms |
| 3 Bosco | 174 ± 9 | 18 % | 54 % | 0,57 | 0,03 / 2,9 ms |
| 4 Loup de mer | 304 ± 9 | 71 % | 72 % | 0,33 | 7,8 / 33 ms |

Écarts par partie, mêmes tables : Matelot − Mousse +349 ± 11, Bosco −
Matelot +48 ± 11, Loup − Bosco +131 ± 13. Zéro coup refusé, zéro partie
bloquée. Chaque marche est nette au sens du § 3.

Ce que l'arène a appris en chemin :

- le Bosco tel que prévu d'abord (mêmes annonces que le Matelot, jeu plus
  fin) ne battait pas le Matelot : −3 ± 5. Le jeu de la carte rapporte peu ;
  c'est l'annonce au gain espéré (§ 4.3) qui fait la marche ;
- la nuisance à pleine force coûtait 5 points par partie (§ 4.3) ;
- l'annonce par simulation du Loup vaut 70 points par partie de plus que
  celle du Bosco (+159 contre +88 face au Bosco, 150 parties chacune).

R3 au budget réel (50 ms), pire cas mesuré — 7 Loups de mer, toutes les
extensions : 34 ms en moyenne, 101 ms au plus. Le maximum est l'annonce, qui
a droit au double du budget, une fois par manche.

Pour l'étape 5, l'arène sait déjà tout faire tourner : il reste à lui faire
écrire les lignes d'entraînement (main, annonce explorée, score de manche).
