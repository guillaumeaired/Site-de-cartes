#!/usr/bin/env python3
"""Recentre la barre de la roue de tirage sur son moyeu.

`aiguille-roue.webp` sortait du generateur avec deux defauts qui se voyaient
tous les deux a l'ecran des que la barre tournait :

1. le moyeu de laiton -- l'axe rond sur lequel la barre pivote -- n'etait pas
   au milieu de l'image, mais nettement a gauche, l'image trainant derriere
   elle une large bande transparente a droite (et un filigrane oublie dans le
   coin). Le CSS posait le pivot a 50 % de la largeur : l'axe decrivait donc
   un petit cercle autour du centre du gouvernail au lieu d'y rester plante ;
2. le disque du moyeu etait tronque par le bord bas de l'image.

Le script corrige les deux, en se fiant a ce qu'il MESURE et non a des
constantes : il isole la plus grosse forme opaque (la barre ; le filigrane
part avec le reste), releve le centre et le rayon du moyeu sur la ligne la
plus large, recompose le bas du disque manquant a partir de sa propre jante,
puis recadre symetriquement autour du centre du moyeu.

Il est donc idempotent, et meme inerte : relance sur une image deja
recentree, il ne trouve plus rien a completer ni a rogner et n'ecrit RIEN --
c'est ce qui evite de repasser l'image dans l'encodeur a chaque appel. Les
proportions a reporter dans skullking.css (largeur/hauteur du pointeur et
hauteur du pivot) sont affichees a la fin, dans les deux cas.
"""
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

RACINE = Path(__file__).resolve().parent.parent
CIBLE = RACINE / 'public/assets/skin/aiguille-roue.webp'

OPAQUE = 40  # seuil alpha : en dessous, c'est du vide ou une frange


def forme_principale(alpha):
    """La barre seule : la plus grosse composante opaque de l'image."""
    etiquettes, n = ndimage.label(alpha > OPAQUE)
    if n <= 1:
        return alpha > OPAQUE
    tailles = ndimage.sum(np.ones_like(etiquettes), etiquettes, range(1, n + 1))
    return etiquettes == (1 + int(np.argmax(tailles)))


def moyeu(masque):
    """Centre et rayon du disque de laiton = la ligne la plus large."""
    largeurs = []
    for y in range(masque.shape[0]):
        xs = np.nonzero(masque[y])[0]
        if len(xs):
            largeurs.append((xs.max() - xs.min(), y, xs.min(), xs.max()))
    _, cy, x0, x1 = max(largeurs)
    return (x0 + x1) / 2, float(cy), (x1 - x0) / 2


def completer_disque(pixels, masque, cx, cy, rayon):
    """Rend au moyeu la part de disque que le bord de l'image avait coupee.

    Un pixel manquant est repris a 90 deg de la ou il devrait etre : sur un
    disque, c'est la meme distance au centre, donc la meme jante. La lumiere
    y est un rien differente (elle vient du haut), mais on ne recompose ici
    qu'un croissant de quelques pixels sur un disque de plus de 470.
    """
    h, w = masque.shape
    bas = int(np.nonzero(masque)[0].max())  # derniere ligne deja peinte
    hauteur_utile = int(np.floor(cy + rayon)) + 1  # dernier pixel touche par le disque
    if hauteur_utile > h:  # place pour le croissant manquant
        pixels = np.vstack([pixels, np.zeros((hauteur_utile - h, w, 4), pixels.dtype)])
        masque = np.vstack([masque, np.zeros((hauteur_utile - h, w), bool)])
        h = hauteur_utile

    yy, xx = np.mgrid[0:h, 0:w]
    dx, dy = xx - cx, yy - cy
    # Uniquement SOUS la matiere existante : ce qui manque a l'interieur du
    # disque est une frange d'antialiasing, pas un trou -- la repeindre ne
    # ferait qu'epaissir la jante a chaque passage.
    trous = (dx * dx + dy * dy <= rayon * rayon) & ~masque & (yy > bas)
    if not trous.any():
        return pixels, masque, False

    sy = np.clip(np.rint(cy - dx).astype(int), 0, h - 1)   # rotation de 90 deg
    sx = np.clip(np.rint(cx + dy).astype(int), 0, w - 1)
    valide = trous & masque[sy, sx]
    pixels[valide] = pixels[sy[valide], sx[valide]]
    masque |= valide
    return pixels, masque, bool(valide.any())


def ecrire(coupe):
    """Meme encodage que le reste de la planche (voir traiter-assets.py)."""
    tmp = CIBLE.with_suffix('.tmp.png')
    Image.fromarray(coupe, 'RGBA').save(tmp)
    subprocess.run(['cwebp', '-quiet', '-q', '88', '-alpha_q', '100',
                    str(tmp), '-o', str(CIBLE)], check=True)
    tmp.unlink()


def main():
    image = Image.open(CIBLE).convert('RGBA')
    pixels = np.array(image)
    masque = forme_principale(pixels[:, :, 3])
    parasite = bool((pixels[:, :, 3] > OPAQUE).sum() > masque.sum())
    pixels[~masque] = 0  # au passage : le filigrane du coin disparait

    cx, cy, rayon = moyeu(masque)
    pixels, masque, recompose = completer_disque(pixels, masque, cx, cy, rayon)

    ys, xs = np.nonzero(masque)
    # Recadrage symetrique : le moyeu doit tomber pile au milieu en largeur.
    demi = max(cx - xs.min(), xs.max() - cx)
    x0, x1 = int(round(cx - demi)), int(round(cx + demi))
    y0, y1 = int(ys.min()), int(ys.max())
    coupe = pixels[y0:y1 + 1, x0:x1 + 1]

    if parasite or recompose or coupe.shape[:2] != image.size[::-1]:
        ecrire(coupe)
        print('reecrit.')
    else:
        print('deja recentre : rien a faire.')

    hauteur, largeur = coupe.shape[:2]
    # +0.5 : cx/cy reperent un PIXEL, les proportions du CSS une position
    # continue dans l'image -- le centre du pixel i tombe a i + 0,5.
    pivot = (cy + 0.5 - y0) / hauteur
    print(f'{CIBLE.name} : {largeur} x {hauteur}')
    print(f'  moyeu au centre : x = {(cx + 0.5 - x0) / largeur:.4%}, y = {pivot:.4%}')
    print('  a reporter dans skullking.css (.sk-wheel-needle) :')
    print(f'    transform-origin: 50% {pivot * 100:.2f}%;')
    print(f'    hauteur H libre, largeur = {largeur / hauteur:.4f} x H,')
    print(f'    pointe a {pivot:.4f} x H au-dessus du pivot')


if __name__ == '__main__':
    main()
