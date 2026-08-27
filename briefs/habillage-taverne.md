# Habillage « Taverne » — cahier de génération

Cible : le rendu peint de la maquette (bois ciré, laiton, feutre vert, parchemin,
lumière de bougie). Le CSS ne fabrique plus la matière — il pose des images
peintes et gère la mise en page, les états et le texte.

**Génération : manuelle**, par Paul, dans Gemini. Découpage et intégration :
scriptés. Rien ici ne suppose un accès API.

---

## 1. Les trois règles non négociables

### R1 — Aucun texte n'est peint dans une image

Sur la maquette, « REGISTRE DE BORD », « 140 », « Manche 3 / Pli 2 sur 4 » sont
peints. Dans le site ce sont des valeurs qui changent à chaque pli. Toute image
générée est donc un **contenant vide** : le carnet a les pages blanches, le bouton
est une plaque de laiton nue, le parchemin n'a pas une lettre. Le texte reste du
DOM — net à tout zoom, sélectionnable, lisible au lecteur d'écran, traduisible.

Ajouter à chaque prompt : `NO TEXT, no lettering, no numbers, no watermark`.

Deux exceptions, et une seule est gratuite :

- **le logo**, qui ne change jamais ;
- **les quatre familles numérotées**, livrées avec leur chiffre peint dans les
  médaillons d'or de la carte. Le prix de l'entorse est exactement celui que R1
  annonce : là où un cadre vide couvrirait les 14 valeurs d'une famille avec
  **un** fichier, il en faut **14** — soit 56 fichiers pour les quatre familles
  (~28 Ko pièce), 4 générations à surveiller au lieu d'une image, et aucun 0
  possible pour le 0/14 de l'extension, qui retombe donc sur le cadre CSS. On
  l'a gardée parce que les médaillons peints sont beaux et qu'ils gravent le
  chiffre bien plus gros que ne le ferait un pied de parchemin. Le pied, lui,
  reste du DOM mais hors de l'écran, à l'usage des lecteurs d'écran : aucune
  carte illustrée ne porte de cartouche visible — voir le lot 4.

### R2 — Tout ce qui s'étire est généré en « 9 tranches »

Le registre grandit avec le nombre de joueurs, le chat s'allonge, les boutons
suivent leur libellé. Une image peinte étirée devient de la bouillie.

Le 9-slice (`border-image` en CSS) découpe l'image en 9 : les 4 coins restent
intacts, les 4 bords se répètent, le centre se répète. D'où deux contraintes de
génération :

- **les coins portent le décor** (ferrures, équerres, clous, reliure) ;
- **les bords et le centre sont calmes et réguliers** — bois filant dans le sens
  de la longueur, feutre uni, papier vierge. Pas de nœud pittoresque au milieu,
  pas de tache unique : ils se répéteraient en damier.

**Exception : le plateau de jeu.** Il est peint en légère plongée (décision du
27/08/2026). Une image en perspective ne se découpe pas en tranches — ses bords ne
sont pas parallèles aux axes. Elle est donc à **ratio fixe**, agrandie ou réduite
en bloc. En contrepartie le décor (bouteilles, pièces, bougie, planches) y est
peint directement, ce qui supprime `fond-salle` et l'essentiel des sprites du
lot 3. Côté CSS, `.sk-table` passe de `height:340px` + largeur libre à une boîte
à ratio fixe centrée ; les sièges, déjà positionnés en pourcentages, suivent.

Les cartes posées restent **droites** sur la table inclinée, comme sur la maquette
— pas de transformation 3D.

### R3 — La cohérence vient d'une image de référence, pas des mots

Vingt prompts bien écrits donnent vingt styles différents. Seul levier fiable :
joindre une image de référence validée à *chaque* génération, avec « same painting
style, same lighting, same palette as the reference ».

C'est aussi pourquoi les petits objets se génèrent **par planches groupées** (les
six pièces d'or dans une seule image, découpée ensuite) plutôt qu'un par un :
générés ensemble, ils partagent forcément la lumière.

---

## 2. Le prompt-socle

À placer en tête de chaque génération, avant le sujet :

