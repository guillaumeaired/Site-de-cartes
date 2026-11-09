#!/usr/bin/env python3
"""Prototype : un anneau unique recolorié en 14 couleurs, posé sur des centres existants.

Entrées :
    briefs/planche-couleurs/anneau-regulier.png   (normaliser-anneau.py puis
                                                   refaire-clous-anneau.py)
    public/assets/skin/piece-*.webp               (les centres, pris dans les
                                                   pièces actuelles)

Sorties :
    briefs/planche-couleurs/prototype-anneau.png  (une pièce, les 14 couleurs)
    briefs/planche-couleurs/tous-les-motifs.png   (original | anneau, pour tous)
    public/assets/skin/pieces/<motif>-<couleur>.webp
                                                  (avec --ecrire : les pièces du
                                                   jeu, chaque motif dans chaque couleur)

Usage :
    python3 briefs/normaliser-anneau.py
    python3 briefs/refaire-clous-anneau.py
    python3 briefs/composer-pieces-couleur.py --ecrire

Recolorer l'émail : il est gris neutre (saturation ~0,05), donc sa luminance
porte tout le relief — grain, paillettes, ombres des clous. On garde cette
luminance et on y remet la couleur : pixel = couleur x (luminance / émail moyen).
Les clous et les liserés de laiton sont protégés : ils ne changent pas.

Le centre d'une pièce actuelle est ramené à l'échelle de l'anneau (son rayon
extérieur mesuré sur l'alpha) puis découpé à ANNEAU_TROU + un peu : le bord
est caché sous le liseré intérieur du nouvel anneau.
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

RACINE = Path(__file__).resolve().parent.parent
ANNEAU = RACINE / 'briefs/planche-couleurs/anneau-regulier.png'
SKIN = RACINE / 'public/assets/skin'
# Les médaillons d'origine, d'où l'on tire les centres. Ils ne sont plus dans
# le jeu (remplacés par les pièces recomposées) et le dossier src/ n'est pas
# versionné : s'il manque, on les ressort de l'historique git, par exemple
#   git show 025e798:public/assets/skin/piece-crane.webp > .../piece-crane.webp
SOURCES = SKIN / 'src/pieces-origine'
SORTIE = RACINE / 'briefs/planche-couleurs/prototype-anneau.png'
TOUS = RACINE / 'briefs/planche-couleurs/tous-les-motifs.png'

COTE = 1024
R_EXT = 506.0
TROU = 0.729
DECOUPE = 0.76          # rayon de découpe des centres, un peu au-delà du trou
N_CLOUS = 12            # le même que refaire-clous-anneau.py : on protège leurs places
R_CLOU = 0.862          # le même que refaire-clous-anneau.py
R_CLOU_PX = 33.5        # rayon d'un clou de medaillon-new, liseré sombre compris
EMAIL_REF = 205.0       # luminance moyenne de l'émail neutre

# Les quatorze couleurs : les teintes du cercle chromatique, plus claires et
# plus sombres en alternance pour que deux voisines ne se confondent pas, même
# vues en petit ou par quelqu'un qui distingue mal le rouge du vert ; puis le
# blanc (un ivoire, pour garder le grain de l'émail) et le noir.
COULEURS = [
    ('rouge',     '#c4161c'),
    ('orange',    '#f0701a'),
    ('jaune',     '#f4c81e'),
    ('anis',      '#9ec21e'),
    ('vert',      '#2f8a3a'),
    ('menthe',    '#62d6a6'),
    ('turquoise', '#0c9aa0'),
    ('ciel',      '#45b0ea'),
    ('marine',    '#1f48a8'),
    ('violet',    '#6d3fc4'),
    ('magenta',   '#c4207e'),
    ('rose',      '#f4a8c8'),
    ('blanc',     '#ece8de'),
    ('noir',      '#2c2c30'),
]


def hex_rgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], np.float32)


def charger_anneau():
    a = np.asarray(Image.open(ANNEAU).convert('RGBA')).astype(np.float32)
    return a[..., :3], a[..., 3]


def masque_email(rgb, alpha):
    """1 sur l'émail, 0 sur le laiton et les clous, adouci aux bords."""
    c = (COTE - 1) / 2
    yy, xx = np.mgrid[0:COTE, 0:COTE].astype(np.float32)
    mx, mn = rgb.max(2), rgb.min(2)
    sat = (mx - mn) / np.maximum(mx, 1)
    doux = np.clip((0.30 - sat) / 0.18, 0, 1)
    d = np.hypot(yy - c, xx - c) / R_EXT
    doux *= ((d > TROU + 0.02) & (d < 0.945)).astype(np.float32)
    protege = np.zeros_like(doux)
    for k in range(N_CLOUS):
        ph = 2 * math.pi * k / N_CLOUS
        px = c + R_EXT * R_CLOU * math.sin(ph)
        py = c - R_EXT * R_CLOU * math.cos(ph)
        dist = np.hypot(yy - py, xx - px)
        protege = np.maximum(protege, np.clip((R_CLOU_PX + 1.5 - dist) / 3, 0, 1))
    return doux * (1 - protege) * (alpha / 255)


