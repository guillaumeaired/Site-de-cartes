#!/usr/bin/env python3
"""Reprend les clous de l'anneau normalisé : même clou, pas régulier, rayon constant.

Le générateur a posé 21 clous à des écarts de 15,7 à 19,5 degrés et à des
rayons qui flottent d'un côté à l'autre de l'émail. À 100 px ça ne se voit
pas, mais l'anneau est fait pour servir à toutes les pièces : autant qu'il
soit régulier. Le script :

  1. repère les clous (laiton saturé dans la bande d'émail) et leur ombre ;
  2. déroule la bande d'émail en un rectangle (angle x rayon), où effacer un
     clou revient à recopier le grain d'un endroit voisin sans clou ;
  3. en tire UN clou propre, avec son ombre portée sur l'émail ;
  4. le pose N fois, régulièrement, SANS le tourner : la lumière vient du
     haut à gauche pour tous, comme sur le reste de la pièce.

Usage :
    python3 briefs/normaliser-anneau.py
    python3 briefs/refaire-clous-anneau.py             # -> anneau-regulier.png
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'briefs/planche-couleurs/anneau-normal.png'
SORTIE = RACINE / 'briefs/planche-couleurs/anneau-regulier.png'

N_CLOUS = 12               # fixe, un toutes les 30°, le premier à 12 h ;
                           # composer-pieces-couleur.py doit dire le même nombre
R_EXT = 506.0
BANDE = (0.79, 0.935)      # où se trouvent les clous, en fraction de R_EXT
R_CLOU = 0.862             # rayon de pose des clous, au milieu de l'émail (médiane du gabarit)
OMBRE = 15                 # px autour d'un clou pris dans son ombre portée
FENETRE = 50               # demi-côté de la vignette d'un clou, ombre comprise
COLS = 3072                # résolution angulaire de la bande déroulée


def saturation(rgb):
    mx, mn = rgb.max(2), rgb.min(2)
    return (mx - mn) / np.maximum(mx, 1)


def trouver_clous(rgb, alpha, c):
    yy, xx = np.mgrid[0:rgb.shape[0], 0:rgb.shape[1]]
    d = np.hypot(yy - c, xx - c) / R_EXT
    laiton = (saturation(rgb) > 0.30) & (alpha > 200) & (d > BANDE[0]) & (d < BANDE[1])
    laiton = ndimage.binary_opening(laiton, np.ones((5, 5)))
    laiton = ndimage.binary_fill_holes(laiton)
    lab, n = ndimage.label(laiton)
    tailles = ndimage.sum(laiton, lab, range(1, n + 1))
    return lab, [i + 1 for i, t in enumerate(tailles) if t > 600]


def derouler(img, c, r0, r1, cols):
    """Rectangle (rayon x angle) d'une image ; angle 0 en haut, sens horaire."""
    th = np.arange(cols) / cols * 2 * np.pi
    rs = np.arange(r0, r1)
    X = c + np.outer(rs, np.sin(th))
    Y = c - np.outer(rs, np.cos(th))
    if img.ndim == 2:
        return ndimage.map_coordinates(img, [Y, X], order=1, mode='wrap')
    return np.dstack([ndimage.map_coordinates(img[..., k], [Y, X], order=1, mode='wrap')
                      for k in range(img.shape[2])])


def renrouler(bande, shape, c, r0, cols, hors=None):
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]].astype(np.float32)
    dx, dy = xx - c, c - yy
    rho = np.hypot(dx, dy) - r0
    col = np.mod(np.arctan2(dx, dy), 2 * np.pi) / (2 * np.pi) * cols
    if bande.ndim == 2:
        if hors is not None:
            return ndimage.map_coordinates(np.c_[bande, bande[:, :1]], [rho, col], order=1,
                                           mode='constant', cval=hors)
        return ndimage.map_coordinates(np.c_[bande, bande[:, :1]], [rho, col], order=1, mode='nearest')
    return np.dstack([ndimage.map_coordinates(np.c_[bande[..., k], bande[:, :1, k]], [rho, col],
                                              order=1, mode='nearest')
                      for k in range(bande.shape[2])])


