#!/usr/bin/env python3
"""Relève la couleur du cerclage émaillé de chaque médaillon de joueur.

Cette couleur n'est pas décorative : c'est l'identité visuelle d'un joueur.
Elle peint son secteur dans la roue de tirage, sa ligne dans la courbe de fin
de partie et sa pastille de légende. Elle DOIT donc être celle qu'on voit sur
le médaillon, sinon un joueur porte deux couleurs différentes selon l'écran.

D'où ce script plutôt que des valeurs choisies à l'œil : on échantillonne le
.webp lui-même. Le médaillon est un disque ; le cerclage est la couronne
juste à l'intérieur du bord, soit r = 0.78..0.94 du rayon. On en prend la
MÉDIANE et pas la moyenne : les clous de laiton et les reflets spéculaires
tireraient une moyenne vers l'or, la médiane les ignore tant qu'ils occupent
moins de la moitié de la couronne (c'est le cas partout).

Exception : la Bouteille porte un cerclage d'acier, donc gris. Sur celui-là
la médiane brute attrape les clous dorés et sort un brun qui n'existe nulle
part sur l'image. On y filtre donc les pixels saturés avant de mesurer.

Usage :
    python3 briefs/couleur-cerclage.py          # relève et compare au JS
    python3 briefs/couleur-cerclage.py --ecrire # réécrit les valeurs dans le JS
"""
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SKIN = RACINE / 'public/assets/skin'
JS = RACINE / 'public/skullking.js'

# Les cerclages gris : la médiane brute y attrape le laiton des clous.
ACIER = {'bouteille'}


def couronne(im, r0=0.78, r1=0.94):
    """Les pixels opaques de l'anneau, en RGB."""
    a = np.asarray(im).astype(np.float32)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.sqrt((yy - (h - 1) / 2) ** 2 + (xx - (w - 1) / 2) ** 2) / (min(h, w) / 2)
    return a[(d >= r0) & (d <= r1) & (a[..., 3] > 200)][:, :3]


def cerclage(chemin):
    px = couronne(Image.open(chemin).convert('RGBA'))
    if chemin.stem[len('piece-'):] in ACIER:
        mx, mn = px.max(1), px.min(1)
        sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
        px = px[sat < 0.25]
    return '#%02x%02x%02x' % tuple(np.median(px, axis=0).astype(int))


def main():
    releve = {f.stem[len('piece-'):]: cerclage(f) for f in sorted(SKIN.glob('piece-*.webp'))}
    js = JS.read_text()
    ecrire = '--ecrire' in sys.argv
    ecarts = 0

    for cle, hexa in releve.items():
        motif = re.compile(r"(key: '%s', label: '[^']*', color: )'(#[0-9a-fA-F]{6})'" % cle)
        m = motif.search(js)
        if not m:
            print(f'{cle:10s} {hexa}   ABSENT de PIECES')
            ecarts += 1
            continue
        if m.group(2).lower() == hexa:
            print(f'{cle:10s} {hexa}   ok')
        else:
            ecarts += 1
            print(f'{cle:10s} {hexa}   JS dit {m.group(2)}' + ('  -> réécrit' if ecrire else ''))
            if ecrire:
                js = motif.sub(lambda mm: mm.group(1) + f"'{hexa}'", js)

    if ecrire and ecarts:
        JS.write_text(js)
    if ecarts and not ecrire:
        print(f'\n{ecarts} écart(s). Relancer avec --ecrire pour aligner le JS sur les images.')
    return 1 if (ecarts and not ecrire) else 0


if __name__ == '__main__':
    sys.exit(main())
