#!/usr/bin/env python3
"""Découpe la planche des cartes spéciales classiques en cartes individuelles.

Même planche, même lumière, même découpe que les familles numérotées — d'où
la réutilisation directe de `grille()` et `carte()` de
decouper-planche-numerotees.py. Seule différence : les cases ne portent pas
des chiffres de 1 à 14 mais des personnages, donc la sortie est nommée à la
main, case par case, en lecture (haut->bas, gauche->droite).

La planche en compte dix ; le paquet n'en retient que huit. Les deux doublons
(un second Will identique, une seconde Rosie qui est une autre femme) n'ont
pas de carte où aller : la Fuite est la même pour ses cinq exemplaires et
Juanita Jade reste sans illustration classique. Ils sont donc nommés None et
sautés — pas supprimés de la liste, sans quoi les cases suivantes se
décaleraient d'un cran.
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

PLANCHE = 'extra-cards-sk.png'

# Les dix cases, en lecture. Le préfixe `classique-` dit le paquet auquel
# elles appartiennent : le site en propose deux, celui-ci et celui des
# pirates perso (anto/mams/guigui/pablo), qui n'habille que les cinq Pirates
# et emprunte tout le reste à celui-ci.
NOMS = [
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
]


def main():
    chemin = SRC / PLANCHE
    if not chemin.exists():
        print(f'   absent : {PLANCHE}', file=sys.stderr)
        return 1

    import numpy as np
    a = np.asarray(Image.open(chemin).convert('RGB')).astype(np.float32)
    boites = list(_num.grille(a))
    if len(boites) != len(NOMS):
        print(f'   {PLANCHE} : {len(boites)} cartes repérées au lieu de {len(NOMS)}',
              file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    for nom, boite in zip(NOMS, boites):
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


if __name__ == '__main__':
    sys.exit(main())
