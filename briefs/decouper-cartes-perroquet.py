#!/usr/bin/env python3
"""Découpe de la planche des 14 cartes Perroquet (la famille verte).

La planche est générée d'un coup — c'est ce qui donne aux 14 cartes la même
lumière et le même cadre. Elle arrive posée sur une table en bois, avec son
ombre portée : on isole donc chaque carte sur le bois, on recadre sur le
papier lui-même (l'ombre est sombre, elle tombe hors du masque), puis on
ramène chaque carte au format des illustrations déjà en place — 434 x 620,
soit exactement le 7:10 de .sk-card. La planche est plus étroite que ça
(ratio ~1:2) : la remise au format élargit donc légèrement les cartes. À la
taille où elles s'affichent (84 px de large) l'écart ne se voit pas, alors
qu'une carte au mauvais ratio se verrait tout de suite à côté des Pirates.
"""
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'public/assets/cards/src/cartes-perroquet.png'
OUT = RACINE / 'public/assets/cards'

LARGEUR, HAUTEUR = 434, 620  # le format des cartes illustrées déjà en place
QUALITE = 80


def runs(masque, mini):
    """Les plages continues de True, d'au moins `mini` de long."""
    plages, debut = [], None
    for i, v in enumerate(masque):
        if v and debut is None:
            debut = i
        elif not v and debut is not None:
            if i - debut >= mini:
                plages.append((debut, i))
            debut = None
    if debut is not None and len(masque) - debut >= mini:
        plages.append((debut, len(masque)))
    return plages


def grille(a):
    """Les 14 boîtes de cartes, en lecture (haut->bas, gauche->droite).

    Le bois est la couleur du pourtour de la planche : tout ce qui s'en écarte
    franchement est une carte. On ne suppose pas de grille régulière — on lit
    les lignes, puis les colonnes dans chaque ligne.
    """
    bord = np.concatenate([a[:6].reshape(-1, 3), a[-6:].reshape(-1, 3),
                           a[:, :6].reshape(-1, 3), a[:, -6:].reshape(-1, 3)])
    bois = np.median(bord, axis=0)
    hors_bois = np.linalg.norm(a - bois, axis=2) > 60
    boites = []
    for haut, bas in runs(hors_bois[:, 100:-100].mean(1) > 0.5, 50):
        if bas - haut < 250:  # le bandeau de titre, blanc et bien plus bas qu'une carte
            continue
        for gauche, droite in runs(hors_bois[haut:bas].mean(0) > 0.6, 50):
            boites.append((gauche, haut, droite, bas))
    return boites


def recadrer(im):
    """Recadre sur le papier : bord blanc + bande verte, sans l'ombre portée."""
    a = np.asarray(im).astype(int)
    clair = a.mean(2) > 150
    vert = (a[..., 1] > 90) & (a[..., 1] - a[..., 0] > 25) & (a[..., 1] - a[..., 2] > 25)
    carte = clair | vert
    ys, xs = np.nonzero(carte)
    return im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))


def main():
    planche = Image.open(SRC).convert('RGB')
    boites = grille(np.asarray(planche).astype(float))
    if len(boites) != 14:
        raise SystemExit(f'{len(boites)} cartes détectées sur la planche, 14 attendues')
    for valeur, boite in enumerate(boites, start=1):
        carte = recadrer(planche.crop(boite)).resize((LARGEUR, HAUTEUR), Image.LANCZOS)
        cible = OUT / f'perroquet-{valeur}.webp'
        carte.save(cible, quality=QUALITE, method=6)
        print(f'{cible.name}  {cible.stat().st_size // 1024} Ko')


if __name__ == '__main__':
    main()