```
Painterly digital illustration, golden-age-of-piracy tavern, warm candlelight
from the left, deep shadows. Oiled dark oak, aged brass, bottle-green felt,
weathered parchment, oxidised copper. Rich but desaturated — no neon, no pure
yellow, no pure white. Hand-painted texture, visible brush and grain, subtle
scratches and wear. Rendered as a game UI asset: sharp, centred, orthogonal
(no perspective tilt), even lighting across the piece.
NO TEXT, no lettering, no numbers, no logos, no watermark.
```

Puis, selon le besoin :

- **fond plein** (hero, plateau, bois) → `full-bleed, fills the entire frame edge to edge`
- **découpe** (pièces, sceau, bougie, équerres, logo) → `isolated object on a flat
  pure magenta background (#FF00FF), no shadow touching the background edge`

> Le magenta pur : Gemini ne sort pas de transparence fiable. On génère sur fond
> chroma et on détoure derrière.

---

## 3. Le pipeline

```
public/assets/skin/src/   ← les PNG bruts de Gemini, déposés tels quels
public/assets/skin/       ← les .webp découpés et optimisés, utilisés par le CSS
```

Trois étapes, scriptées (Pillow + `cwebp`, tous deux installés) :

1. **détourage** — le magenta devient transparent, la boîte est recadrée au sujet ;
2. **découpe des planches** — une planche de 6 pièces devient 6 fichiers ;
3. **conversion** — `cwebp -q 88` (`-alpha_q 100` pour les sprites), plus une
   variante `@1x` par downscale pour les écrans non-retina.

Gemini ne prend pas des dimensions en pixels mais des **ratios**. L'inventaire
donne donc un ratio ; recadrage et mise à l'échelle se font au découpage. Viser la
plus haute définition proposée — on descend toujours, on ne remonte jamais.

---

## 4. L'inventaire

`slice` = les 4 tranches CSS (haut/droite/bas/gauche, en pixels de l'image
générée, à recalculer après recadrage) · `α` = nécessite un détourage.

### Lot 0 — la référence de style

Pas de planche mère séparée : **`hero-taverne` tient ce rôle**. Il contient déjà
tout le vocabulaire (bois, laiton, feutre, parchemin, bougie, or). On l'achève en
premier, puis on le joint en référence à toutes les générations suivantes.

### Lot 1 — les trois premières images ✅ *prompts écrits*

| fichier | ratio | α | note |
|---|---|---|---|
| `hero-taverne.png` | 16:9 | — | Les **4 pirates** attablés (anto au coco à la paille, guy-mams au livre, guigui au bandana, pablo au chapeau). Bas de l'image sombre et calme : le panneau vert s'y pose. **Joindre les 4 cartes en référence.** |
| `logo-skullking.png` | 16:9 | ✅ | Le lettrage doré. Seule exception à R1. |
| `plateau-taverne.png` | 16:9 | — | Table en légère plongée : feutre uni, cordage, planches ferrées, décor peint autour (bouteilles, pièces, bougie). **Le feutre central doit rester vide.** Ratio fixe, pas de 9-slice. |

### Lot 2 — le châssis, ce qui s'étire

| fichier | ratio | slice | α | note de génération |
|---|---|---|---|---|
| `barre-bois.png` | 10:1 | 40 / 200 / 40 / 200 | — | Poutre horizontale, ferrures aux deux bouts, **milieu = veine régulière** |
| `panneau-vert.png` | 8:5 | 110 | — | Bois peint vert bouteille, cadre de laiton, coins ouvragés, centre uni |
| `parchemin.png` | 6:7 | 90 | — | Parchemin, bords brûlés/déchirés, **centre vierge et clair** |
| `carnet.png` | 4:5 | 130 / 70 / 90 / 70 | — | Carnet ouvert, reliure cuir en haut, papier ligné pâle, centre calme |
| `panneau-bois.png` | 1:1 | 80 | — | Planche de chêne clouée, cadre de laiton |
| `champ-saisie.png` | 9:2 | 44 | — | Rainure creusée dans le bois, liseré de laiton, fond sombre |
| `btn-laiton.png` ×3 états | 9:2 | 52 | — | Plaque de laiton bombée, rivets aux coins, **surface nue** — repos / éclairé / enfoncé |
| `btn-rouge.png` ×3 états | 9:2 | 52 | — | Idem en laque bordeaux à liseré doré |

### Lot 3 — les sprites

Réduit par la décision « décor peint dans le plateau ». Restent :

