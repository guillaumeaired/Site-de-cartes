#!/usr/bin/env python3
"""Découpe les deux pièces de bonus des 14 : +10 et +20.

Elles se posent contre le médaillon d'angle des cartes de valeur 14, qui
rapportent 10 points à qui remporte le pli — 20 pour le noir. Le bonus était
une règle qu'il fallait connaître ; il est maintenant sur la carte.

Rien à voir avec les planches de cartes : deux sujets ronds sur page blanche,
et une découpe RONDE plutôt qu'un détourage. La page est blanche, le liseré
extérieur des pièces est clair, et une seuil sur la couleur laisserait un
feston blanc tout autour. Le cercle, lui, épouse exactement ce qui est peint —
ce sont des pièces, elles sont rondes.

    python3 briefs/decouper-pieces-bonus.py
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SOURCE = RACINE / 'public/assets/skin/src/bonus-14-sk.png'
OUT = RACINE / 'public/assets/skin'

NOMS = ['bonus-10', 'bonus-20']
COTE = 256          # la pièce ne dépasse jamais 16 % de la largeur d'une carte
PAGE = np.array([255.0, 255.0, 255.0])
SEUIL = 60          # l'ombre portée reste sous ce seuil, la pièce le dépasse


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


def pieces(a):
    """Les deux pièces, de gauche à droite, en boîtes carrées collées au disque.

    Le diamètre se lit sur la LARGEUR et le haut sur le bord SUPÉRIEUR : ce
    sont les deux mesures que l'ombre portée ne fausse pas, elle tombe vers le
    bas. Prendre la boîte entière donnait un carré de 398 px pour un disque de
    380, et le masque rond laissait donc une couronne de page blanche autour
    de la pièce — bien visible sur le feutre vert.
    """
    hors = np.linalg.norm(a - PAGE, axis=2) > SEUIL
    lignes = plages(hors.mean(axis=1), 50)
    if len(lignes) != 1:
        raise SystemExit(f'{len(lignes)} rangées trouvées au lieu d\'une')
    haut = lignes[0][0]
    for x0, x1 in plages(hors[lignes[0][0]:lignes[0][1]].mean(axis=0), 50):
        # Un pour cent de moins, pour finir SUR le laiton plutôt qu'au ras :
        # un demi-pixel de page au bord d'un disque se lit comme un cerne.
        cote = int((x1 - x0) * 0.99)
        cx = (x0 + x1) // 2
        yield cx - cote // 2, haut + (x1 - x0 - cote) // 2, cote


def masque_rond(cote):
    """Un disque plein, adouci sur le dernier pixel du bord."""
    axe = (np.arange(cote) - (cote - 1) / 2) / ((cote - 1) / 2)
    d = np.hypot(*np.meshgrid(axe, axe, indexing='xy'))
    return Image.fromarray((np.clip((1.0 - d) * (cote / 2), 0, 1) * 255).astype(np.uint8), 'L')


def main():
    if not SOURCE.exists():
        print(f'absent : {SOURCE}', file=sys.stderr)
        return 1
    im = Image.open(SOURCE).convert('RGB')
    boites = list(pieces(np.asarray(im).astype(np.float32)))
    if len(boites) != len(NOMS):
        print(f'{len(boites)} pièces repérées au lieu de {len(NOMS)}', file=sys.stderr)
        return 1

    for nom, (x, y, cote) in zip(NOMS, boites):
        piece = im.crop((x, y, x + cote, y + cote)).convert('RGBA')
        piece.putalpha(masque_rond(cote))
        piece = piece.resize((COTE, COTE), Image.LANCZOS)
        dest = OUT / f'{nom}.webp'
        tmp = dest.with_suffix('.tmp.png')
        piece.save(tmp)
        # -alpha_q 100 : le bord du disque est le seul dessin de l'image, une
        # alpha approximée s'y verrait comme une dentelure.
        subprocess.run(['cwebp', '-quiet', '-q', '90', '-alpha_q', '100', str(tmp), '-o', str(dest)], check=True)
        tmp.unlink()
        print(f'  {dest.name:16} {cote}px -> {COTE}px  {dest.stat().st_size / 1024:5.1f} Ko')
    return 0


if __name__ == '__main__':
    sys.exit(main())