def effacer(rgba, c, masque):
    """Remplace les zones du masque par de l'émail : teinte voisine + grain emprunté.

    Entre deux clous il ne reste qu'une cinquantaine de colonnes propres, moins
    que la largeur d'un clou : on ne peut donc pas recopier un morceau d'émail
    entier. On refait l'émail en deux couches :
      - le fond, une moyenne locale des seuls pixels d'émail sains (c'est lui
        qui porte les variations d'éclairage lentes) ;
      - le grain, pris sur la bande saine juste à côté et répété en miroir.
    """
    r0, r1 = int(R_EXT * 0.775), int(R_EXT * 0.94)
    bande = derouler(rgba[..., :3], c, r0, r1, COLS)
    mb = derouler(masque.astype(np.float32), c, r0, r1, COLS) > 0.5
    sat = saturation(bande)

    # Les lignes d'émail : celles qui restent grises sur presque tout le tour.
    emaille_ligne = np.nanmedian(np.where(mb, np.nan, sat), axis=1) < 0.12
    emaille_ligne = ndimage.binary_erosion(emaille_ligne, iterations=1)
    sain = (sat < 0.12) & ~mb & emaille_ligne[:, None]
    w = sain.astype(np.float32)[..., None]

    def moyenne(x, sigma, w):
        num = ndimage.gaussian_filter(x * w, (sigma[0], sigma[1], 0), mode='wrap')
        den = ndimage.gaussian_filter(w[..., 0], sigma, mode='wrap')[..., None]
        return num / np.maximum(den, 1e-3)

    # Le fond : moyenne le long du tour seulement (presque rien en rayon), sur
    # tout ce qui n'est pas un clou. Chaque ligne garde ainsi sa propre
    # luminance — y compris le dégradé d'ombre au pied des liserés, où les gros
    # clous du gabarit venaient mordre.
    hors_clou = (~mb).astype(np.float32)[..., None]
    fond = moyenne(bande, (0.8, 30), hors_clou)
    grain = (bande - moyenne(bande, (1.5, 1.5), w)) * w
    # Les lignes repeintes : l'émail, plus quelques lignes de chaque côté pour
    # rattraper le bord des anciens clous sur l'ombre des liserés.
    lignes_peintes = ndimage.binary_dilation(emaille_ligne, iterations=5)

    out = bande.copy()
    peint = np.zeros(mb.shape, np.float32)   # ce qui a réellement été repeint
    lab, n = ndimage.label(mb)
    for i in range(1, n + 1):
        cols = np.nonzero((lab == i).any(0))[0]
        c0, c1 = cols.min(), cols.max() + 1
        larg = c1 - c0
        # Le grain de la bande saine qui suit le clou, répété en miroir.
        src = np.arange(c1 + 6, c1 + 6 + 40) % COLS
        patch = grain[:, src]
        idx = np.arange(c0 - 10, c1 + 10)
        pos = (idx - (c0 - 10)) % (2 * len(src))
        pos = np.where(pos >= len(src), 2 * len(src) - 1 - pos, pos)
        remplis = fond[:, idx % COLS] + patch[:, pos]
        zone = np.zeros(mb.shape, bool)
        zone[:, idx % COLS] = (lab == i)[:, idx % COLS]
        zone &= lignes_peintes[:, None]
        poids = ndimage.gaussian_filter(zone.astype(np.float32), 1.5, mode='wrap')[:, idx % COLS, None]
        out[:, idx % COLS] = out[:, idx % COLS] * (1 - poids) + remplis * poids
        peint[:, idx % COLS] = np.maximum(peint[:, idx % COLS], poids[..., 0])
    return out, peint, r0


