#!/usr/bin/env python3
"""Détourage et conversion des assets peints.

Les PNG bruts vivent dans public/assets/skin/src/ et ne sont jamais modifiés.
Ce script en dérive les .webp que le CSS consomme, dans public/assets/skin/.

Détourage : les images générées sur fond magenta pur n'ont pas de canal alpha.
On le reconstruit à partir de la distance à la couleur de clé, avec un bord
progressif, puis on corrige la frange magenta (« despill ») — sans quoi les
lettres dorées gardent un liseré violet visible sur fond sombre.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'public/assets/skin/src'
OUT = RACINE / 'public/assets/skin'

# Seuils de distance à la couleur de clé, en unités RGB (0-255) :
# en deçà de PLEIN c'est du fond, au delà de SUJET c'est le sujet, entre les
# deux l'opacité monte progressivement — c'est ce qui lisse le contour.
FOND, SUJET = 60.0, 140.0


def couleur_de_cle(a):
    """La couleur dominante du pourtour : c'est le fond, par construction."""
    bord = np.concatenate([a[:4].reshape(-1, 3), a[-4:].reshape(-1, 3),
                           a[:, :4].reshape(-1, 3), a[:, -4:].reshape(-1, 3)])
    return np.median(bord, axis=0)


def detourer(im):
    a = np.asarray(im.convert('RGB'), dtype=np.float32)
    cle = couleur_de_cle(a)
    dist = np.linalg.norm(a - cle, axis=2)
    alpha = np.clip((dist - FOND) / (SUJET - FOND), 0, 1)

    # Despill : là où le rouge ET le bleu dépassent le vert, on est sur une
    # frange de magenta. On les ramène au niveau du vert.
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    exces = np.minimum(r, b) - g
    frange = exces > 0
    corr = np.where(frange, np.minimum(r, b) - g, 0)
    a[..., 0] -= np.where(frange & (r > g), corr, 0)
    a[..., 2] -= np.where(frange & (b > g), corr, 0)

    rgba = np.dstack([np.clip(a, 0, 255), alpha * 255]).astype(np.uint8)
    im = Image.fromarray(rgba, 'RGBA')
    boite = im.getbbox()
    return im.crop(boite) if boite else im


def en_webp(im, dest, qualite=88):
    tmp = dest.with_suffix('.tmp.png')
    im.save(tmp)
    cmd = ['cwebp', '-quiet', '-q', str(qualite), str(tmp), '-o', str(dest)]
    if im.mode == 'RGBA':
        cmd[2:2] = ['-alpha_q', '100']
    subprocess.run(cmd, check=True)
    tmp.unlink()
    return dest.stat().st_size


# nom de sortie -> (fichier source, faut-il détourer ?)
ASSETS = {
    'hero-taverne':      ('hero-sk.png', False),
    'plateau-taverne':   ('boardgame-sk.png', False),
    'logo-skullking-h':  ('logo-sk-horizontal.png', False),  # alpha déjà présent
    'logo-skullking-v':  ('logo-sk.png', True),              # sur magenta
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for nom, (source, cle) in ASSETS.items():
        chemin = SRC / source
        if not chemin.exists():
            print(f'   absent : {source}', file=sys.stderr)
            continue
        im = Image.open(chemin)
        if cle:
            im = detourer(im)
        elif im.mode == 'RGBA':
            boite = im.getbbox()
            if boite:
                im = im.crop(boite)
        poids = en_webp(im, OUT / f'{nom}.webp')
        print(f'  {nom + ".webp":26} {im.size[0]:>5}x{im.size[1]:<5} {im.mode:5} {poids / 1024:6.0f} Ko')


if __name__ == '__main__':
    main()
