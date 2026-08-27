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
from scipy import ndimage

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'public/assets/skin/src'
OUT = RACINE / 'public/assets/cards'

# planche -> préfixe des quatorze fichiers de sortie.
PLANCHES = {
    'cartes-tresor-sk.png':    'tresor',
    'cartes-violettes-sk.png': 'carte',
    'cartes-atouts-sk.png':    'pavillon',
    'cartes-perroquets-sk.png': 'perroquet',
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
    # Le bois se relève dans les marges latérales, sous le titre : le bandeau
    # de titre n'a pas la même hauteur d'une planche à l'autre, et l'échantil-
    # lonner en aveugle sur une bande horizontale ramenait du blanc.
    marge = a.shape[0] // 5
    bois = np.median(np.concatenate([a[marge:, :8].reshape(-1, 3),
                                     a[marge:, -8:].reshape(-1, 3)]), axis=0)
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

    # Coins arrondis : le fond de planche qui s'y voit passe au blanc du
    # liseré. On ne blanchit que ce qui TOUCHE le bord de la découpe et tient
    # d'un seul tenant jusqu'à lui — les quatre coins, et rien d'autre.
    #
    # La ressemblance de couleur ne suffit pas : elle ne dit pas si le pixel
    # est dehors ou dedans. Sur un plan de bois ça passait (rien de brun ne
    # touche le liseré), la couronne extérieure suffisait à écarter le coffre
    # du centre. Sur le drap bleu de la planche d'extension, non — la Raie
    # Tachetée est une carte bleue, du même bleu que le drap, et la règle lui
    # mangeait des morceaux de cadre doré et de fond, jusqu'au milieu de ses
    # bords. Le liseré blanc, lui, fait le tour complet de chaque carte : par
    # construction, aucun pixel de l'illustration n'est relié au dehors.
    yy, xx = np.mgrid[0:h, 0:w]
    bord = (xx < w * BORD) | (xx > w * (1 - BORD)) | (yy < h * BORD) | (yy > h * (1 - BORD))
    proche = bord & (np.linalg.norm(c - bois, axis=2) < 70)
    lab, n = ndimage.label(proche)
    dehors = set(lab[0].tolist()) | set(lab[-1].tolist()) | set(lab[:, 0].tolist()) | set(lab[:, -1].tolist())
    dehors.discard(0)
    if dehors:
        c[np.isin(lab, list(dehors))] = 255
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
