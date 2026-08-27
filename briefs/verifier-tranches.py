#!/usr/bin/env python3
"""Épreuve d'étirement en 9 tranches.

`border-image` découpe une image en 9 : les 4 coins restent intacts, les 4 bords
et le centre se répètent. Une valeur de tranche trop courte coupe dans le décor
d'angle ; trop longue, elle fige un morceau de bord qui devrait se répéter. Les
deux se voient au premier étirement et ne se voient PAS sur l'image d'origine.

Ce script reproduit l'algorithme en Pillow et rend la pièce à un format très
différent du sien, pour que le défaut saute aux yeux avant d'écrire le CSS.
"""
import sys
from pathlib import Path

from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SKIN = RACINE / 'public/assets/skin'


def carreler(m, cible):
    """Répète le morceau un nombre ENTIER de fois, puis l'ajuste — c'est ce
    que fait `border-image-repeat: round`."""
    cw, ch = cible
    n_x = max(1, round(cw / m.width)) if m.width else 1
    n_y = max(1, round(ch / m.height)) if m.height else 1
    tuile = Image.new('RGBA', (m.width * n_x, m.height * n_y))
    for i in range(n_x):
        for j in range(n_y):
            tuile.paste(m, (i * m.width, j * m.height))
    return tuile.resize(cible, Image.LANCZOS)


def neuf_tranches(im, tranches, taille, repet='stretch'):
    """tranches = (haut, droite, bas, gauche) en px ; taille = (W, H) visé.
    repet = 'stretch' ou 'round' (appliqué aux bords GAUCHE et DROIT)."""
    h_, d_, b_, g_ = tranches
    W, H = taille
    w, h = im.size
    assert g_ + d_ < W and h_ + b_ < H, 'la cible est plus petite que les coins'

    def bout(boite, cible, mode='stretch'):
        m = im.crop(boite)
        if cible[0] <= 0 or cible[1] <= 0:
            return None
        return carreler(m, cible) if mode == 'round' else m.resize(cible, Image.LANCZOS)

    mw, mh = W - g_ - d_, H - h_ - b_          # centre visé
    sw, sh = w - g_ - d_, h - h_ - b_          # centre source
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    morceaux = [
        ((0, 0, g_, h_),           (0, 0),          (g_, h_)),        # coin ht-g
        ((w - d_, 0, w, h_),       (W - d_, 0),     (d_, h_)),        # coin ht-d
        ((0, h - b_, g_, h),       (0, H - b_),     (g_, b_)),        # coin bs-g
        ((w - d_, h - b_, w, h),   (W - d_, H - b_), (d_, b_)),       # coin bs-d
        ((g_, 0, w - d_, h_),      (g_, 0),         (mw, h_)),        # bord haut
        ((g_, h - b_, w - d_, h),  (g_, H - b_),    (mw, b_)),        # bord bas
        ((0, h_, g_, h - b_),      (0, h_),         (g_, mh), repet),  # bord gauche
        ((w - d_, h_, w, h - b_),  (W - d_, h_),    (d_, mh), repet),  # bord droit
        ((g_, h_, w - d_, h - b_), (g_, h_),        (mw, mh)),        # centre (fill)
    ]
    for morceau in morceaux:
        boite, pos, cible = morceau[:3]
        m = bout(boite, cible, morceau[3] if len(morceau) > 3 else 'stretch')
        if m:
            out.paste(m, pos)
    return out


def main(noms):
    for nom in noms:
        chemin = SKIN / f'{nom}.webp'
        meta = SKIN / f'{nom}.tranches'
        if not chemin.exists() or not meta.exists():
            print(f'  absent : {nom}', file=sys.stderr)
            continue
        champs = meta.read_text().split()
        tranches = tuple(int(v) for v in champs[:4])
        repet = champs[4] if len(champs) > 4 else 'stretch'
        im = Image.open(chemin).convert('RGBA')
        w, h = im.size
        # Deux épreuves : très large et très haute. Si la pièce tient les deux,
        # elle tiendra tous les formats intermédiaires.
        for etiq, cible in (('large', (int(w * 1.9), int(h * 0.55))),
                            ('haute', (int(w * 0.5), int(h * 1.8)))):
            ep = neuf_tranches(im, tranches, cible, repet)
            fond = Image.new('RGBA', ep.size, (18, 12, 7, 255))
            fond.alpha_composite(ep)
            dest = Path('/private/tmp/claude-501/-Users-paul/'
                        '06dde179-8b77-4bf5-9fcf-7a36425bbd7c/scratchpad') / f'tranches-{nom}-{etiq}.png'
            fond.convert('RGB').save(dest)
        print(f'  {nom:18} {w}x{h}  tranches {tranches} / {repet}  -> 2 épreuves')


if __name__ == '__main__':
    main(sys.argv[1:])
