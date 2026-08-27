#!/usr/bin/env python3
"""Recompose le medaillon Bouteille a partir du medaillon Sabre.

`piece-bouteille.webp` etait un second gouvernail : la meme illustration que
`piece-barre`, au cerclage pres. Deux joueurs pouvaient donc porter la meme
figure. Plutot que de repeindre un medaillon a partir de rien, on emprunte
son CHASSIS a un medaillon existant -- le meme laiton, les memes clous, la
meme patine, donc la meme lumiere que les huit autres -- et on n'en refait
que deux choses : la figure gravee et la couleur de l'email.

Le Sabre est le donneur : son disque est le plus nu des neuf, et sa lame
etroite laisse au bronze assez de tour libre pour qu'on le reconstruise par
son profil radial (voir disque_nu).

Le script est idempotent : il lit piece-sabre.webp et ecrase
piece-bouteille.webp, jamais l'inverse. On peut donc le relancer.
"""
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

RACINE = Path(__file__).resolve().parent.parent
SKIN = RACINE / 'public/assets/skin'
DONNEUR = SKIN / 'piece-sabre.webp'
SORTIE = SKIN / 'piece-bouteille.webp'

# Vert bouteille : franchement plus froid que l'olive du Voilier (#2b4807,
# teinte ~85 deg), sinon les deux verts se confondent dans la roue.
VERT = (0x0e, 0x3f, 0x2b)

SS = 4  # sur-echantillonnage du trace de la bouteille


