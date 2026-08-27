#!/usr/bin/env python3
"""Découpe la planche des annonces en dix plaques, de 0 à 9.

Ce sont les faces des cartes qui se retournent quand toutes les annonces
tombent : un chiffre gravé dans une plaque de laiton sur cuir, crâne couronné
en haut, crâne casqué en bas. Le crâne du bas reçoit ensuite la pièce du
joueur, posée par-dessus côté CSS — c'est pour ça qu'on garde la plaque
entière plutôt que de la recadrer sur le chiffre.

Rien à voir avec les planches de cartes (`decouper-planche-speciales.py`) :
ici le fond n'est pas un plan de bois mais du noir franc, les cases ne sont
pas des cartes à liseré blanc, et surtout leurs tailles diffèrent — la plaque
du 0 porte un cadre plus large que les neuf autres. On repère donc chaque
plaque à sa propre étendue, puis on les ramène toutes au même format : à
l'écran elles s'alignent côte à côte, une plaque plus large que sa voisine se
verrait tout de suite. Le 0 y perd une dizaine de pour cent de largeur, ce qui
ne se voit pas.

    python3 briefs/decouper-planche-annonce.py
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SOURCE = RACINE / 'public/assets/skin/src/planche-annonce-sk.png'
OUT = RACINE / 'public/assets/skin'

# Le format de sortie, celui de la plaque courante. La largeur en découle par
# le ratio médian relevé sur les neuf plaques régulières (0,59), pas par un
# ratio de carte à jouer : ces plaques n'en sont pas.
HAUTEUR = 480
RATIO = 0.59

# Le noir du fond est franc ; le cadre sombre d'une plaque ne l'est pas tout à
# fait. Un seuil bas garde donc le cadre, qui fait partie du dessin.
SEUIL_FOND = 4


def segments(profil, mini):
    """Les plages où le profil sort du noir, celles plus courtes que `mini` ignorées."""
    plages, debut = [], None
    for i, dedans in enumerate(profil > SEUIL_FOND):
        if dedans and debut is None:
            debut = i
        elif not dedans and debut is not None:
            if i - debut >= mini:
                plages.append((debut, i))
            debut = None
    if debut is not None and len(profil) - debut >= mini:
        plages.append((debut, len(profil)))
    return plages


def plaques(a):
    """Les dix plaques, rangée par rangée, de gauche à droite."""
    lum = a.mean(axis=2)
    for y0, y1 in segments(lum.mean(axis=1), 100):
        bande = lum[y0:y1]
        for x0, x1 in segments(bande.mean(axis=0), 60):
            # Chaque plaque est recadrée sur SA hauteur : la bande vaut pour
            # la rangée entière, et la plus haute des cinq y déborde les autres.
            colonne = bande[:, x0:x1].mean(axis=1)
            hauts = segments(colonne, 100)
            dy0, dy1 = (hauts[0] if hauts else (0, y1 - y0))
            yield x0, y0 + dy0, x1, y0 + dy1


def main():
    if not SOURCE.exists():
        print(f'absent : {SOURCE}', file=sys.stderr)
        return 1
    im = Image.open(SOURCE).convert('RGB')
    boites = list(plaques(np.asarray(im).astype(np.float32)))
    if len(boites) != 10:
        print(f'{len(boites)} plaques repérées au lieu de 10', file=sys.stderr)
        return 1

    taille = (int(round(HAUTEUR * RATIO)), HAUTEUR)
    for chiffre, (x0, y0, x1, y1) in enumerate(boites):
        plaque = im.crop((x0, y0, x1, y1)).resize(taille, Image.LANCZOS)
        dest = OUT / f'annonce-{chiffre}.webp'
        tmp = dest.with_suffix('.tmp.png')
        plaque.save(tmp)
        subprocess.run(['cwebp', '-quiet', '-q', '88', str(tmp), '-o', str(dest)], check=True)
        tmp.unlink()
        print(f'  {dest.name:16} {x1 - x0:3d}x{y1 - y0:3d} -> {taille[0]}x{taille[1]}'
              f' {dest.stat().st_size / 1024:5.0f} Ko')
    return 0


if __name__ == '__main__':
    sys.exit(main())
