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
    # Une seule rangée de cinq, sur un drap bleu.
    'extras-extras.png': [
        'classique-kraken',     # les tentacules sur le navire
        'classique-butin',      # les piles de doublons dans la cale
        'classique-baleine',    # la Baleine blanche
        'classique-raie',       # la Raie Tachetée et son cerf-volant
        'classique-tigresse',   # La Tigresse
    ],
}


def decouper(source, noms):
    chemin = SRC / source
    if not chemin.exists():
        print(f'   absent : {source}', file=sys.stderr)
        return 1

    import numpy as np
    a = np.asarray(Image.open(chemin).convert('RGB')).astype(np.float32)
    boites = list(_num.grille(a))
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
