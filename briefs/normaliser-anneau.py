#!/usr/bin/env python3
"""Remet l'anneau générateur à la géométrie exacte, sur fond transparent.

Un générateur d'images ne tient pas les cotes demandées : l'anneau livré fait
1241 x 1223 px (ovale), son trou est décentré de 9 px et ovale lui aussi. Or
tout l'intérêt de l'anneau unique est que les centres s'y emboîtent au pixel
près. On le redresse donc par une remise en coordonnées POLAIRES : pour
chaque angle, on mesure où se trouvent le bord extérieur et le bord du trou,
puis on étire ce qu'il y a entre les deux sur des rayons constants. Le
résultat est un cercle exact, un trou exact, concentriques.

Cotes de sortie (canevas carré, rayon extérieur = 1) :
    bord extérieur  1.000
    trou            TROU   (les centres se coupent à ce rayon, voir plus bas)

Usage :
    python3 briefs/normaliser-anneau.py                # -> anneau-normal.png
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'briefs/planche-couleurs/medaillon-new.png'
SORTIE = RACINE / 'briefs/planche-couleurs/anneau-normal.png'

COTE = 1024          # canevas de sortie
R_EXT = 506          # rayon extérieur en px (4 px de marge pour l'adoucissement)
TROU = 0.729         # rayon du trou / rayon extérieur, tel que mesuré sur la source
GRIGNOTE = 2.5       # px de source rognés de chaque côté : franges mêlées de magenta


def fond(a):
    """Le magenta du fond, y compris ses franges adoucies."""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return (r - g > 90) & (b - g > 90)


def bords_polaires(solide, cx, cy, n=3600):
    """Pour chaque angle : rayon du premier et du dernier pixel d'anneau."""
    th = np.linspace(0, 2 * np.pi, n, endpoint=False)
    rs = np.arange(0, 700, 0.5)
    X = cx + np.outer(np.sin(th), rs)
    Y = cy - np.outer(np.cos(th), rs)
    v = ndimage.map_coordinates(solide.astype(np.float32), [Y, X], order=1, cval=0) > 0.5
    interieur = np.array([rs[np.argmax(l)] for l in v])
    exterieur = np.array([rs[len(l) - 1 - np.argmax(l[::-1])] for l in v])
    return th, interieur, exterieur


def lisser(v):
    """Le contour se lit au demi-pixel : un léger lissage circulaire le calme."""
    return ndimage.gaussian_filter1d(v, 6, mode='wrap')


def main():
    a = np.asarray(Image.open(SRC).convert('RGB')).astype(np.float32)
    h, w = a.shape[:2]
    solide = ~fond(a)
    ext = ndimage.binary_fill_holes(solide)
    ys, xs = np.nonzero(ext)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2

    th, r_in, r_out = bords_polaires(solide, cx, cy)
    r_in, r_out = lisser(r_in) + GRIGNOTE, lisser(r_out) - GRIGNOTE
    print(f'centre {cx:.1f},{cy:.1f}   bord ext {r_out.min():.0f}..{r_out.max():.0f}'
          f'   trou {r_in.min():.0f}..{r_in.max():.0f}')

    # Pixel de sortie -> (rayon, angle) -> pixel de source.
    yy, xx = np.mgrid[0:COTE, 0:COTE].astype(np.float32)
    c = (COTE - 1) / 2
    dx, dy = xx - c, c - yy
    rho = np.hypot(dx, dy)
    ang = np.mod(np.arctan2(dx, dy), 2 * np.pi)
    pos = ang / (2 * np.pi) * len(th)
    ri = ndimage.map_coordinates(np.r_[r_in, r_in[:1]], [pos], order=1)
    ro = ndimage.map_coordinates(np.r_[r_out, r_out[:1]], [pos], order=1)

    r1, r0 = R_EXT, R_EXT * TROU
    t = np.clip((rho - r0) / (r1 - r0), 0, 1)
    s = ri + t * (ro - ri)
    sx, sy = cx + s * np.sin(ang), cy - s * np.cos(ang)
    rgb = np.dstack([ndimage.map_coordinates(a[..., k], [sy, sx], order=1, mode='nearest')
                     for k in range(3)])

    # Alpha : 1 entre les deux cercles exacts, adouci sur un pixel de chaque côté.
    alpha = np.clip(rho - r0 + 0.5, 0, 1) * np.clip(r1 - rho + 0.5, 0, 1)
    out = np.dstack([rgb, alpha * 255]).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(SORTIE)
    print('écrit', SORTIE.relative_to(RACINE))


if __name__ == '__main__':
    sys.exit(main())