| planche | ratio | contenu à découper |
|---|---|---|
| `planche-ferrures.png` | 1:1 | Équerre d'angle dorée, sceau de cire rouge vierge, clou de laiton, anneau de laiton vide (cadre de portrait) |
| `planche-pieces.png` | 1:1 | 6 pièces or/cuivre, angles et usures variés, grille 3×2 |

Sur `#FF00FF`, détourage automatique.

### Lot 4 — les cartes

Format 1× : **84 × 118 px** → générer en 3×, soit ~252 × 354.

| fichier | nb | note |
|---|---|---|
| `dos-cartes-sk.png` | 1 ✅ | Dos de carte, motif symétrique. Sort à 512 px de large : il ne se voit jamais à plus de 84 px |
| `cartes-{tresor,violettes,atouts,perroquets}-sk.png` | 4 ✅ | Les quatre familles numérotées, **une planche de 14 cartes chacune** : Trésor (jaune), Carte au trésor (violet), Pavillon noir (l'atout) et Perroquets (vert). Le chiffre est peint dans les médaillons, donc pas de cadre vide possible. Découpées par `briefs/decouper-planche-numerotees.py` |
| `extra-cards-sk.png` | 1 ✅ | **Planche des spéciales classiques**, dix cases en deux rangées de cinq : Fuite, Skull King, les deux Sirènes, puis Will, Harry, Rosie, Rascal — et deux doublons sans emploi (une seconde Rosie, un second Will). Découpée par `briefs/decouper-planche-speciales.py`, qui réutilise la grille des familles numérotées |
| `extras-extras.png` | 1 ✅ | **Seconde planche**, cinq cases en une rangée, sur drap bleu : Kraken, Butin, Baleine blanche, Raie Tachetée, Tigresse. Même script — le repérage isole ce qui n'est pas le fond, échantillonné dans les marges, et se moque que le fond soit du bois ou du drap. Quatre cases en sortent : la Raie est reprise sur `extension-sk` |
| `extension-sk.png` | 1 ✅ | **L'extension**, dix cases en deux rangées de cinq. Trois en sortent : la Dernière Salve (la bordée tirée du navire), le Joker (le singe couronné) et la **Raie Tachetée** au cerf-volant. Le reste est soit repris en mieux par la planche suivante, soit une variante non retenue |
| `extension-2-sk.png` | 1 ✅ | Les quatre sujets du haut de la planche précédente, repeints : Coffre de Davy Jones, Mat le Forban, Mary Thorne, Marcher sur la Planche. Ce sont ceux-là qui entrent dans le jeu |
| `mary-thorne.png` | 1 ✅ | Mary Thorne repeinte, livrée **carte seule** sur un carré de couleur. Le script recadre d'abord sur ce carré (`CARTE_SEULE`) : la grille échantillonne le fond dans les marges et y trouverait sinon le blanc de la page, ramenant le carré entier comme une carte |
| illustrations spéciales restantes | 1 | Juanita Jade |

**La Tigresse est le seul cas où l'illustration coûte un signal.** Sur la carte
dessinée, sa fenêtre est coupée en deux — rouge Pirate d'un côté, étain Fuite
de l'autre — et bascule franchement dans la couleur retenue une fois son choix
révélé. Le cadre peint, lui, est rouge : juste tant que le choix est ouvert,
menteur dès qu'elle est annoncée en Fuite. D'où un liseré de 3 px posé autour
de la carte illustrée, de la couleur retenue, et — depuis les emblèmes du
lot 3 — le **sceau** frappé sur le dessin. C'est l'un des deux cas où le
liseré remplace le pied plutôt que de s'y ajouter — voir plus bas.

**Les cases à personnage peignent leur nom** dans un cartouche de parchemin —
une deuxième entorse à R1, du même genre que les chiffres des familles
numérotées et payée du même prix : la Fuite existe en cinq exemplaires et se
contente d'un fichier, mais chaque personnage en demande un, et une Rosie
peinte « Rosie la Douce » ne peut plus servir de Juanita Jade. Les cinq cases
de la seconde planche n'ont pas ce problème : seule la Tigresse y porte un
nom, les quatre autres ne montrent qu'un sujet.

**Aucune carte illustrée ne garde son cartouche de pied**, sans exception —
familles numérotées, spéciales classiques et portraits perso compris. On l'a
d'abord gardé sur le Vert (son chiffre n'est peint que dans les médaillons
d'angle, dont celui du haut passe sous la carte voisine dans l'éventail),
puis sur les planches classiques (à 84 px un nom peint tombe sous les 6 px de
haut). Les deux arguments sont justes et n'ont pas suffi : un bandeau de
parchemin posé en travers du bas du dessin, sur toute sa largeur, coûte plus
qu'il ne rapporte. À l'écran c'est le dessin qui identifie la carte, bien
avant son nom. Le pied reste dans le document, hors champ, à l'usage des
lecteurs d'écran. Là où le nom compte vraiment — hésiter à cocher une ligne
d'extension dans le salon — c'est la fiche qui le donne, carte en grand et
règle dessous, ouverte par le « ? » de chaque ligne.