def recolorier(rgb, masque, couleur):
    lum = rgb.mean(2, keepdims=True) / EMAIL_REF
    neuf = np.clip(hex_rgb(couleur) * lum, 0, 255)
    m = masque[..., None]
    return rgb * (1 - m) + neuf * m


def rayon_exterieur(alpha):
    ys, xs = np.nonzero(alpha > 128)
    return ((xs.max() - xs.min() + 1) + (ys.max() - ys.min() + 1)) / 4, \
        ((xs.max() + xs.min()) / 2, (ys.max() + ys.min()) / 2)


# Les pièces à code ont un liseré intérieur plus large (laiton de 0,70 à 0,73
# du rayon, sillon sombre à 0,68) : à l'échelle 1, il resterait visible dans le
# trou et doublerait celui de l'anneau. On grossit leur centre pour le glisser
# dessous — leur sillon tombe alors à 0,715, là où l'Ancre et le Crâne ont le leur.
ZOOM = {'pomme': 1.06, 'taureau': 1.06, 'visa': 1.06, 'viseur': 1.06, 'harvard': 1.06}


# Ce qui passe PAR-DESSUS le cadre : sur l'original, la pointe et le manche du
# sabre chevauchent le liseré intérieur. Découpés au disque, ils seraient
# tranchés net par l'anneau. On les détoure donc à part (polygones relevés à
# la main sur le .webp d'origine, en pixels de ce fichier) et on les repose
# au-dessus de l'anneau, avec l'ombre qu'ils y portent. Chaque polygone se
# referme À L'INTÉRIEUR du disque central : là, il recouvre les mêmes pixels
# que le centre et la couture ne se voit pas.
DEBORDE = {
    'sabre': [
        [   # la pointe de la lame
            (308.5, 79.5),                                     # pointe
            (311.5, 88), (311.8, 100), (311.3, 110), (310.3, 120),
            (308.5, 130), (306, 138),                          # dos de la lame
            (272.5, 138),                                      # coupe, déjà dans le disque
            (277, 130), (283.5, 120), (289.5, 110), (295.5, 100),
            (301.3, 90), (305.5, 83),                          # tranchant
        ],
        [   # le manche : bout du quillon, volute de la garde, bas de la garde
            (100, 262), (92, 267.5), (84, 267), (77, 268.5),   # dessus du quillon
            (72.5, 272), (71, 277), (72.5, 282), (77, 284.5),  # sa boule
            (81, 286),                                         # creux (émail violet exclu)
            (77.5, 289), (76.5, 295), (77.5, 302), (80.5, 308),
            (86, 312.5), (94, 313.8),                          # volute
            (103, 313.5), (112, 315.5), (122, 316.2), (132, 315.2),
            (142, 312.5), (148, 309),                          # bas de la garde
            (150, 300), (120, 290), (105, 275),                # retour dans le disque
        ],
    ],
}
SURECH = 8              # suréchantillonnage du polygone, pour un bord antialiasé


def placer(im, cle):
    """Une image de la taille du .webp d'origine, mise à l'échelle de l'anneau."""
    r, (cx, cy) = rayon_exterieur(np.asarray(Image.open(SOURCES / f'piece-{cle}.webp'))[..., 3])
    k = R_EXT / r * ZOOM.get(cle, 1.0)
    im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    toile = Image.new('RGBA', (COTE, COTE), (0, 0, 0, 0))
    toile.alpha_composite(im, (round((COTE - 1) / 2 - cx * k), round((COTE - 1) / 2 - cy * k)))
    return toile