def main():
    rgba = np.asarray(Image.open(SRC).convert('RGBA')).astype(np.float32)
    rgb, alpha = rgba[..., :3], rgba[..., 3]
    c = (rgb.shape[0] - 1) / 2

    lab, clous = trouver_clous(rgb, alpha, c)
    print(len(clous), 'clous repérés')
    masque = ndimage.binary_dilation(np.isin(lab, clous), iterations=OMBRE)

    bande_propre, peint, r0 = effacer(rgba, c, masque)
    propre = rgb.copy()
    reboucle = renrouler(bande_propre, rgb.shape, c, r0, COLS)
    # On ne recolle QUE ce qui a été repeint dans la bande : hors de la bande,
    # le renroulement recopierait sa dernière ligne sur le liseré.
    w = np.clip(renrouler(peint, rgb.shape, c, r0, COLS, hors=0.0), 0, 1)[..., None]
    propre = rgb * (1 - w) + reboucle * w

    # Le clou modèle : celui dont le centre est le plus près de 12 h.
    centres = {k: ndimage.center_of_mass(lab == k) for k in clous}
    modele = min(clous, key=lambda k: abs(centres[k][1] - c) + 0.01 * abs(centres[k][0] - c))
    cy, cx = [int(round(v)) for v in centres[modele]]
    f = FENETRE
    orig = rgb[cy - f:cy + f, cx - f:cx + f]
    net = propre[cy - f:cy + f, cx - f:cx + f]
    laiton = ndimage.binary_fill_holes(
        ndimage.binary_opening(saturation(orig) > 0.30, np.ones((3, 3))))
    # Une seule tache : le clou, pas un bout de liseré qui passerait dans la vignette.
    tl, tn = ndimage.label(laiton)
    if tn > 1:
        tl_c = tl[f, f]
        laiton = tl == tl_c
    # Le clou entier : laiton plus son liseré sombre (2 px), sinon le contour pointille.
    clou = ndimage.binary_dilation(laiton, iterations=2)
    mb = ndimage.gaussian_filter(clou.astype(np.float32), 0.8)[..., None]
    # L'ombre portée : rapport des luminances LISSÉES, sinon le grain de l'émail,
    # différent entre l'original et le fond refait, dessine des points sombres.
    lum_o = ndimage.gaussian_filter(orig.mean(2), 3)
    lum_n = ndimage.gaussian_filter(net.mean(2), 3)
    ombre = np.clip(lum_o / np.maximum(lum_n, 1), 0.3, 1.0)[..., None]
    dist = ndimage.distance_transform_edt(~clou)[..., None]
    ombre = 1 - (1 - ombre) * np.clip(1 - (dist - 8) / 8, 0, 1)
    # La lumière vient du haut à gauche : l'ombre du clou tombe en bas à droite.
    # Tout ce qui est assombri AU-DESSUS/À GAUCHE du clou est l'ombre que le
    # liseré extérieur porte sur l'émail à 12 h, pas celle du clou : on la coupe.
    yy, xx = np.mgrid[-f:f, -f:f].astype(np.float32)
    u = (xx + yy) / math.sqrt(2)
    ombre = 1 - (1 - ombre) * np.clip((u - 8) / 10, 0, 1)[..., None]

    res = propre.copy()
    for k in range(N_CLOUS):
        ph = 2 * math.pi * k / N_CLOUS
        px = int(round(c + R_EXT * R_CLOU * math.sin(ph)))
        py = int(round(c - R_EXT * R_CLOU * math.cos(ph)))
        zone = res[py - f:py + f, px - f:px + f]
        res[py - f:py + f, px - f:px + f] = (mb * orig + (1 - mb) * zone * ombre)

    out = np.dstack([res, alpha]).clip(0, 255).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(SORTIE)
    print('écrit', SORTIE.relative_to(RACINE))


if __name__ == '__main__':
    sys.exit(main())
