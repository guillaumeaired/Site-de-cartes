#!/usr/bin/env python3
"""Découpe les pièces de joueur ajoutées après les neuf d'origine.

`pieces-nouvelles-sk.png` : cinq médaillons de laiton sur une planche
détourée (vrai canal alpha), trois en haut, deux en bas — pieuvre,
perroquet, ivrogne, puis poison et canon. Le perroquet n'est pas repris :
il n'est pas proposé au choix de pièce.

Découpe RONDE comme pour les pièces de bonus (voir decouper-pieces-bonus.py) :
le diamètre se lit sur la largeur, le centre au milieu de la boîte, un pour
cent de moins pour finir sur le métal plutôt qu'au ras. Puis mise à
l'échelle de la famille (398 px, voir importer-medaillon.py).

    python3 briefs/decouper-pieces-nouvelles.py
    python3 briefs/couleur-cerclage.py --ecrire

La seconde ligne n'est pas facultative : la couleur du joueur se relève sur
le cerclage, elle ne se choisit pas.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'public/assets/skin/src'
SKIN = RACINE / 'public/assets/skin'

PLANCHE = SRC / 'pieces-nouvelles-sk.png'
# Dans l'ordre de lecture de la planche ; None = médaillon laissé de côté.
NOMS = ['pieuvre', None, 'ivrogne', 'poison', 'canon']
LARGEUR = 398


def boite_ronde(m):
    """Le carré du disque dans un masque : diamètre lu sur la largeur."""
    ys, xs = np.nonzero(m)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    cote = int((x1 - x0) * 0.99)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    return cx - cote // 2, cy - cote // 2, cote


def masque_rond(cote):
    """Un disque plein, adouci sur le dernier pixel du bord."""
    axe = (np.arange(cote) - (cote - 1) / 2) / ((cote - 1) / 2)
    d = np.hypot(*np.meshgrid(axe, axe, indexing='xy'))
    return Image.fromarray((np.clip((1.0 - d) * (cote / 2), 0, 1) * 255).astype(np.uint8), 'L')


def ecrire(im, boite, cle):
    x, y, cote = boite
    piece = im.convert('RGB').crop((x, y, x + cote, y + cote)).convert('RGBA')
    piece.putalpha(masque_rond(cote))
    piece = piece.resize((LARGEUR, LARGEUR), Image.LANCZOS)
    dest = SKIN / f'piece-{cle}.webp'
    tmp = dest.with_suffix('.tmp.png')
    piece.save(tmp)
    subprocess.run(['cwebp', '-quiet', '-q', '90', '-alpha_q', '100',
                    str(tmp), '-o', str(dest)], check=True)
    tmp.unlink()
    print(f'  {dest.name:24} {cote}px -> {LARGEUR}px  {dest.stat().st_size / 1024:.0f} Ko')


def planche():
    im = Image.open(PLANCHE)
    alpha = np.asarray(im.convert('RGBA'))[..., 3] > 128
    lab, n = ndimage.label(alpha)
    tailles = ndimage.sum(alpha, lab, range(1, n + 1))
    taches = [i + 1 for i in range(n) if tailles[i] > alpha.size * 0.02]
    if len(taches) != len(NOMS):
        raise SystemExit(f'{PLANCHE.name} : {len(taches)} médaillons au lieu de {len(NOMS)}')
    # Ordre de lecture : par rangée (le haut à 40 px près), puis de gauche à droite.
    centres = ndimage.center_of_mass(alpha, lab, taches)
    ordre = sorted(zip(taches, centres), key=lambda t: (round(t[1][0] / 40), t[1][1]))
    for cle, (tache, _) in zip(NOMS, ordre):
        if cle:
            ecrire(im, boite_ronde(lab == tache), cle)


def main():
    if not PLANCHE.exists():
        print(f'absent : {PLANCHE}', file=sys.stderr)
        return 1
    planche()
    return 0


if __name__ == '__main__':
    sys.exit(main())