def centre_de(cle):
    """Le disque central d'une pièce actuelle, à l'échelle de l'anneau."""
    toile = placer(Image.open(SOURCES / f'piece-{cle}.webp').convert('RGBA'), cle)
    a = np.asarray(toile).astype(np.float32)
    yy, xx = np.mgrid[0:COTE, 0:COTE]
    d = np.hypot(yy - (COTE - 1) / 2, xx - (COTE - 1) / 2) / R_EXT
    disque = np.clip((DECOUPE - d) * R_EXT + 0.5, 0, 1)
    a[..., 3] = a[..., 3] * disque
    return Image.fromarray(a.astype(np.uint8), 'RGBA')


def dessus_de(cle):
    """La partie du motif qui chevauche le cadre, ou None."""
    if cle not in DEBORDE:
        return None
    im = Image.open(SOURCES / f'piece-{cle}.webp').convert('RGBA')
    grand = Image.new('L', (im.width * SURECH, im.height * SURECH), 0)
    for poly in DEBORDE[cle]:
        ImageDraw.Draw(grand).polygon([(x * SURECH, y * SURECH) for x, y in poly], fill=255)
    masque = grand.resize(im.size, Image.LANCZOS)
    a = np.asarray(im).copy()
    a[..., 3] = (a[..., 3].astype(np.float32) * np.asarray(masque) / 255).astype(np.uint8)
    return placer(Image.fromarray(a, 'RGBA'), cle)


def ombre_portee(dessus):
    """L'ombre que le morceau débordant jette sur l'anneau : lumière en haut à
    gauche, donc décalée en bas à droite, floue, et seulement hors du disque
    central (dedans, l'original a déjà la sienne)."""
    al = np.asarray(dessus)[..., 3].astype(np.float32) / 255
    al = ndimage.shift(al, (5, 6), order=1)
    al = ndimage.gaussian_filter(al, 3.5)
    yy, xx = np.mgrid[0:COTE, 0:COTE]
    d = np.hypot(yy - (COTE - 1) / 2, xx - (COTE - 1) / 2) / R_EXT
    hors = np.clip((d - (TROU - 0.02)) / 0.02, 0, 1)
    return 1 - 0.55 * al * hors


def piece(rgb, alpha, masque, centre, couleur, dessus=None):
    anneau = recolorier(rgb, masque, couleur)
    if dessus is not None:
        anneau = anneau * ombre_portee(dessus)[..., None]
    img = Image.fromarray(np.dstack([anneau, alpha]).clip(0, 255).astype(np.uint8), 'RGBA')
    sortie = centre.copy()
    sortie.alpha_composite(img)
    if dessus is not None:
        sortie.alpha_composite(dessus)
    return sortie


def jeton(rgb, alpha, masque, cle, couleur):
    """Une pièce complète : centre, anneau recolorié, débord éventuel."""
    return piece(rgb, alpha, masque, centre_de(cle), couleur, dessus_de(cle))


LARGEUR = 398           # l'échelle de la famille dans le jeu
PIECES_JEU = SKIN / 'pieces'


