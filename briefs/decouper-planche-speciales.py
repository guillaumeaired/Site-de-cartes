#!/usr/bin/env python3
"""Découpe les planches de cartes spéciales classiques en cartes individuelles.

Même découpe que les familles numérotées — d'où la réutilisation directe de
`grille()` et `carte()` de decouper-planche-numerotees.py. Seule différence :
les cases ne portent pas des chiffres de 1 à 14 mais des sujets, donc la
sortie est nommée à la main, case par case, en lecture (haut->bas puis
gauche->droite).

Le repérage ne suppose rien du fond : il isole ce qui n'est PAS le fond,
échantillonné dans les marges latérales. Peu importe donc que la première
planche soit posée sur un plan de bois et la seconde sur un drap bleu.

Une case peut être nommée None : elle est alors sautée, pas retirée de la
liste, sans quoi les cases suivantes se décaleraient d'un cran.
"""
import importlib.util
import subprocess
import sys
from pathlib import Path

from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / 'public/assets/skin/src'
OUT = RACINE / 'public/assets/cards'

_s = importlib.util.spec_from_file_location('num', RACINE / 'briefs/decouper-planche-numerotees.py')
_num = importlib.util.module_from_spec(_s)
_s.loader.exec_module(_num)

# planche -> les cases, en lecture. Le préfixe `classique-` dit le paquet
# auquel elles appartiennent : le site en propose deux, celui-ci et celui des
# pirates perso (anto/mams/guigui/pablo), qui n'habille que des Pirates et
# emprunte tout le reste à celui-ci.
PLANCHES = {
    # Deux rangées de cinq sur un plan de bois. Dix cases pour huit cartes :
    # la seconde Rosie est une autre femme et le second Will un doublon,
    # aucun des deux n'a de carte où aller.
    'extra-cards-sk.png': [
        'classique-fuite',      # le navire à la voile, au couchant
        'classique-skullking',  # le capitaine à la barre, fond noir
        'classique-sirene-1',   # Sirena, à la boule de cristal
        'classique-sirene-2',   # Alyra, à l'étoile de mer
        'classique-will',       # Will le Bandit
        'classique-harry',      # Harry le Géant
        'classique-rosie',      # Rosie D'Laney
        'classique-rascal',     # Rascal le Flambeur
        None,                   # seconde Rosie — aucune carte où l'employer
        None,                   # Will en double
    ],
    # L'extension, deux rangées de cinq sur drap bleu. Une seule case en
    # sort : le reste de la planche est soit déjà peint ailleurs (la Raie),
    # soit repris en mieux par extension-2-sk (les quatre du haut), soit une
    # variante non retenue (l'autre singe, les deux autres canons).
    'extension-sk.png': [
        None,                   # Coffre de Davy Jones — repris sur la planche 2
        None,                   # Mat le Forban — repris sur la planche 2
        None,                   # Mary Thorne — reprise sur la planche 2
        None,                   # Marcher sur la Planche — repris sur la planche 2
        'classique-salve',      # Dernière Salve : la bordée tirée du navire
        None,                   # la Raie Tachetée, déjà peinte sur extras-extras
        'classique-joker',      # Joker/Wild 15 : le singe couronné, son 15 peint
        None,                   # canon dans la cale — variante non retenue
        None,                   # canon au ras de l'eau — variante non retenue
        None,                   # singe à la boussole — variante non retenue
    ],
    # Les quatre mêmes sujets que la rangée du haut de la planche
    # précédente, repeints. Ce sont ceux-là qui entrent dans le jeu.
    'extension-2-sk.png': [
        'classique-davyjones',  # le noyé aux cheveux d'algues
        'classique-forban',     # Mat le Forban
        None,                   # Mary Thorne — remplacée par mary-thorne.png
        'classique-planche',    # Marcher sur la Planche : les requins sous la coque
    ],
    # Mary Thorne repeinte, livrée seule. Elle remplace la case de la planche
    # d'extension : même sujet, mêmes couleurs, un dessin plus net.
    'mary-thorne.png': ['classique-mary'],
    # Une seule rangée de cinq, sur un drap bleu.
    'extras-extras.png': [
        'classique-kraken',     # les tentacules sur le navire
        'classique-butin',      # les piles de doublons dans la cale
        'classique-baleine',    # la Baleine blanche
        'classique-raie',       # la Raie Tachetée et son cerf-volant
        'classique-tigresse',   # La Tigresse
    ],
}


