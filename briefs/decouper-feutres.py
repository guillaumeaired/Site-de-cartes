#!/usr/bin/env python3
"""Découpe la planche des feutres en neuf tapis, un par pièce de joueur.

Chaque joueur a sa pièce (voir PIECES dans public/skullking.js) ; chaque
pièce a maintenant son feutre, du même émail et frappé de la même figure —
un crâne pour le Crâne, une ancre pour l'Ancre, et ainsi de suite. Ils
peignent les secteurs de la roue de tirage à la place des aplats de couleur.

La planche est une grille de 3x3 lue dans l'ordre de PIECES : c'est ce qui
apparie un feutre à une pièce, il n'y a pas d'autre lien. Changer l'ordre des
pièces sans changer la planche donnerait à chacun le tapis de son voisin.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'public/assets/skin/src/tapis-feutre-sk.png'
OUT = RACINE / 'public/assets/skin'

CLES = ['crane', 'ancre', 'voilier', 'sabre', 'boussole', 'coffre',
        'barre', 'bouteille', 'crochet']
LARGEUR = 400


def segments(v, seuil, mini):
    b, out, s = v > seuil, [], None
    for i, x in enumerate(b):
        if x and s is None:
            s = i
        if not x and s is not None:
            out.append((s, i))
            s = None
    if s is not None:
        out.append((s, len(b)))
    return [(x, y) for x, y in out if y - x > mini]


def main():
    if not SRC.exists():
        print(f'introuvable : {SRC}', file=sys.stderr)
        return 1
    a = np.asarray(Image.open(SRC).convert('RGB')).astype(np.float32)
    # Le fond de la planche se relève dans les marges : les tapis sont tout
    # ce qui n'en est pas.
    fond = np.median(np.concatenate([a[:, :6].reshape(-1, 3),
                                     a[:, -6:].reshape(-1, 3)]), axis=0)
    hors = np.linalg.norm(a - fond, axis=2) > 40
    lignes = segments(hors.mean(axis=1), 0.5, 50)
    colonnes = segments(hors.mean(axis=0), 0.5, 50)
    if (len(lignes), len(colonnes)) != (3, 3):
        print(f'grille {len(lignes)}x{len(colonnes)} au lieu de 3x3', file=sys.stderr)
        return 1

    poids = 0
    for i, cle in enumerate(CLES):
        y0, y1 = lignes[i // 3]
        x0, x1 = colonnes[i % 3]
        # Deux pixels de retrait : le bord d'un tapis porte encore un peu de
        # l'ombre qu'il projette sur la planche, et cette frange sombre se
        # verrait le long des rayons du camembert.
        im = Image.fromarray(a[y0 + 2:y1 - 2, x0 + 2:x1 - 2].astype(np.uint8), 'RGB')
        im = im.resize((LARGEUR, round(im.size[1] * LARGEUR / im.size[0])), Image.LANCZOS)
        dest = OUT / f'feutre-{cle}.webp'
        tmp = dest.with_suffix('.tmp.png')
        im.save(tmp)
        subprocess.run(['cwebp', '-quiet', '-q', '86', str(tmp), '-o', str(dest)], check=True)
        tmp.unlink()
        poids += dest.stat().st_size
    print(f'  feutre-*.webp (9)  {im.size[0]}x{im.size[1]}  {poids / 1024:.0f} Ko')
    return 0


if __name__ == '__main__':
    sys.exit(main())