Deux cartes changent d'état en cours de pli et le disaient dans ce pied : il
fallait le **remplacer**, pas seulement l'enlever. La Tigresse annoncée en
Pirate ou en Fuite, et le Joker une fois posé, qui a déclaré une famille.
Toutes deux portent un liseré de 3 px de la couleur retenue.

Pour le Joker, le liseré suffit : la famille qu'il déclare EST une couleur, et
les quatre couleurs sont partout ailleurs à l'écran. Pour la Tigresse, non — le
liseré suppose qu'on sache que rouge veut dire Pirate, et sur une carte posée
au fond du tapis les 3 px disparaissent. Elle est donc la **seule exception**
à « rien n'est posé sur le dessin » : l'emblème retenu y est frappé comme un
sceau, à 62 % de la largeur, bas sur le buste — le visage reste dégagé, et
c'est l'endroit le moins recouvert quand les cartes du pli se chevauchent. Ce
qu'il dit n'est pas une couleur mais une fonction, et il le dit avec l'image
exacte que le joueur a cliquée pour choisir : le même pavillon, les mêmes
sabres.

**Blanchir les coins ne se fait pas sur la couleur.** Les coins des cartes sont
arrondis dans la planche, et c'est le fond qui s'y voit : on le repeint du
blanc du liseré, `border-radius` refaisant l'arrondi à l'écran. La règle
d'origine blanchissait, dans la couronne extérieure de la découpe, tout ce qui
ressemblait au fond. Sur un plan de bois elle passait — rien de brun ne touche
le liseré. Sur le drap bleu de la planche d'extension, non : la Raie Tachetée
est une carte bleue du même bleu que le drap, et la règle lui mangeait des
morceaux de cadre doré jusqu'au milieu de ses bords.

La ressemblance de couleur ne dit pas si un pixel est dehors ou dedans. C'est
la **connexité** qui le dit : on ne blanchit que ce qui touche le bord de la
découpe et tient d'un seul tenant jusqu'à lui. Le liseré blanc fait le tour
complet de chaque carte, donc par construction aucun pixel d'illustration
n'est relié au dehors. Corrigé dans `briefs/decouper-planche-numerotees.py`,
d'où toutes les découpes tirent leur `carte()`. Les cartes du plan de bois y
gagnent aussi : elles perdaient des entames de bannière et de chevelure, du
brun trop proche de celui de la planche.

Les planches se génèrent d'un coup, les 14 cartes ensemble, en deux rangées de
sept sur un plan de travail en bois : c'est ce qui leur donne le même cadre et
la même lumière. Le script repère les cartes par ce qui n'est PAS le bois — le
bois s'échantillonne dans les marges latérales, sous le titre, dont la hauteur
change d'une planche à l'autre.

**Le ratio est la seule chose à ne pas rater.** Une carte du jeu fait 7:10
(`.sk-card` : `height: width / 0.7`), et les illustrations en place sont à ce
ratio exact — elles se posent en `cover` sans être recadrées. Les planches, elles,
sortent en 0,62 de large pour 1 de haut : le découpage étire donc les cartes de
12 % jusqu'au format du jeu. On avait d'abord élargi le liseré blanc à la place :
ça ne déformait rien, mais le bord épaissi donnait l'impression d'une carte posée
sur une autre. Un étirement de 12 % ne se voit pas ; un liseré double, si.

