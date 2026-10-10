"""Les pièces jaunes du 0/14, repeintes chiffre noir.

Peintes à l'origine chiffre d'or sur fond ocre, les pièces jaunes ne se
lisaient pas — à la taille d'un médaillon d'angle moins encore. Elles ont été
repeintes à part, chiffre noir, et remplacent les jaunes des planches
d'origine :

- pastilles-0-14-jaune-sk.png : trois pièces sur une rangée, 0, 14 et 0/14
  (seules les deux premières servent : pastilles frappées à la pose) ;
- 0-14-jaune-sk.png : une pièce 0/14 seule (médaillons d'angle de la carte).

Ces images arrivent sur un damier PEINT, sans transparence, que l'écart au
blanc des autres planches ne sépare pas des pièces (ses cases sombres passent
le seuil). On repère donc les pièces par la saturation : le damier est gris,
la pièce est or jusqu'à son liseré brun. Même découpe ronde que partout
ailleurs : diamètre lu sur la largeur, haut sur le bord supérieur — les deux
mesures que l'ombre portée ne fausse pas.

Partagé par composer-cartes-0-14.py et decouper-pastilles-declaration.py.
"""
from pathlib import Path

import numpy as np
from PIL import Image

SRC = Path(__file__).resolve().parent.parent / 'public/assets/skin/src'
PASTILLES = SRC / 'pastilles-0-14-jaune-sk.png'
MEDAILLON = SRC / '0-14-jaune-sk.png'


def _plages(profil, mini=40):
    out, debut = [], None
    for i, dedans in enumerate(profil > 0.05):
        if dedans and debut is None:
            debut = i
        elif not dedans and debut is not None:
            if i - debut >= mini:
                out.append((debut, i))
            debut = None
    if debut is not None and len(profil) - debut >= mini:
        out.append((debut, len(profil)))
    return out


def detourer(chemin):
    """Les pièces de l'image, de gauche à droite, en RGBA carrées détourées."""
    im = Image.open(chemin).convert('RGB')
    piece = np.asarray(im.convert('HSV'))[..., 1] > 70
    out = []
    for x0, x1 in _plages(piece.mean(axis=0)):
        (y0, _), = _plages(piece[:, x0:x1].mean(axis=1))
        cote = int((x1 - x0) * 0.99)
        cx = (x0 + x1) // 2
        gx, gy = cx - cote // 2, y0 + (x1 - x0 - cote) // 2
        p = im.crop((gx, gy, gx + cote, gy + cote)).convert('RGBA')
        axe = (np.arange(cote) - (cote - 1) / 2) / ((cote - 1) / 2)
        d = np.hypot(*np.meshgrid(axe, axe, indexing='xy'))
        p.putalpha(Image.fromarray((np.clip((1.0 - d) * (cote / 2), 0, 1) * 255).astype(np.uint8), 'L'))
        out.append(p)
    return out
