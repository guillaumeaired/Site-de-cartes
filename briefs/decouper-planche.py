#!/usr/bin/env python3
"""Découpe d'une planche groupée en sprites individuels.

Les petits objets sont générés ensemble — c'est ce qui leur donne la même
lumière. Il faut ensuite les séparer. On ne suppose PAS une grille régulière :
on isole les taches opaques, on les trie en lignes puis en colonnes, et on
recadre chacune sur son propre contenu. Un objet légèrement décalé dans la
planche sort donc quand même centré dans son fichier.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'public/assets/skin/src'
OUT = RACINE / 'public/assets/skin'

sys.path.insert(0, str(RACINE / 'briefs'))
import importlib.util
_s = importlib.util.spec_from_file_location('t', RACINE / 'briefs/traiter-assets.py')
_t = importlib.util.module_from_spec(_s)
_s.loader.exec_module(_t)


def ouvrir(source):
    """Rend une RGBA détourée : soit l'alpha était là, soit le fond est chroma."""
    im = Image.open(SRC / source)
    if im.mode == 'RGBA' and (np.asarray(im)[..., 3] < 250).mean() > 0.05:
        return im
    return _t.detourer(im)


def taches(im, seuil_surface=0.004):
    """Les composantes opaques, triées en lecture (haut->bas, gauche->droite)."""
    op = np.asarray(im)[..., 3] > 60
    op = ndimage.binary_closing(op, np.ones((9, 9)))
    lab, n = ndimage.label(op)
    if not n:
        return []
    surfaces = ndimage.sum(op, lab, range(1, n + 1))
    mini = seuil_surface * op.size
    gardes = [i + 1 for i, s in enumerate(surfaces) if s >= mini]
    boites = []
    for i in gardes:
        ys, xs = np.nonzero(lab == i)
        boites.append((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    # tri en lignes : deux objets sont sur la même ligne si leurs centres
    # verticaux sont proches d'une demi-hauteur d'objet
    h_moy = np.mean([b[3] - b[1] for b in boites])
    boites.sort(key=lambda b: ((b[1] + b[3]) / 2 // (h_moy * 0.8), b[0]))
    return boites


def decouper(source, noms, marge=10):
    im = ouvrir(source)
    boites = taches(im)
    if len(boites) != len(noms):
        print(f'  ATTENTION {source} : {len(boites)} objets trouvés pour '
              f'{len(noms)} noms attendus', file=sys.stderr)
    for nom, (x0, y0, x1, y1) in zip(noms, boites):
        bout = im.crop((max(x0 - marge, 0), max(y0 - marge, 0),
                        min(x1 + marge, im.width), min(y1 + marge, im.height)))
        poids = _t.en_webp(bout, OUT / f'{nom}.webp')
        print(f'  {nom + ".webp":22} {bout.size[0]:4}x{bout.size[1]:<4} {poids / 1024:5.0f} Ko')


if __name__ == '__main__':
    decouper('cire-clous-sk.png',
             ['sceau-ancre', 'sceau-crane', 'clou-laiton', 'clou-fer'])
    decouper('skull-coins-sk.png',
             ['doublon-tenu', 'doublon-rate', 'doublon-vierge', 'doublon-courant'])
