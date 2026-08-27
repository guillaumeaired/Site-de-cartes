#!/usr/bin/env python3
"""Découpe une planche de famille numérotée en quatorze cartes au format du jeu.

Les cartes numérotées arrivent en planche : deux rangées de sept, posées sur
un plan de travail en bois, sous un titre. La planche garantit qu'elles ont
toutes la même lumière ; il faut ensuite les séparer.

Deux ajustements après la découpe, sans lesquels la carte ne se pose pas dans
le jeu :

- Les coins. Ils sont arrondis dans la planche, et c'est le bois qui s'y voit.
  On les repeint du blanc du liseré ; l'arrondi, c'est `border-radius` qui le
  refait à l'écran, à SON rayon.
- Le format. La planche donne des cartes en 0,62 de large pour 1 de haut, le
  jeu les affiche en 0,7 (`--sk-w / 0.7`). Elles sont donc étirées jusqu'au
  format du jeu. On avait d'abord élargi le liseré blanc à la place : ça ne
  déformait rien, mais le bord épaissi donnait l'impression d'une carte posée
  sur une autre. Un étirement de 12 % ne se voit pas ; un liseré double, si.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'public/assets/skin/src'
OUT = RACINE / 'public/assets/cards'

# planche -> préfixe des quatorze fichiers de sortie. Le vert n'a pas encore
# sa planche : sa famille reste dessinée en CSS (voir cardClass).
PLANCHES = {
    'cartes-tresor-sk.png':    'tresor',
    'cartes-violettes-sk.png': 'carte',
    'cartes-atouts-sk.png':    'pavillon',
}

RATIO = 0.7      # celui de .sk-card, height: calc(var(--sk-w) / 0.7)
HAUTEUR = 620    # l'échelle des illustrations déjà en place
BORD = 0.09      # part du bord où le bois peut encore se voir (coins arrondis)


def segments(v, seuil, mini):
    """Les plages contiguës où v dépasse le seuil."""
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


def grille(a):
    """Les quatorze rectangles, repérés par ce qui n'est PAS le plan de bois."""
    bois = np.median(a[140:175].reshape(-1, 3), axis=0)
    hors = np.linalg.norm(a - bois, axis=2) > 60
    lignes = segments(hors[:, 20:-20].mean(axis=1), 0.30, 100)
    lignes = [(y0, y1) for y0, y1 in lignes if y1 - y0 > 200]   # écarte le titre
    for y0, y1 in lignes:
        for x0, x1 in segments(hors[y0:y1].mean(axis=0), 0.30, 60):
            yield x0, y0, x1, y1, bois


def rogner_ombre(c, seuil=170):
    """Ote les rangs d'ombre portee restes colles au lisere.

    Le reperage par le bois s'arrete a la limite du bois, pas a celle de la
    carte : sous chaque carte la planche porte une ombre, qui n'est plus du
    bois et se retrouve donc dans la decoupe -- un trait gris le long du bord.
    On enleve les rangs exterieurs tant qu'ils sont sombres ; le lisere blanc
    les arrete aussitot.
    """
    h0, h1, w0, w1 = 0, c.shape[0], 0, c.shape[1]
    for _ in range(24):
        bouge = False
        for cote in ('haut', 'bas', 'gauche', 'droite'):
            rang = {'haut': c[h0, w0:w1], 'bas': c[h1 - 1, w0:w1],
                    'gauche': c[h0:h1, w0], 'droite': c[h0:h1, w1 - 1]}[cote]
            if np.median(rang.max(axis=1)) < seuil:
                if cote == 'haut':
                    h0 += 1
                elif cote == 'bas':
                    h1 -= 1
                elif cote == 'gauche':
                    w0 += 1
                else:
                    w1 -= 1
                bouge = True
        if not bouge:
            break
    return c[h0:h1, w0:w1]


def carte(a, x0, y0, x1, y1, bois):
    c = rogner_ombre(a[y0:y1, x0:x1].copy())
    h, w = c.shape[:2]

    # Coins arrondis : le bois qui s'y voit passe au blanc du liseré. On ne
    # regarde que la couronne extérieure — le coffre au centre est lui aussi
    # un brun de bois, il ne doit pas y passer.
    yy, xx = np.mgrid[0:h, 0:w]
    bord = (xx < w * BORD) | (xx > w * (1 - BORD)) | (yy < h * BORD) | (yy > h * (1 - BORD))
    c[bord & (np.linalg.norm(c - bois, axis=2) < 70)] = 255
    return Image.fromarray(c.astype(np.uint8), 'RGB')


def decouper(source, prefixe):
    chemin = SRC / source
    if not chemin.exists():
        print(f'   absent : {source}', file=sys.stderr)
        return 1
    a = np.asarray(Image.open(chemin).convert('RGB')).astype(np.float32)

    boites = list(grille(a))
    if len(boites) != 14:
        print(f'   {source} : {len(boites)} cartes repérées au lieu de 14', file=sys.stderr)
        return 1

    poids = 0
    for i, boite in enumerate(boites, start=1):
        im = carte(a, *boite)
        im = im.resize((int(round(HAUTEUR * RATIO)), HAUTEUR), Image.LANCZOS)
        dest = OUT / f'{prefixe}-{i}.webp'
        tmp = dest.with_suffix('.tmp.png')
        im.save(tmp)
        subprocess.run(['cwebp', '-quiet', '-q', '86', str(tmp), '-o', str(dest)], check=True)
        tmp.unlink()
        poids += dest.stat().st_size
    print(f'  {prefixe + "-1..14.webp":24} {im.size[0]}x{im.size[1]} {poids / 1024:5.0f} Ko')
    return 0


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cibles = sys.argv[1:] or list(PLANCHES)
    ecarts = 0
    for source in cibles:
        ecarts += decouper(source, PLANCHES[source])
    return 1 if ecarts else 0


if __name__ == '__main__':
    sys.exit(main())
