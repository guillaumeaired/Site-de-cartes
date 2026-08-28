#!/usr/bin/env python3
"""Detoure le gouvernail de la roue de tirage et le recentre sur son moyeu.

La planche arrive avec un faux fond transparent : le damier gris est PEINT
dans l'image (alpha plein partout), et un simple `convert RGBA` laisserait un
carre clair derriere la roue. Le script fait donc trois choses, toutes a
partir de ce qu'il MESURE :

1. **Il detoure.** Le fond est un gris tres clair et desature (~245, ecart
   entre canaux < 14) ; le laiton et le bois, eux, sont soit sombres soit
   satures. Les regions claires sont classees par taille : le fond exterieur
   (~1,08 M de pixels) et les huit jours entre les rayons (~13 k chacun)
   partent, les 126 eclats de lumiere de moins de 300 px restent. C'est ce
   seuil, et non une liste de coordonnees, qui rend le script rejouable si la
   planche est regeneree.

2. **Il recentre sur le MOYEU**, pas sur le milieu du fichier. C'est ce point
   qui doit rester immobile quand la roue tourne : un axe decale de dix
   pixels et la roue se met a se dandiner. Le moyeu se releve sur les
   poignees — la ligne la plus large donne son abscisse, la colonne la plus
   large son ordonnee — puis se confirme au barycentre de la roue seule
   (fleche exclue), qui est symetrique d'ordre 8.

3. **Il mesure la fleche.** La roue est livree fleche comprise, et c'est elle
   qui designe le joueur : le JS doit savoir de combien de degres elle est
   deja tournee au repos, sinon elle s'arrete a cote. L'angle et les deux
   rayons sont affiches a la fin, a reporter dans skullking.js / skullking.css.

Le carre de sortie est cale sur la POINTE de la fleche : elle affleure le
bord, la roue tourne donc dans une boite qui ne la rogne jamais, quel que
soit l'angle.
"""
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

RACINE = Path(__file__).resolve().parent.parent
SOURCE = RACINE / 'public/assets/skin/src/volant-sk.png'
SORTIE = RACINE / 'public/assets/skin/roue-volant.webp'

# Le fond : clair ET desature. Les deux conditions comptent — le laiton monte
# haut en luminance mais reste jaune, il ne passe donc pas la seconde.
FOND_MIN = 222
FOND_ECART = 14
# En dessous, c'est un eclat de lumiere dans le decor, pas un jour du fond.
AIRE_MIN = 300
# Un peu d'air autour de la pointe : l'ombre portee du CSS et le lissage du
# bord ont besoin de deux ou trois pixels pour ne pas etre coupes net.
MARGE = 1.015
# La roue s'affiche autour de 340 px : au-dela de 1000 px de cote on paie des
# kilo-octets pour des pixels que personne ne verra, meme sur un ecran dense.
COTE_MAX = 1000


def masque_objet(rgb):
    """Vrai la ou il y a du gouvernail."""
    clair = (rgb.min(axis=2) > FOND_MIN) & ((rgb.max(axis=2) - rgb.min(axis=2)) < FOND_ECART)
    etiquettes, n = ndimage.label(clair)
    aires = ndimage.sum(np.ones_like(etiquettes), etiquettes, range(1, n + 1))
    fond = np.isin(etiquettes, np.nonzero(aires > AIRE_MIN)[0] + 1)
    return ~fond


def etendue(masque):
    """(largeur, indice, debut, fin) de la ligne la plus large."""
    best = None
    for i in range(masque.shape[0]):
        k = np.nonzero(masque[i])[0]
        if not len(k):
            continue
        largeur = k.max() - k.min()
        if best is None or largeur > best[0]:
            best = (largeur, i, int(k.min()), int(k.max()))
    return best


def centre_du_moyeu(objet):
    """Le point autour duquel la roue tourne.

    Les poignees opposees donnent une premiere estimation ; le barycentre de
    la roue prive de sa fleche la confirme. Les deux sont a quelques pixels
    l'une de l'autre — on prend leur milieu, ce qui absorbe l'asymetrie que
    la fleche introduit d'un cote et le rendu de l'autre.
    """
    _, _, x0, x1 = etendue(objet)
    _, _, y0, y1 = etendue(objet.T)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rayon_roue = (x1 - x0) / 2

    ys, xs = np.nonzero(objet)
    dedans = (xs - cx) ** 2 + (ys - cy) ** 2 <= (rayon_roue * 1.02) ** 2
    return (cx + xs[dedans].mean()) / 2, (cy + ys[dedans].mean()) / 2, rayon_roue


def main():
    image = Image.open(SOURCE).convert('RGBA')
    pixels = np.array(image).astype(np.int16)
    objet = masque_objet(pixels[:, :, :3])

    cx, cy, rayon_roue = centre_du_moyeu(objet)

    # La pointe de la fleche est le point le plus eloigne du moyeu : elle
    # depasse les poignees, c'est meme a ca qu'on la reconnait.
    ys, xs = np.nonzero(objet)
    loin = (xs - cx) ** 2 + (ys - cy) ** 2
    pointe = int(np.argmax(loin))
    px, py = int(xs[pointe]), int(ys[pointe])
    rayon_pointe = math.hypot(px - cx, py - cy)
    # 0 degre en haut, sens horaire : la convention de toutes les rotations du
    # jeu (roue, etiquettes, couronne du pli).
    angle = math.degrees(math.atan2(px - cx, -(py - cy))) % 360

    # Le bord se lisse d'un pixel : le detourage est binaire, et une decoupe
    # nette laisse un liseré en escalier des que la roue tourne.
    alpha = ndimage.gaussian_filter(objet.astype(np.float32), 0.8)
    alpha = np.clip((alpha - 0.35) / 0.4, 0, 1)
    sortie = pixels.copy()
    sortie[:, :, 3] = (alpha * 255).astype(np.int16)

    # Carre cale sur la pointe, moyeu au centre exact.
    demi = int(math.ceil(rayon_pointe * MARGE))
    cote = demi * 2
    toile = Image.new('RGBA', (cote, cote), (0, 0, 0, 0))
    toile.paste(
        Image.fromarray(sortie.astype(np.uint8), 'RGBA'),
        (demi - int(round(cx)), demi - int(round(cy))),
    )

    if cote > COTE_MAX:
        toile = toile.resize((COTE_MAX, COTE_MAX), Image.LANCZOS)

    brut = SORTIE.with_suffix('.png')
    toile.save(brut)
    subprocess.run(['cwebp', '-q', '92', '-alpha_q', '100', str(brut), '-o', str(SORTIE)], check=True)
    brut.unlink()

    print(f'{SORTIE.name} : {toile.width}x{toile.height}, {SORTIE.stat().st_size // 1024} Ko')
    print(f'  moyeu releve a ({cx:.1f}, {cy:.1f}) dans la planche d\'origine')
    print(f'  angle de la fleche au repos : {angle:.2f} deg (0 = haut, horaire)')
    print(f'  rayon de la pointe   : {rayon_pointe:.1f} px = {rayon_pointe / demi:.4f} du demi-cote')
    print(f'  rayon des poignees   : {rayon_roue:.1f} px = {rayon_roue / demi:.4f} du demi-cote')


if __name__ == '__main__':
    main()