def rayon(forme):
    h, w = forme[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    return np.sqrt((yy - (h - 1) / 2) ** 2 + (xx - (w - 1) / 2) ** 2) / (min(h, w) / 2)


def disque(r):
    """Footprint circulaire pour le filtre median."""
    k = 2 * r + 1
    yy, xx = np.mgrid[0:k, 0:k]
    return (np.sqrt((yy - r) ** 2 + (xx - r) ** 2) <= r + 0.5)


def disque_nu(rgb, d, r_max=0.760):
    """Reconstruit le disque de bronze SANS sa figure gravee.

    On ne cherche pas a effacer la gravure : on ne la regarde pas. Pour chaque
    rayon, on prend la MEDIANE des couleurs sur tout le tour. A un rayon
    donne, la gravure n'occupe jamais plus d'un tiers du cercle, donc la
    mediane tombe sur le bronze et l'ignore -- exactement le raisonnement qui
    sert a relever la couleur des cerclages.

    Ca rend un disque parfaitement circulaire, donc plus plat que l'original
    dont la lumiere vient d'en haut a gauche. On lui rend cette asymetrie
    ensuite, mesuree sur le donneur lui-meme.
    """
    dm = d < r_max
    R = min(rgb.shape[:2]) / 2
    pas = 1.0 / R                       # un anneau par pixel de rayon
    idx = np.clip((d / pas).astype(int), 0, int(r_max / pas))
    n_anneaux = int(r_max / pas) + 1

    profil = np.zeros((n_anneaux, 3), dtype=np.float32)
    for k in range(n_anneaux):
        px = rgb[dm & (idx == k)]
        profil[k] = np.median(px, axis=0) if len(px) else profil[max(k - 1, 0)]
    # le profil est bruite anneau par anneau : on le lisse le long du rayon
    for c in range(3):
        profil[:, c] = ndimage.gaussian_filter1d(profil[:, c], 3.0)

    base = profil[np.clip(idx, 0, n_anneaux - 1)]

    # asymetrie de lumiere : de combien le quart haut-gauche est-il plus clair
    # que le quart bas-droit, une fois le profil radial retire ?
    h, w = rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    u = ((xx - (w - 1) / 2) + (yy - (h - 1) / 2)) / (R * 1.414)   # -1 (HG) .. +1 (BD)
    ecart = rgb.mean(2) - base.mean(2)
    amp = (np.median(ecart[dm & (u < -0.25)]) - np.median(ecart[dm & (u > 0.25)])) / 2
    disque_eclaire = base + (-u * amp)[..., None]

    # un grain tres doux : a 22 px d'affichage il ne se voit pas, mais sans
    # lui le bronze est un degrade trop propre pour la planche peinte.
    graine = np.random.default_rng(11)
    grain = ndimage.gaussian_filter(graine.normal(0, 1, rgb.shape[:2]), 1.6) * 5.0

    out = np.where(dm[..., None], np.clip(disque_eclaire + grain[..., None], 0, 255), rgb)
    # raccord au bord : on fond vers l'original sur les derniers pixels, pour
    # ne pas laisser une couture contre l'anneau de laiton
    t = np.clip((d - (r_max - 0.03)) / 0.03, 0, 1)[..., None]
    return out * (1 - t) + rgb * t


def silhouette_bouteille(taille, r_disque=0.66):
    """Masque de la bouteille, tracee par son demi-profil puis miroir.

    Le profil est en unites de HAUTEUR de bouteille, pas de largeur d'image :
    c'est ce qui garantit qu'elle reste une bouteille quand on change sa
    taille. Silhouette de bouteille de rhum -- trapue, environ 3 pour 1 --
    plutot que de bordeaux : elle doit se lire a 22 px dans le registre.

    Un profil plutot qu'un chemin dessine a la main : les epaules sont la
    seule courbe delicate, et une interpolation en cosinus les rend d'un
    coup, symetriques et sans point d'inflexion visible.
    """
    PALIERS = [
        # (y de fin, demi-largeur a ce y, 'droit' ou 'courbe')
        (0.030, 0.062, 'droit'),   # bague du goulot
        (0.055, 0.044, 'courbe'),  # gorge sous la bague
        (0.330, 0.050, 'droit'),   # col
        (0.480, 0.168, 'courbe'),  # epaules, transition longue
        (0.955, 0.168, 'droit'),   # corps
        (1.000, 0.152, 'courbe'),  # pied
    ]
    n = 500
    ys = np.linspace(0, 1, n)
    w = np.empty(n)
    y0, w0 = 0.0, PALIERS[0][1]
    bornes = []
    for y1, w1, mode in PALIERS:
        bornes.append((y0, y1, w0, w1, mode))
        y0, w0 = y1, w1
    for i, y in enumerate(ys):
        for y0, y1, w0, w1, mode in bornes:
            if y <= y1 or y1 == 1.0:
                u = 0 if y1 <= y0 else np.clip((y - y0) / (y1 - y0), 0, 1)
                w[i] = w0 + (w1 - w0) * ((1 - np.cos(u * np.pi)) / 2 if mode == 'courbe' else u)
                break

    # la bouteille se cadre sur le disque interieur, pas sur l'image : sinon
    # elle recouvre le cerclage (ce qui etait le defaut du premier essai).
    diametre = 2 * r_disque * (taille / 2)
    H = diametre * 0.86
    cx, cy0 = taille / 2, taille / 2 - H / 2 + taille * 0.008
    gauche = [(cx - w[i] * H, cy0 + ys[i] * H) for i in range(n)]
    droite = [(cx + w[i] * H, cy0 + ys[i] * H) for i in range(n - 1, -1, -1)]

    im = Image.new('L', (taille * SS, taille * SS), 0)
    ImageDraw.Draw(im).polygon([(x * SS, y * SS) for x, y in gauche + droite], fill=255)
    return np.asarray(im.resize((taille, taille), Image.LANCZOS)).astype(np.float32) / 255


def graver(rgb, masque, laiton, biseau=13.0):
    """Pose la figure en relief de laiton sur le fond.

    Le relief est la somme de deux hauteurs : un BISEAU de bord (la distance
    au contour, plafonnee) qui donne l'arete vive, et un BOMBE d'ensemble
    sans lequel l'interieur reste un aplat.

    Trois choses separent un relief de laiton d'une silhouette beige, et il
    faut les trois : une plage de valeurs LARGE (l'ombre du bas descend tres
    bas, l'arete eclairee monte au blanc), un SPECULAIRE etroit sur l'arete,
    et un CONTOUR sombre qui borde la figure -- c'est lui qui la fait
    paraitre creusee dans le bronze plutot que collee dessus.
    """
    dedans = masque > 0.5
    dist = ndimage.distance_transform_edt(dedans)
    biseau_h = np.clip(dist / biseau, 0, 1) ** 0.7
    bombe = dist / max(dist.max(), 1e-6)
    haut = ndimage.gaussian_filter(0.72 * biseau_h + 0.45 * bombe, 1.8)

    gy, gx = np.gradient(haut * biseau * 1.30)
    norme = np.sqrt(gx ** 2 + gy ** 2 + 1)
    nx, ny, nz = -gx / norme, -gy / norme, 1 / norme
    lum = np.array([-0.52, -0.70, 0.49]); lum /= np.linalg.norm(lum)

    diffus = np.clip(nx * lum[0] + ny * lum[1] + nz * lum[2], 0, 1)
    spec = diffus ** 30

    fond = ndimage.gaussian_filter(rgb.mean(2), 26)
    eclairage = np.clip(fond / max(np.median(fond[dedans]), 1e-6), 0.62, 1.45)

    teinte = np.array(laiton, dtype=np.float32)
    figure = teinte * (0.16 + 1.28 * diffus)[..., None] * eclairage[..., None]
    figure += 255 * (0.85 * spec)[..., None]

    # contour : les 3 px interieurs du bord, assombris. Le laiton peint des
    # huit autres medaillons a ce liseré ; sans lui la figure flotte.
    bord = np.clip(1 - dist / 3.5, 0, 1) * dedans
    figure *= (1 - 0.55 * bord)[..., None]

    ombre = ndimage.gaussian_filter(np.roll(np.roll(masque, 8, 0), 7, 1), 6)
    contact = np.clip(ndimage.gaussian_filter(masque, 3) - masque, 0, 1)
    out = rgb * (1 - 0.50 * ombre)[..., None] * (1 - 0.50 * contact)[..., None]

    a = np.clip(masque, 0, 1)[..., None]
    return np.clip(out * (1 - a) + figure * a, 0, 255)


def repeindre_email(rgb, d, cible, r0=0.735, r1=0.905):
    """Remplace la teinte de l'email sans toucher aux clous de laiton.

    L'email du Sabre est violet (teinte ~305 deg), les clous sont dores
    (~40 deg) : la teinte suffit a les separer, on n'a pas besoin de masque
    dessine. On garde la VARIATION de clarte de l'original -- c'est elle qui
    porte le vernis et les reflets -- et on n'impose que la couleur.
    """
    mx = rgb.max(2); mn = rgb.min(2)
    v = mx / 255
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)

    r_, v_, b_ = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    c = mx - mn
    t = np.zeros_like(mx)
    with np.errstate(invalid='ignore', divide='ignore'):
        t = np.where(mx == r_, ((v_ - b_) / c) % 6,
            np.where(mx == v_, (b_ - r_) / c + 2, (r_ - v_) / c + 4)) * 60
    t = np.where(c == 0, 0, t % 360)

    email = (d >= r0) & (d <= r1) & (s > 0.22) & (t > 250) & (t < 350)
    email = ndimage.binary_closing(email, disque(3))
    doux = ndimage.gaussian_filter(email.astype(np.float32), 1.2)[..., None]

    # la clarte de l'original, recentree sur celle de la couleur visee
    cible = np.array(cible, dtype=np.float32)
    vref = np.median(v[email]) if email.any() else 0.5
    gain = np.clip(v / max(vref, 1e-3), 0.45, 1.9)[..., None]
    peint = np.clip(cible * gain, 0, 255)
    return rgb * (1 - doux) + peint * doux