# Sources livrées en carte seule plutôt qu'en planche : un seul sujet, posé
# sur un carré de couleur, lui-même sur la page blanche de l'export. La
# grille de `_num` échantillonne le fond dans les marges latérales — elle y
# trouverait le blanc de la page et ramènerait le carré de couleur entier,
# carte et fond confondus. On recadre donc d'abord sur le carré.
CARTE_SEULE = {'mary-thorne.png'}


def recadrer_sur_le_champ(a):
    """Ote la page blanche autour du carré de couleur qui porte la carte."""
    import numpy as np
    ring = np.concatenate([a[:4].reshape(-1, 3), a[-4:].reshape(-1, 3),
                           a[:, :4].reshape(-1, 3), a[:, -4:].reshape(-1, 3)])
    page = np.median(ring, axis=0)
    dedans = np.linalg.norm(a - page, axis=2) > 40
    ys, xs = np.nonzero(dedans)
    return a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def grille(a):
    """Les cartes de la planche, repérées par leur liseré blanc.

    `_num.grille` cherche ce qui n'est PAS le fond. Ça marche tant que le
    fond ne ressemble à rien de ce qui est peint sur les cartes — vrai pour
    un plan de bois, faux pour un drap bleu : la Raie Tachetée est une carte
    bleue sur un fond bleu, et ses colonnes centrales tombaient sous le
    seuil. Elle sortait à 216 px de large au lieu de 290, donc étirée d'un
    tiers et rognée à droite.

    Les rangées se repèrent toujours par le fond — sur une bande entière la
    différence est franche, quelle que soit la carte. Les colonnes, elles,
    se repèrent par le LISERÉ BLANC : chaque carte en porte un sur ses
    quatre bords, aucun fond de planche n'est blanc, et une colonne de carte
    en contient donc forcément quelques rangs (le haut et le bas de la
    carte). Le sujet peint n'entre plus en jeu.
    """
    import numpy as np
    marge = a.shape[0] // 5
    fond = np.median(np.concatenate([a[marge:, :8].reshape(-1, 3),
                                     a[marge:, -8:].reshape(-1, 3)]), axis=0)
    hors = np.linalg.norm(a - fond, axis=2) > 60
    lignes = _num.segments(hors[:, 20:-20].mean(axis=1), 0.30, 100)
    lignes = [(y0, y1) for y0, y1 in lignes if y1 - y0 > 200]   # écarte le titre
    for y0, y1 in lignes:
        blanc = a[y0:y1].min(axis=2) > 200
        for x0, x1 in _num.segments(blanc.mean(axis=0), 0.02, 60):
            yield x0, y0, x1, y1, fond


def decouper(source, noms):
    chemin = SRC / source
    if not chemin.exists():
        print(f'   absent : {source}', file=sys.stderr)
        return 1

    import numpy as np
    a = np.asarray(Image.open(chemin).convert('RGB')).astype(np.float32)
    if source in CARTE_SEULE:
        a = recadrer_sur_le_champ(a)
    boites = list(grille(a))
    if len(boites) != len(noms):
        print(f'   {source} : {len(boites)} cartes repérées au lieu de {len(noms)}',
              file=sys.stderr)
        return 1

    for nom, boite in zip(noms, boites):
        if nom is None:
            continue
        im = _num.carte(a, *boite)
        im = im.resize((int(round(_num.HAUTEUR * _num.RATIO)), _num.HAUTEUR), Image.LANCZOS)
        dest = OUT / f'{nom}.webp'
        tmp = dest.with_suffix('.tmp.png')
        im.save(tmp)
        subprocess.run(['cwebp', '-quiet', '-q', '86', str(tmp), '-o', str(dest)], check=True)
        tmp.unlink()
        print(f'  {nom + ".webp":26} {im.size[0]}x{im.size[1]} {dest.stat().st_size / 1024:5.0f} Ko')
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
