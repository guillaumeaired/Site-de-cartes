#!/usr/bin/env python3
"""Entre un médaillon peint dans la famille des pièces de joueur.

Les médaillons arrivent en PNG plein cadre, posés sur un fond noir sans canal
alpha. Les huit autres pièces sont des RGBA détourées d'environ 398 px, la
figure occupant tout le cadre. Ce script fait passer un nouveau venu par les
mêmes fourches caudines, sans quoi il arriverait avec son carré noir autour
et à une échelle qui n'est pas celle de ses voisins.

Le détourage de traiter-assets.py ne convient pas ici : il construit l'alpha
à partir de la DISTANCE à la couleur de fond, et l'émail vert sombre d'une
pièce est plus près du noir que du laiton — il ressortirait à moitié
transparent. On passe donc par la forme : un seuil bas isole le pourtour du
disque, on rebouche l'intérieur, on ne garde que la plus grosse tache, et on
adoucit le bord d'un pixel pour qu'il ne crénèle pas.

Usage :
    python3 briefs/importer-medaillon.py bouteille ~/Documents/piece-bouteille.png

Puis relancer briefs/couleur-cerclage.py --ecrire : la couleur du joueur se
relève sur l'image, elle ne se choisit pas.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

RACINE = Path(__file__).resolve().parent.parent
SKIN = RACINE / 'public/assets/skin'

SEUIL = 24      # au-dessus de ce niveau on n'est plus sur le fond noir
LARGEUR = 398   # l'échelle de la famille, mesurée sur les huit autres


def masque(a):
    """La silhouette du médaillon : pourtour, intérieur rebouché, tache unique."""
    m = a.max(axis=2) > SEUIL
    m = ndimage.binary_closing(m, np.ones((9, 9)))
    m = ndimage.binary_fill_holes(m)
    lab, n = ndimage.label(m)
    if n > 1:
        tailles = ndimage.sum(m, lab, range(1, n + 1))
        m = lab == (1 + int(np.argmax(tailles)))
    return m


def detourer(im):
    a = np.asarray(im.convert('RGB')).astype(np.float32)
    m = masque(a)
    # Un pixel d'érosion avant l'adoucissement : le tout dernier rang du
    # contour a déjà mangé du noir, le garder poserait un liseré sombre sur
    # le bois clair.
    doux = ndimage.gaussian_filter(ndimage.binary_erosion(m).astype(np.float32), 0.8)
    rgba = np.dstack([a, np.clip(doux, 0, 1) * 255]).astype(np.uint8)
    im = Image.fromarray(rgba, 'RGBA')
    boite = im.getbbox()
    return im.crop(boite) if boite else im


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[-4], file=sys.stderr)
        return 2
    cle, source = sys.argv[1], Path(sys.argv[2]).expanduser()
    if not source.exists():
        print(f'introuvable : {source}', file=sys.stderr)
        return 1

    im = detourer(Image.open(source))
    h = round(im.size[1] * LARGEUR / im.size[0])
    im = im.resize((LARGEUR, h), Image.LANCZOS)

    dest = SKIN / f'piece-{cle}.webp'
    tmp = dest.with_suffix('.tmp.png')
    im.save(tmp)
    subprocess.run(['cwebp', '-quiet', '-q', '90', '-alpha_q', '100',
                    str(tmp), '-o', str(dest)], check=True)
    tmp.unlink()
    print(f'  {dest.name:24} {im.size[0]}x{im.size[1]} {dest.stat().st_size / 1024:.0f} Ko')
    return 0


if __name__ == '__main__':
    sys.exit(main())