def main():
    src = Image.open(DONNEUR).convert('RGBA')
    a = np.asarray(src).astype(np.float32)
    rgb, alpha = a[..., :3].copy(), a[..., 3]
    d = rayon(a.shape)
    taille = a.shape[0]

    # le laiton de la figure : releve sur la lame du Sabre, donc exactement
    # le metal des huit autres gravures
    lame = (d < 0.55) & (rgb.max(2) > 150)
    laiton = np.median(rgb[lame], axis=0) if lame.sum() > 200 else np.array([176, 132, 60.0])

    rgb = disque_nu(rgb, d)
    masque = silhouette_bouteille(taille)[:a.shape[0], :a.shape[1]]
    rgb = graver(rgb, masque, laiton)
    rgb = repeindre_email(rgb, d, VERT)

    out = np.dstack([np.clip(rgb, 0, 255), alpha]).astype(np.uint8)
    im = Image.fromarray(out, 'RGBA')

    # meme encodage que le reste de la planche (voir traiter-assets.py)
    tmp = SORTIE.with_suffix('.tmp.png')
    im.save(tmp)
    subprocess.run(['cwebp', '-quiet', '-q', '88', '-alpha_q', '100',
                    str(tmp), '-o', str(SORTIE)], check=True)
    tmp.unlink()

    print('laiton grave : #%02x%02x%02x' % tuple(laiton.astype(int)))
    print(f'ecrit : {SORTIE.relative_to(RACINE)}  {SORTIE.stat().st_size / 1024:.0f} Ko')
    print("penser a relancer : python3 briefs/couleur-cerclage.py --ecrire")


if __name__ == '__main__':
    main()
