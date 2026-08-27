#!/usr/bin/env python3
"""Fabrique les quatre cartes 0/14 à partir des cartes peintes existantes.

L'extension ajoute un 0/14 par famille : une carte dont la valeur n'est fixée
qu'au moment de la pose. Aucune planche ne la peint — les planches numérotées
vont de 1 à 14 — et elle restait donc la seule carte du paquet à s'afficher
en cadre CSS au milieu de cartes illustrées.

On la fabrique : une carte de la famille sert de dessin, et ses DEUX médaillons
d'angle sont recouverts par la pastille 0/14 de sa couleur. La carte 0/14
partage donc son illustration avec une autre de sa famille — c'est inévitable,
les quatorze dessins sont tous pris, et c'est le médaillon qui identifie une
carte, pas son sujet.

Le 5 sert de modèle. Ce n'est pas un choix esthétique : les valeurs qui
portent un bonus (le 14 vaut 10 ou 20 points, le 8 de l'extension 5, le 7 en
coûte 5) sont écartées, pour qu'un sosie ne puisse jamais signifier un score
différent. Le 5 n'a aucun effet.

Les médaillons sont RELEVÉS sur chaque carte, pas supposés : elles sont
peintes une par une, et leurs médaillons ne tombent ni au même endroit ni à la
même taille d'une famille à l'autre — 85 px de large sur le Perroquet, 128 sur
le Pavillon, soit la moitié en plus.

Ils sont relevés à la main, à la grille. Un repérage automatique a été essayé
et jeté : le médaillon est un ANNEAU d'or autour d'un chiffre sombre, et une
fois le liseré du cadre effacé par érosion, l'anneau se brise en arcs. Le plus
gros arc n'est pas le médaillon — la pastille se posait décalée et trop
petite, laissant le 5 dépasser sur trois cartes sur quatre.

    python3 briefs/composer-cartes-0-14.py
"""
import subprocess
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'public/assets/skin/src/0-14-sk.png'
CARTES = RACINE / 'public/assets/cards'

# La planche des pastilles, dans l'ordre où elle est peinte.
FAMILLES = [
    ('jaune', 'tresor'),
    ('vert', 'perroquet'),
    ('violet', 'carte'),
    ('noir', 'pavillon'),
]
MODELE = 5          # la valeur dont on emprunte le dessin
MARGE = 1.06        # la pastille déborde un peu du médaillon : rien ne doit dépasser

# Les deux médaillons de chaque carte modèle, en pixels de l'image (434 x 620),
# relevés à la grille. Coin haut-gauche puis coin bas-droit.
MEDAILLONS = {
    'tresor-5':    [(18, 14, 132, 122), (322, 490, 434, 600)],
    'perroquet-5': [(20, 22, 105, 97), (317, 502, 411, 587)],
    'carte-5':     [(22, 20, 142, 130), (318, 492, 430, 600)],
    'pavillon-5':  [(22, 22, 150, 140), (320, 494, 432, 600)],
}
PAGE = np.array([255.0, 255.0, 255.0])


def plages(profil, mini):
    out, debut = [], None
    for i, dedans in enumerate(profil > 0.02):
        if dedans and debut is None:
            debut = i
        elif not dedans and debut is not None:
            if i - debut >= mini:
                out.append((debut, i))
            debut = None
    if debut is not None and len(profil) - debut >= mini:
        out.append((debut, len(profil)))
    return out


def pastilles(im):
    """Les quatre pastilles, de gauche à droite, détourées en disque.

    Même découpe que les pièces de bonus : diamètre lu sur la LARGEUR et haut
    sur le bord SUPÉRIEUR, les deux mesures que l'ombre portée ne fausse pas.
    """
    a = np.asarray(im.convert('RGB')).astype(np.float32)
    hors = np.linalg.norm(a - PAGE, axis=2) > 60
    lignes = plages(hors.mean(axis=1), 40)
    if len(lignes) != 1:
        raise SystemExit(f'{len(lignes)} rangées de pastilles au lieu d\'une')
    haut = lignes[0][0]
    for x0, x1 in plages(hors[lignes[0][0]:lignes[0][1]].mean(axis=0), 40):
        cote = int((x1 - x0) * 0.99)
        cx = (x0 + x1) // 2
        boite = (cx - cote // 2, haut + (x1 - x0 - cote) // 2)
        p = im.crop((boite[0], boite[1], boite[0] + cote, boite[1] + cote)).convert('RGBA')
        axe = (np.arange(cote) - (cote - 1) / 2) / ((cote - 1) / 2)
        d = np.hypot(*np.meshgrid(axe, axe, indexing='xy'))
        p.putalpha(Image.fromarray((np.clip((1.0 - d) * (cote / 2), 0, 1) * 255).astype(np.uint8), 'L'))
        yield p


def main():
    if not SRC.exists():
        print(f'absent : {SRC}', file=sys.stderr)
        return 1
    lot = list(pastilles(Image.open(SRC)))
    if len(lot) != len(FAMILLES):
        print(f'{len(lot)} pastilles au lieu de {len(FAMILLES)}', file=sys.stderr)
        return 1

    for pastille, (couleur, prefixe) in zip(lot, FAMILLES):
        source = CARTES / f'{prefixe}-{MODELE}.webp'
        if not source.exists():
            print(f'absent : {source}', file=sys.stderr)
            return 1
        brut = source.with_suffix('.tmp-src.png')
        subprocess.run(['dwebp', '-quiet', str(source), '-o', str(brut)], check=True)
        carte = Image.open(brut).convert('RGBA')
        brut.unlink()

        for x0, y0, x1, y1 in MEDAILLONS[f'{prefixe}-{MODELE}']:
            cote = int(round(max(x1 - x0, y1 - y0) * MARGE))
            cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
            p = pastille.resize((cote, cote), Image.LANCZOS)
            # `paste` et pas `alpha_composite` : le médaillon du bas touche le
            # bord de la carte sur trois familles, la pastille déborde donc.
            carte.paste(p, (cx - cote // 2, cy - cote // 2), p)

        dest = CARTES / f'{prefixe}-014.webp'
        tmp = dest.with_suffix('.tmp.png')
        carte.convert('RGB').save(tmp)
        subprocess.run(['cwebp', '-quiet', '-q', '86', str(tmp), '-o', str(dest)], check=True)
        tmp.unlink()
        print(f'  {dest.name:20} {couleur:7} sur {prefixe}-{MODELE}  {dest.stat().st_size / 1024:5.0f} Ko')
    return 0


if __name__ == '__main__':
    sys.exit(main())
