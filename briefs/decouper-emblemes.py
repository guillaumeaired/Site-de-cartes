#!/usr/bin/env python3
"""Découpe la planche des deux emblèmes de la Tigresse.

`fuite-pirate-sk.png` arrive en une seule image, déjà détourée : le pavillon
blanc sur émail bleu (la Fuite) à gauche, les sabres croisés sur émail rouge
(le Pirate) à droite, séparés par une colonne de pixels transparents.

On ne code pas la coupure en dur : on relève les colonnes entièrement vides,
on garde le plus large intervalle du milieu et on coupe en son centre. Chaque
moitié est ensuite recadrée sur sa propre boîte englobante, puis ramenée à la
même hauteur — les deux disques doivent peser pareil dans le cadre de choix,
et les rubans rouges du Pirate débordent plus bas que le drap de la Fuite.

Usage :
    python3 briefs/decouper-emblemes.py
"""
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'public/assets/skin/src/fuite-pirate-sk.png'
OUT = RACINE / 'public/assets/skin'

NOMS = ('embleme-fuite', 'embleme-pirate')   # de gauche à droite
HAUTEUR = 512   # assez pour le cadre de choix en grand écran, ×2 pour la rétine


def coupure(alpha):
    """Le milieu du plus large couloir de colonnes vides, hors marges."""
    plein = (alpha > 8).any(axis=0)
    vides = np.where(~plein)[0]
    couloirs, debut = [], vides[0]
    for a, b in zip(vides, vides[1:]):
        if b != a + 1:
            couloirs.append((debut, a))
            debut = b
    couloirs.append((debut, vides[-1]))
    # On écarte les deux marges : elles touchent un bord de l'image.
    milieu = [c for c in couloirs if c[0] > 0 and c[1] < len(plein) - 1]
    if not milieu:
        raise SystemExit('aucune séparation trouvée entre les deux emblèmes')
    a, b = max(milieu, key=lambda c: c[1] - c[0])
    return (a + b) // 2


def en_webp(im, dest, qualite=90):
    tmp = dest.with_suffix('.tmp.png')
    im.save(tmp)
    subprocess.run(['cwebp', '-quiet', '-q', str(qualite), '-alpha_q', '100',
                    str(tmp), '-o', str(dest)], check=True)
    tmp.unlink()
    return dest.stat().st_size


def main():
    planche = Image.open(SRC).convert('RGBA')
    x = coupure(np.asarray(planche)[..., 3])
    moities = [planche.crop((0, 0, x, planche.height)),
               planche.crop((x, 0, planche.width, planche.height))]
    for nom, im in zip(NOMS, moities):
        boite = im.getbbox()
        if boite:
            im = im.crop(boite)
        im = im.resize((round(im.width * HAUTEUR / im.height), HAUTEUR), Image.LANCZOS)
        poids = en_webp(im, OUT / f'{nom}.webp')
        print(f'  {nom + ".webp":22} {im.width}x{im.height} {poids / 1024:5.0f} Ko')


if __name__ == '__main__':
    main()