def ecrire_jeu(rgb, alpha, masque):
    """Écrit toutes les pièces du jeu : chaque motif dans chacune des couleurs,
    public/assets/skin/pieces/<motif>-<couleur>.webp. C'est le joueur qui choisit
    la couleur ; le jeu n'a plus de couleur attachée à un motif."""
    import subprocess
    from concurrent.futures import ThreadPoolExecutor

    PIECES_JEU.mkdir(exist_ok=True)
    # --seulement blanc,noir : n'écrit que ces couleurs-là (ajout d'une couleur
    # sans réécrire toutes les autres).
    seulement = None
    if '--seulement' in sys.argv:
        seulement = set(sys.argv[sys.argv.index('--seulement') + 1].split(','))
    couleurs = [(n, h) for n, h in COULEURS if seulement is None or n in seulement]
    anneaux = {}
    for nom, hexa in couleurs:
        a = recolorier(rgb, masque, hexa)
        anneaux[nom] = Image.fromarray(np.dstack([a, alpha]).clip(0, 255).astype(np.uint8), 'RGBA')

    def un_motif(cle):
        centre, dessus = centre_de(cle), dessus_de(cle)
        ombre = ombre_portee(dessus) if dessus is not None else None
        for nom, hexa in couleurs:
            anneau = anneaux[nom]
            if ombre is not None:
                a = np.asarray(anneau).astype(np.float32)
                a[..., :3] *= ombre[..., None]
                anneau = Image.fromarray(a.clip(0, 255).astype(np.uint8), 'RGBA')
            im = centre.copy()
            im.alpha_composite(anneau)
            if dessus is not None:
                im.alpha_composite(dessus)
            im = im.resize((LARGEUR, LARGEUR), Image.LANCZOS)
            dest = PIECES_JEU / f'{cle}-{nom}.webp'
            tmp = dest.with_suffix('.tmp.png')
            im.save(tmp)
            subprocess.run(['cwebp', '-quiet', '-q', '90', '-alpha_q', '100', str(tmp), '-o', str(dest)],
                           check=True)
            tmp.unlink()
        return cle

    cles = sorted(f.stem[len('piece-'):] for f in SOURCES.glob('piece-*.webp'))
    with ThreadPoolExecutor(max_workers=6) as pool:
        for cle in pool.map(un_motif, cles):
            print('  ', cle)
    total = sum(f.stat().st_size for f in PIECES_JEU.glob('*.webp'))
    print(f'{len(cles)} motifs x {len(couleurs)} couleurs écrites, {total / 1e6:.1f} Mo en tout')


def main():
    rgb, alpha = charger_anneau()
    masque = masque_email(rgb, alpha)

    # La couleur « vue » de chaque émail, relevée comme couleur-cerclage.py :
    # médiane de la couronne. C'est elle que le jeu peindra dans la roue et la courbe.
    c = (COTE - 1) / 2
    yy, xx = np.mgrid[0:COTE, 0:COTE]
    d = np.hypot(yy - c, xx - c) / R_EXT
    couronne = (d >= 0.78) & (d <= 0.94) & (alpha > 200)
    print('nom        visé     relevé')
    for nom, hexa in COULEURS:
        px = recolorier(rgb, masque, hexa)[couronne]
        med = np.median(px, axis=0).astype(int)
        print(f'{nom:10s} {hexa}  #%02x%02x%02x' % tuple(med))

    if '--ecrire' in sys.argv:
        ecrire_jeu(rgb, alpha, masque)

    S, marge = 300, 14
    fond_bois = (214, 190, 150, 255)

    # Planche 1 : une pièce, les quatorze couleurs, sur deux rangées de sept.
    crane = centre_de('crane')
    vignettes = [piece(rgb, alpha, masque, crane, h).resize((S, S), Image.LANCZOS)
                 for _, h in COULEURS]
    fond = Image.new('RGBA', (7 * (S + marge) + marge, 2 * (S + marge) + marge), fond_bois)
    for i, im in enumerate(vignettes):
        fond.alpha_composite(im, (marge + (i % 7) * (S + marge), marge + (i // 7) * (S + marge)))
    fond.convert('RGB').save(SORTIE)
    print('écrit', SORTIE.relative_to(RACINE))

    # Planche 2 : tous les motifs, l'original à gauche, le nouvel anneau à droite.
    S = 260
    cles = sorted(f.stem[len('piece-'):] for f in SOURCES.glob('piece-*.webp'))
    rangs = (len(cles) + 2) // 3
    fond = Image.new('RGBA', (3 * (2 * S + 3 * marge) + marge, rangs * (S + marge) + marge), fond_bois)
    for i, cle in enumerate(cles):
        x = marge + (i % 3) * (2 * S + 3 * marge)
        y = marge + (i // 3) * (S + marge)
        orig = Image.open(SOURCES / f'piece-{cle}.webp').convert('RGBA').resize((S, S), Image.LANCZOS)
        neuf = jeton(rgb, alpha, masque, cle, COULEURS[i % len(COULEURS)][1]).resize((S, S), Image.LANCZOS)
        fond.alpha_composite(orig, (x, y))
        fond.alpha_composite(neuf, (x + S + 4, y))
    fond.convert('RGB').save(TOUS)
    print('écrit', TOUS.relative_to(RACINE))


if __name__ == '__main__':
    sys.exit(main())