Reste que c'est une rustine. **Demander le ratio 7:10 à la génération**
(`playing-card frame, aspect ratio 7:10, slightly wide — NOT a standard poker
card`) : le découpage reprendra les cartes telles quelles et il n'y aura plus
rien à étirer. La première planche des Perroquets est arrivée au ratio d'une
vraie carte à jouer, ~1:2, bien trop étroite pour un étirement discret, et avec
neuf médaillons mal numérotés ; elle a été régénérée plutôt que rattrapée.

### Lot 5 — les portraits

En place : `anto-coco`, `guy-mams`, `guigui`, `pablo`. Manque le 5ᵉ Pirate
(Will le Bandit), qui emprunte pour l'instant le Will de la planche classique.

Ces quatre-là ne sont plus un habillage parmi d'autres mais **un paquet à
part**, choisi par l'hôte dans le salon (« Classiques » / « Perso »). Le paquet
perso ne redéfinit que des Pirates : tout ce qu'il ne dit pas retombe sur le
classique, ce qui permet de le proposer sans avoir peint les 74 cartes. Le
réglage voyage avec l'état de jeu et jamais en préférence locale — deux
joueurs doivent voir la même carte posée sur le tapis.

---

## 5. Ordre de marche

**≈ 35 générations** pour les lots 0 à 3, **+ 25** pour les cartes.

1. **Lot 1** — hero, logo, plateau. Le hero d'abord, on le valide à l'œil, il
   devient la référence des deux autres.
2. **Lot 2 partiel** — `barre-bois`, `panneau-vert`, `btn-laiton`, `btn-rouge`,
   `champ-saisie`. → l'**écran d'accueil** est refait en entier. C'est la preuve
   que la méthode tient.
3. **Reste du lot 2 + lot 3** → l'écran de jeu.
4. **Lot 4** → les cartes.

### Contrôle avant d'accepter une image

- aucune lettre nulle part (sauf le logo) ;
- le bas du hero est sombre et vide de visages ;
- le feutre du plateau est **vraiment uni** — pas une carte, pas une pièce dessus ;
- le cordage fait le tour complet, les 4 coins compris ;
- pour un 9-slice : le centre et les bords sont calmes, le décor est aux coins.

---

## 6. Deux choses que la maquette implique et que le site n'a pas

- Une **barre de navigation** (Accueil / Créer / Rejoindre / Règles / Classement).
  Aujourd'hui l'accueil est une colonne unique sans nav.
- Un **Classement**. Il n'existe pas : ni page, ni stockage des scores entre
  parties côté serveur. C'est une fonctionnalité, pas de l'habillage.

Le panneau latéral devra aussi passer de 184 px à ~300 px pour que le carnet peint
respire comme sur la maquette.

---

## 7. Journal des assets reçus

### Lot 1 — 27/08/2026 ✅

| brut (`skin/src/`) | sortie (`skin/`) | dimensions | poids |
|---|---|---|---|
| `hero-sk.png` | `hero-taverne.webp` | 1701×924 | 216 Ko |
| `boardgame-sk.png` | `plateau-taverne.webp` | 1369×1149 | 270 Ko |
| `logo-sk-horizontal.png` | `logo-skullking-h.webp` | 2057×748 | 321 Ko |
| `logo-sk.png` | `logo-skullking-v.webp` | 1291×844 | 180 Ko |

Détourage du logo empilé : propre, 0 pixel magenta résiduel. Le logo horizontal
est arrivé avec son alpha, rien à faire.

**Deux logos, deux emplois** : l'horizontal (ratio 2.75) pour le bandeau du haut,
l'empilé (ratio 1.53) pour l'accueil et l'écran de fin.

### Géométrie du plateau

