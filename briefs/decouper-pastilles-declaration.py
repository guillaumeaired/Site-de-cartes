#!/usr/bin/env python3
"""Découpe les huit pastilles de déclaration du 0/14 : 0 et 14, par famille.

Le 0/14 se déclare au moment de la pose. La pastille retenue est ensuite
frappée sur la carte, comme l'emblème de la Tigresse : sans elle, un 0/14 posé
à 14 et un posé à 0 sont le même dessin sur le tapis, alors que l'un remporte
le pli et que l'autre le donne. C'est aussi elle qu'on choisit dans le cadre,
plutôt que deux boutons de texte.

Deux rangées de quatre sur page blanche : les 0 en haut, les 14 en bas, dans
l'ordre des familles. Même découpe RONDE que les pièces de bonus — diamètre lu
sur la largeur, haut sur le bord supérieur, les deux mesures que l'ombre
portée ne fausse pas.

    python3 briefs/decouper-pastilles-declaration.py
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SOURCE = RACINE / 'public/assets/skin/src/pastilles-0-14-sk.png'
OUT = RACINE / 'public/assets/skin'

FAMILLES = ['jaune', 'vert', 'violet', 'noir']
VALEURS = [0, 14]           # l'ordre des rangées
COTE = 256
PAGE = np.array([255.0, 255.0, 255.0])
SEUIL = 60


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


def masque_rond(cote):
    axe = (np.arange(cote) - (cote - 1) / 2) / ((cote - 1) / 2)
    d = np.hypot(*np.meshgrid(axe, axe, indexing='xy'))
    return Image.fromarray((np.clip((1.0 - d) * (cote / 2), 0, 1) * 255).astype(np.uint8), 'L')


def main():
    if not SOURCE.exists():
        print(f'absent : {SOURCE}', file=sys.stderr)
        return 1
    im = Image.open(SOURCE).convert('RGB')
    a = np.asarray(im).astype(np.float32)
    hors = np.linalg.norm(a - PAGE, axis=2) > SEUIL
    rangees = plages(hors.mean(axis=1), 40)
    if len(rangees) != len(VALEURS):
        print(f'{len(rangees)} rangées au lieu de {len(VALEURS)}', file=sys.stderr)
        return 1

    for valeur, (y0, y1) in zip(VALEURS, rangees):
        colonnes = plages(hors[y0:y1].mean(axis=0), 40)
        if len(colonnes) != len(FAMILLES):
            print(f'rangée {valeur} : {len(colonnes)} pastilles au lieu de {len(FAMILLES)}', file=sys.stderr)
            return 1
        for famille, (x0, x1) in zip(FAMILLES, colonnes):
            cote = int((x1 - x0) * 0.99)
            cx = (x0 + x1) // 2
            gx, gy = cx - cote // 2, y0 + (x1 - x0 - cote) // 2
            p = im.crop((gx, gy, gx + cote, gy + cote)).convert('RGBA')
            p.putalpha(masque_rond(cote))
            p = p.resize((COTE, COTE), Image.LANCZOS)
            dest = OUT / f'pastille-{valeur}-{famille}.webp'
            tmp = dest.with_suffix('.tmp.png')
            p.save(tmp)
            subprocess.run(['cwebp', '-quiet', '-q', '90', '-alpha_q', '100', str(tmp), '-o', str(dest)], check=True)
            tmp.unlink()
            print(f'  {dest.name:26} {cote}px  {dest.stat().st_size / 1024:5.1f} Ko')
    return 0


if __name__ == '__main__':
    sys.exit(main())