Le feutre est un **trapèze** — conséquence de la plongée. Un point (u,v) du plan
de jeu, u et v dans [0,1], se projette ainsi (fractions de l'image) :

```
HAUT, BAS      = 0.225, 0.737
G_HAUT, D_HAUT = 0.237, 0.766     (bord supérieur, le plus étroit)
G_BAS,  D_BAS  = 0.129, 0.859     (bord inférieur)

g, d = lerp(G_HAUT, G_BAS, v), lerp(D_HAUT, D_BAS, v)
x    = lerp(g, d, u)
y    = lerp(HAUT, BAS, v)
```

Les cartes et les jetons doivent en plus être **mis à l'échelle selon v**
(≈ 0.72 au fond, 1.10 au premier plan), sinon une carte posée en haut paraît
géante. Vérifié au rendu : `briefs/traiter-assets.py` produit les webp, la
projection a été contrôlée sur 6 sièges.

**Ratio réel : 6:5**, pas le 16:9 demandé — le plateau est plus carré que sur la
maquette. Le feutre seul fait ≈ 16:10, ce qui reste bon. `.sk-table` prendra donc
`aspect-ratio: 1369/1149`.

### Lot 2 — 27/08/2026 ✅ (7 sur 8)

Découpes en 9 tranches, vérifiées par étirement (`briefs/verifier-tranches.py`,
qui reproduit `border-image` en Pillow et rend chaque pièce à ×1.9 en largeur puis
×1.8 en hauteur). Les valeurs sont stockées à côté de chaque asset, en
`<nom>.tranches`, dans l'ordre CSS **haut droite bas gauche**.

| asset | dimensions | tranches | poids |
|---|---|---|---|
| `barre-bois.webp` | 1672×229 | `0 100 0 100` | 73 Ko |
| `panneau-vert.webp` | 1482×741 | `145 150 145 150` | 154 Ko |
| `btn-laiton.webp` | 1617×520 | `130 150 130 150` | 189 Ko |
| `btn-rouge.webp` | 1595×494 | `125 145 125 145` | 122 Ko |
| `panneau-bois.webp` | 1236×1234 | `180 180 180 180` | 329 Ko |
| `carnet.webp` | 1038×1363 | `255 90 90 90` | 182 Ko |
| `champ-saisie.webp` | 1419×283 | `40 150 40 150` | — |

**Manque `parchemin`** (« Ton objectif » et « Dernières nouvelles »).

Deux écarts à la commande, tous deux absorbés :

- `champ-saisie` est arrivé sur bois plein au lieu du magenta. Recadré sur la
  fente de laiton (1419×283, ratio 5.0) ; le bois autour était de toute façon
  redondant avec `panneau-bois`.
- `panneau-bois` a ses planches **verticales**. Son centre s'étire, donc la
  largeur des planches varie avec la taille du panneau. Invisible aux
  proportions prévues ; si ça se voit un jour, passer son centre en
  `border-image-repeat: repeat`.

Les états de survol et d'enfoncement des boutons se font en CSS (luminosité +
ombre interne) — un seul asset par bouton, pas trois.

### Lot 3 — 27/08/2026 ✅ les deux emblèmes de la Tigresse

| brut (`skin/src/`) | sortie (`skin/`) | dimensions | poids |
|---|---|---|---|
| `fuite-pirate-sk.png` | `embleme-fuite.webp` | 478×512 | 81 Ko |
| ” | `embleme-pirate.webp` | 531×512 | 102 Ko |

Une seule planche, les deux disques côte à côte, livrée déjà détourée.
`briefs/decouper-emblemes.py` relève les colonnes entièrement transparentes,
coupe au milieu du plus large couloir (jamais une valeur en dur : la planche
peut être regénérée décalée), recadre chaque moitié sur sa boîte englobante et
les ramène à 512 px de haut — les deux blasons doivent peser pareil dans le
cadre de choix.

**Deux emplois, une seule paire de fichiers :**

- **le cadre de choix**, au centre de l'écran, quand on pose la Tigresse. Les
  autres choix de pose (Joker, 0/14, Marcher sur la Planche) tiennent dans la
  barre d'actions parce qu'ils précisent une carte ; celui-ci décide de ce
  qu'elle est, et rien ne le reprend. Les deux blasons en grand, séparés du
  slash de la maquette — tracé au trait, pas au caractère : un « / » de fonte
  penche selon la police et ne monte jamais aussi haut que les disques. Sortie
  possible sans choisir (clic hors du cadre, Échap, « Reposer la carte ») :
  le cadre couvre tout l'écran, sans porte un clic de travers bloquerait le
  tour ;
- **le sceau sur la carte**, une fois le choix révélé (voir le lot 4).

Sous 420 px de large les disques s'empilent et le slash devient horizontal ;
sous 560 px de **haut** — téléphone couché, la position de jeu la plus
courante — ils restent côte à côte et rapetissent, sinon un des deux choix
tombe hors champ au moment de trancher.
