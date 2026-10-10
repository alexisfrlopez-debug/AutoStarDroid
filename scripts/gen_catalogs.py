#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_catalogs.py — Générateur des catalogues astronomiques TS pour AutoStar Droid (Task 6-b).

Télécharge des jeux de données publics fiables, les transforme et génère :
  - AutoStarDroid/src/services/catalog/types.ts        (type commun SkyObject)
  - AutoStarDroid/src/services/catalog/messier.ts      (110 objets M1..M110)
  - AutoStarDroid/src/services/catalog/ngc.ts          (NGC célèbres NON-Messier)
  - AutoStarDroid/src/services/catalog/stars.ts        (étoiles brillantes nommées)

SOURCES (unités vérifiées empiriquement à chaque exécution) :
  * OpenNGC  — github.com/mattiaverga/OpenNGC (CC-BY-SA-4.0), fichiers NGC.csv + addendum.csv
      RA = 'HH:MM:SS.SS' (HEURES, à convertir ×15), Dec = '+/-DD:MM:SS.SS' (degrés)
      Colonnes utiles : Name;Type;RA;Dec;Const;MajAx(arcmin);B-Mag;V-Mag;M(Messier);Common names
      L'addendum contient M40 (Winnecke 4) et M45 (Pleiades, 'Mel022') qui n'ont pas de n° NGC/IC.
  * HYG v4.4 — codeberg.org/astronexus/hyg (CC-BY-SA-4.0), hyg_v44.csv
      ra = EN HEURES décimales (à convertir ×15), dec = degrés décimaux
      Colonnes utiles : proper(nom propre IAU), bayer('Alp'), con('CMa'), flam('80'), mag, var/var_max
  * d3-celestial — github.com/ofrohn/d3-celestial, data/stars.6.json + data/starnames.json
      coordinates = [RA_degrés, Dec_degrés] DÉJÀ EN DEGRÉS (vérifié : Sirius 101.2872/-16.7161).
      Sert uniquement de contre-vérification croisée des coordonnées d'étoiles (par n° HIP).

Aucune donnée sensible : uniquement des URLs publiques. Cache local dans scripts/catalog_cache/.
"""
import csv
import gzip
import io
import json
import math
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

# ------------------------------------------------------------------ chemins
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # racine du dépôt
CACHE = os.path.join(ROOT, "scripts", "catalog_cache")
OUTDIR = os.path.join(ROOT, "src", "services", "catalog")
GEN_DATE = datetime.now(timezone.utc).strftime("%Y-%m-%d")

URLS = {
    "openngc_ngc": ["https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv"],
    "openngc_add": ["https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/addendum.csv"],
    "hyg": ["https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz"],
    "stars6": ["https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/stars.6.json"],
    "starnames": ["https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/starnames.json"],
    "messier_d3": ["https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/messier.json"],
}

# ------------------------------------------------------------------ utilitaires réseau / cache
def fetch(key):
    """Télécharge (si absent du cache) et retourne le contenu texte du fichier."""
    os.makedirs(CACHE, exist_ok=True)
    ext = ".gz" if key == "hyg" else ""
    path = os.path.join(CACHE, key + ext)
    if not (os.path.exists(path) and os.path.getsize(path) > 500):
        last_err = None
        for url in URLS[key]:
            try:
                print(f"[dl] {key} <- {url}")
                req = urllib.request.Request(url, headers={"User-Agent": "AutoStarDroid-catalog-gen/1.0"})
                with urllib.request.urlopen(req, timeout=180) as resp, open(path, "wb") as f:
                    f.write(resp.read())
                last_err = None
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                print(f"[dl] échec : {e}")
        if last_err:
            raise RuntimeError(f"Téléchargement impossible pour {key}: {last_err}")
    if key == "hyg":
        with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
            return f.read()
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

# ------------------------------------------------------------------ parsing coordonnées
def hms_to_deg(s):
    """'HH:MM:SS.SS' (heures) -> degrés décimaux."""
    s = s.strip()
    m = re.match(r"^(\d+):(\d+):([\d.]+)$", s)
    if not m:
        raise ValueError(f"RA inattendu: {s!r}")
    h, mi, sec = int(m.group(1)), int(m.group(2)), float(m.group(3))
    deg = (h + mi / 60.0 + sec / 3600.0) * 15.0
    if not (0.0 <= deg < 360.0):
        raise ValueError(f"RA hors bornes: {deg} ({s})")
    return deg

def dms_to_deg(s):
    """'+/-DD:MM:SS.SS' (degrés) -> degrés décimaux signés."""
    s = s.strip()
    m = re.match(r"^([+-])(\d+):(\d+):([\d.]+)$", s)
    if not m:
        raise ValueError(f"Dec inattendu: {s!r}")
    sign = -1.0 if m.group(1) == "-" else 1.0
    d, mi, sec = int(m.group(2)), int(m.group(3)), float(m.group(4))
    deg = sign * (d + mi / 60.0 + sec / 3600.0)
    if not (-90.0 <= deg <= 90.0):
        raise ValueError(f"Dec hors bornes: {deg} ({s})")
    return deg

def parse_mag(s):
    """Parse une magnitude '8.15', '4.00', '' -> float ou None."""
    if not s:
        return None
    m = re.match(r"^-?\d+(\.\d+)?", s.strip())
    return float(m.group(0)) if m else None

def norm_constel(c):
    """'And' -> 'AND', 'Se1'/'Se2' (Serpens Caput/Cauda OpenNGC) -> 'SER'."""
    c = (c or "").strip().upper()
    return "SER" if c in ("SE1", "SE2") else c

# ------------------------------------------------------------------ sources
def load_openngc():
    """Retourne (by_name, messier_map) — NGC.csv + addendum.csv fusionnés."""
    by_name = {}
    messier_map = {}
    for key in ("openngc_ngc", "openngc_add"):
        text = fetch(key)
        for row in csv.DictReader(io.StringIO(text), delimiter=";"):
            by_name[row["Name"].strip()] = row
            m = row.get("M", "").strip()
            if m and row["Name"] != "M102":  # M102 est listé 'Dup' de M101 dans l'addendum -> ignoré
                for num in re.findall(r"\d+", m):
                    messier_map.setdefault(int(num), []).append((row["Name"], key))
    return by_name, messier_map

def load_hyg():
    rows = []
    for r in csv.DictReader(io.StringIO(fetch("hyg"))):
        rows.append(r)
    return rows

def load_d3_messier():
    """M# -> (ra_deg, dec_deg, mag) depuis d3-celestial messier.json (contre-vérification)."""
    d = json.loads(fetch("messier_d3"))
    out = {}
    for feat in d["features"]:
        mnum = re.sub(r"[^0-9]", "", str(feat.get("id", "")))
        if not mnum:
            continue
        ra, dec = feat["geometry"]["coordinates"]
        out[int(mnum)] = ((ra + 360.0) % 360.0, dec, feat["properties"].get("mag"))
    return out

def load_d3_celestial_hip_map():
    """Map HIP -> (ra_deg, dec_deg) depuis d3-celestial (contre-vérification étoiles)."""
    stars = json.loads(fetch("stars6"))
    names = json.loads(fetch("starnames"))
    hip_map = {}
    for sid, entry in names.items():
        hip = entry.get("hip", "")
        m = re.search(r"(\d+)", hip or "")
        if not m:
            continue
        feat = next((f for f in stars["features"] if str(f.get("id")) == str(sid)), None)
        if not feat:
            continue
        ra, dec = feat["geometry"]["coordinates"]
        hip_map[int(m.group(1))] = ((ra + 360.0) % 360.0, dec)  # RA parfois négatif
    return hip_map

# ------------------------------------------------------------------ table Messier (noms + types curés)
# type parmi ObjType. Nom vide -> désignation NGC/IC de la source.
MESSIER_INFO = {
    1: ("Crab Nebula", "NEBULA"), 2: ("", "GLOBULAR"), 3: ("", "GLOBULAR"), 4: ("", "GLOBULAR"),
    5: ("", "GLOBULAR"), 6: ("Butterfly Cluster", "OPEN_CLUSTER"), 7: ("Ptolemy Cluster", "OPEN_CLUSTER"),
    8: ("Lagoon Nebula", "NEBULA"), 9: ("", "GLOBULAR"), 10: ("", "GLOBULAR"),
    11: ("Wild Duck Cluster", "OPEN_CLUSTER"), 12: ("", "GLOBULAR"), 13: ("Hercules Cluster", "GLOBULAR"),
    14: ("", "GLOBULAR"), 15: ("Great Pegasus Cluster", "GLOBULAR"), 16: ("Eagle Nebula", "NEBULA"),
    17: ("Omega Nebula", "NEBULA"), 18: ("", "OPEN_CLUSTER"), 19: ("", "GLOBULAR"),
    20: ("Trifid Nebula", "NEBULA"), 21: ("", "OPEN_CLUSTER"), 22: ("Sagittarius Cluster", "GLOBULAR"),
    23: ("", "OPEN_CLUSTER"), 24: ("Sagittarius Star Cloud", "OTHER"), 25: ("", "OPEN_CLUSTER"),
    26: ("", "OPEN_CLUSTER"), 27: ("Dumbbell Nebula", "PLANETARY_NEBULA"), 28: ("", "GLOBULAR"),
    29: ("", "OPEN_CLUSTER"), 30: ("", "GLOBULAR"), 31: ("Andromeda Galaxy", "GALAXY"),
    32: ("", "GALAXY"), 33: ("Triangulum Galaxy", "GALAXY"), 34: ("", "OPEN_CLUSTER"),
    35: ("", "OPEN_CLUSTER"), 36: ("", "OPEN_CLUSTER"), 37: ("", "OPEN_CLUSTER"),
    38: ("", "OPEN_CLUSTER"), 39: ("", "OPEN_CLUSTER"), 40: ("Winnecke 4", "DOUBLE_STAR"),
    41: ("", "OPEN_CLUSTER"), 42: ("Orion Nebula", "NEBULA"), 43: ("De Mairan's Nebula", "NEBULA"),
    44: ("Beehive Cluster", "OPEN_CLUSTER"), 45: ("Pleiades", "OPEN_CLUSTER"), 46: ("", "OPEN_CLUSTER"),
    47: ("", "OPEN_CLUSTER"), 48: ("", "OPEN_CLUSTER"), 49: ("", "GALAXY"), 50: ("", "OPEN_CLUSTER"),
    51: ("Whirlpool Galaxy", "GALAXY"), 52: ("", "OPEN_CLUSTER"), 53: ("", "GLOBULAR"),
    54: ("", "GLOBULAR"), 55: ("", "GLOBULAR"), 56: ("", "GLOBULAR"),
    57: ("Ring Nebula", "PLANETARY_NEBULA"), 58: ("", "GALAXY"), 59: ("", "GALAXY"),
    60: ("", "GALAXY"), 61: ("", "GALAXY"), 62: ("", "GLOBULAR"),
    63: ("Sunflower Galaxy", "GALAXY"), 64: ("Black Eye Galaxy", "GALAXY"), 65: ("", "GALAXY"),
    66: ("", "GALAXY"), 67: ("", "OPEN_CLUSTER"), 68: ("", "GLOBULAR"), 69: ("", "GLOBULAR"),
    70: ("", "GLOBULAR"), 71: ("", "GLOBULAR"), 72: ("", "GLOBULAR"), 73: ("", "ASTERISM"),
    74: ("Phantom Galaxy", "GALAXY"), 75: ("", "GLOBULAR"), 76: ("Little Dumbbell Nebula", "PLANETARY_NEBULA"),
    77: ("", "GALAXY"), 78: ("", "NEBULA"), 79: ("", "GLOBULAR"), 80: ("", "GLOBULAR"),
    81: ("Bode's Galaxy", "GALAXY"), 82: ("Cigar Galaxy", "GALAXY"), 83: ("Southern Pinwheel Galaxy", "GALAXY"),
    84: ("", "GALAXY"), 85: ("", "GALAXY"), 86: ("", "GALAXY"), 87: ("Virgo A", "GALAXY"),
    88: ("", "GALAXY"), 89: ("", "GALAXY"), 90: ("", "GALAXY"), 91: ("", "GALAXY"),
    92: ("", "GLOBULAR"), 93: ("", "OPEN_CLUSTER"), 94: ("", "GALAXY"), 95: ("", "GALAXY"),
    96: ("", "GALAXY"), 97: ("Owl Nebula", "PLANETARY_NEBULA"), 98: ("", "GALAXY"),
    99: ("", "GALAXY"), 100: ("", "GALAXY"), 101: ("Pinwheel Galaxy", "GALAXY"),
    102: ("Spindle Galaxy", "GALAXY"), 103: ("", "OPEN_CLUSTER"), 104: ("Sombrero Galaxy", "GALAXY"),
    105: ("", "GALAXY"), 106: ("", "GALAXY"), 107: ("", "GLOBULAR"), 108: ("", "GALAXY"),
    109: ("", "GALAXY"), 110: ("", "GALAXY"),
}
# M102 = NGC5866 (désignation usuelle acceptée ; OpenNGC liste M102 comme 'Dup' de M101)
M102_NGC = "NGC5866"
# Overrides ponctuels de magnitude visuelle quand V et B manquent dans OpenNGC
# (valeurs publiées courantes : Wikipedia/SEDS/NGC2000.0). Les objets restant inconnus gardent mag=99.
MAG_OVERRIDES = {
    "NGC0604": 11.5,   # région HII dans M33
    "NGC2024": 10.0,   # Flame Nebula
    "NGC2174": 6.8,    # Monkey Head Nebula
    "NGC2237": 6.0,    # Rosette Nebula
    "NGC2244": 4.8,    # Rosette Cluster
    "NGC3603": 9.2,    # région HII de Carina
    "NGC4755": 4.2,    # Jewel Box Cluster
    "NGC6979": 7.0,    # Veil Nebula Central (Pickering's Triangle)
}
SIZE_OVERRIDES = {"NGC2237": 80.0}  # Rosette (arcmin) si MajAx absent

def openngc_type_to_objtype(t):
    t = t.strip()
    if t in ("G", "GPair", "GGroup", "GTrpl"):
        return "GALAXY"
    if t == "GCl":
        return "GLOBULAR"
    if t in ("OCl", "*Ass"):
        return "OPEN_CLUSTER"
    if t == "PN":
        return "PLANETARY_NEBULA"
    if t in ("*", "Nova"):
        return "STAR"
    if t == "**":
        return "DOUBLE_STAR"
    if t == "*Gr":
        return "ASTERISM"
    return "NEBULA"  # HII, Neb, EmN, RfN, SNR, DrkN, Cl+N

def row_to_skyobj(row, obj_id, name, objtype, constel=None):
    ra = hms_to_deg(row["RA"])
    dec = dms_to_deg(row["Dec"])
    mag = parse_mag(row.get("V-Mag", ""))
    if mag is None:
        mag = parse_mag(row.get("B-Mag", ""))
    if mag is None:
        mag = MAG_OVERRIDES.get(row["Name"])
    if mag is None:
        mag = 99.0
    size = parse_mag(row.get("MajAx", ""))
    if size is None:
        size = SIZE_OVERRIDES.get(row["Name"])
    cst = norm_constel(constel if constel else row.get("Const", ""))
    obj = {"id": obj_id, "name": name, "type": objtype, "raDeg": round(ra, 5),
           "decDeg": round(dec, 5), "mag": round(mag, 2), "constel": cst}
    if size:
        obj["sizeMin"] = round(size, 1)
    return obj

def build_messier(by_name, messier_map, d3_messier=None):
    messier_deltas = []
    objects, issues = [], []
    for mnum in range(1, 111):
        info = MESSIER_INFO[mnum]
        curated_name, hand_type = info
        row = None
        srcname = ""
        if mnum == 102:
            row = by_name.get(M102_NGC)
            srcname = M102_NGC
        else:
            cands = messier_map.get(mnum, [])
            if not cands:
                issues.append(f"M{mnum}: introuvable dans OpenNGC !")
                continue
            if len(cands) > 1:
                issues.append(f"M{mnum}: plusieurs candidats {[c[0] for c in cands]} -> premier retenu")
            srcname = cands[0][0]
            row = by_name.get(srcname)
        if row is None:
            issues.append(f"M{mnum}: ligne source absente ({srcname})")
            continue
        name = curated_name or (re.sub(r"^([NI][CG])0*(\d+)$", r"\1 \2", srcname))
        # contre-vérification du type OpenNGC vs table curée
        src_type = openngc_type_to_objtype(row["Type"])
        if src_type != hand_type and not (mnum in (24, 73)):
            issues.append(f"M{mnum} ({srcname}): type OpenNGC={src_type} vs table={hand_type}")
        obj = row_to_skyobj(row, f"M{mnum}", name, hand_type)
        if d3_messier and mnum in d3_messier:
            ra2, de2, _ = d3_messier[mnum]
            sep = ang_dist_deg(obj["raDeg"], obj["decDeg"], ra2, de2)
            messier_deltas.append((mnum, sep))
        objects.append(obj)
    return objects, issues, messier_deltas

# ------------------------------------------------------------------ NGC célèbres (non-Messier)
# numéro NGC -> nom courant (None -> 'Common names' OpenNGC, sinon désignation)
NGC_FAMOUS = {
    40: "Bow Tie Nebula", 55: None, 104: "47 Tucanae", 246: None, 253: "Sculptor Galaxy",
    300: None, 362: None, 869: "h Persei (Double Cluster)", 884: "chi Persei (Double Cluster)",
    891: "Silver Sliver Galaxy", 1365: "Great Barred Spiral Galaxy", 1499: "California Nebula",
    1566: "Spanish Dancer Galaxy", 1672: None, 1851: None, 2024: "Flame Nebula",
    2070: "Tarantula Nebula", 2174: "Monkey Head Nebula", 2237: "Rosette Nebula",
    2244: "Rosette Cluster", 2261: "Hubble's Variable Nebula", 2264: "Christmas Tree Cluster",
    2362: "Tau Canis Majoris Cluster", 2392: "Eskimo Nebula", 2403: None, 2451: None,
    2477: None, 2516: "Southern Beehive", 2683: "UFO Galaxy", 2808: None, 2903: None,
    1316: "Fornax A Galaxy", 3242: "Ghost of Jupiter Nebula", 3293: "Gem Cluster",
    3372: "Carina Nebula", 3521: None, 3532: "Poinciana Cluster", 3603: None,
    3628: "Hamburger Galaxy", 4151: "Eye of Sauron Galaxy", 4244: "Silver Needle Galaxy",
    4372: None, 4449: None, 4565: "Needle Galaxy", 4631: "Whale Galaxy",
    4656: "Hockey Stick Galaxy", 4755: "Jewel Box Cluster", 4833: None, 4945: None,
    5128: "Centaurus A Galaxy", 5139: "Omega Centauri", 5195: None, 5866: "Spindle Galaxy",
    604: None, 6231: "Northern Jewel Box", 6302: "Bug Nebula", 6334: "Cat's Paw Nebula",
    6357: "War and Peace Nebula", 6388: None, 6397: None, 6541: None,
    6543: "Cat's Eye Nebula", 6752: None, 6826: "Blinking Planetary Nebula",
    6946: "Fireworks Galaxy", 6960: "Veil Nebula West", 6979: "Veil Nebula Central",
    6992: "Veil Nebula East", 6995: "Veil Nebula East", 7000: "North America Nebula",
    7009: "Saturn Nebula", 7023: "Iris Nebula", 7293: "Helix Nebula", 7331: None,
    7662: "Blue Snowball Nebula", 7789: "Caroline's Rose", 7814: None, 5189: "Spiral Planetary Nebula",
    6503: None,
}

def build_ngc_famous(by_name):
    objects, dropped = [], []
    for ngc_num in sorted(NGC_FAMOUS):
        key = f"NGC{ngc_num:04d}"
        row = by_name.get(key)
        if row is None:
            dropped.append(key + " (absent OpenNGC)")
            continue
        if row.get("M", "").strip():
            dropped.append(key + f" (doublon Messier {row['M']})")
            continue
        curated = NGC_FAMOUS[ngc_num]
        common = row.get("Common names", "").split(",")[0].strip()
        name = curated or common or f"NGC {ngc_num}"
        name = name.replace("M104 ", "")  # garde-fou anti-Messier dans les noms
        objtype = openngc_type_to_objtype(row["Type"])
        obj = row_to_skyobj(row, f"NGC{ngc_num}", name, objtype)
        obj["id"] = f"NGC{ngc_num}"  # format sans zéros (contract: 'NGC5139')
        objects.append(obj)
    return objects, dropped

# ------------------------------------------------------------------ étoiles brillantes nommées
# (nom_affiché, bayer_HYG, constellation, flamsteed_optionnel)
BRIGHT_STARS_LIST = [
    ("Sirius", "Alp", "CMa", None), ("Canopus", "Alp", "Car", None), ("Arcturus", "Alp", "Boo", None),
    ("Vega", "Alp", "Lyr", None), ("Capella", "Alp", "Aur", None), ("Rigel", "Bet", "Ori", None),
    ("Procyon", "Alp", "CMi", None), ("Betelgeuse", "Alp", "Ori", None), ("Achernar", "Alp", "Eri", None),
    ("Acrux", "Alp", "Cru", None), ("Altair", "Alp", "Aql", None), ("Aldebaran", "Alp", "Tau", None),
    ("Antares", "Alp", "Sco", None), ("Spica", "Alp", "Vir", None), ("Pollux", "Bet", "Gem", None),
    ("Fomalhaut", "Alp", "PsA", None), ("Deneb", "Alp", "Cyg", None), ("Regulus", "Alp", "Leo", None),
    ("Castor", "Alp", "Gem", None), ("Rigil Kentaurus", "Alp", "Cen", None), ("Hadar", "Bet", "Cen", None),
    ("Mimosa", "Bet", "Cru", None), ("Adhara", "Eps", "CMa", None), ("Shaula", "Lam", "Sco", None),
    ("Gacrux", "Gam", "Cru", None), ("Bellatrix", "Gam", "Ori", None), ("Elnath", "Bet", "Tau", None),
    ("Miaplacidus", "Bet", "Car", None), ("Alnilam", "Eps", "Ori", None), ("Alnair", "Alp", "Gru", None),
    ("Alnitak", "Zet", "Ori", None), ("Alioth", "Eps", "UMa", None), ("Dubhe", "Alp", "UMa", None),
    ("Mirfak", "Alp", "Per", None), ("Wezen", "Del", "CMa", None), ("Regor", "Gam", "Vel", None),
    ("Kaus Australis", "Eps", "Sgr", None), ("Alkaid", "Eta", "UMa", None), ("Sargas", "The", "Sco", None),
    ("Menkalinan", "Bet", "Aur", None), ("Atria", "Alp", "TrA", None), ("Alhena", "Gam", "Gem", None),
    ("Peacock", "Alp", "Pav", None), ("Alsephina", "Del", "Vel", None), ("Mirzam", "Bet", "CMa", None),
    ("Alphard", "Alp", "Hya", None), ("Polaris", "Alp", "UMi", None), ("Hamal", "Alp", "Ari", None),
    ("Algieba", "Gam", "Leo", None), ("Diphda", "Bet", "Cet", None), ("Mizar", "Zet", "UMa", None),
    ("Nunki", "Sig", "Sgr", None), ("Menkent", "The", "Cen", None), ("Mirach", "Bet", "And", None),
    ("Alpheratz", "Alp", "And", None), ("Rasalhague", "Alp", "Oph", None), ("Kochab", "Bet", "UMi", None),
    ("Saiph", "Kap", "Ori", None), ("Denebola", "Bet", "Leo", None), ("Algol", "Bet", "Per", None),
    ("Tiaki", "Bet", "Gru", None), ("Muhlifain", "Gam", "Cen", None), ("Aspidiske", "Iot", "Car", None),
    ("Suhail", "Lam", "Vel", None), ("Alphecca", "Alp", "CrB", None), ("Mintaka", "Del", "Ori", None),
    ("Sadr", "Gam", "Cyg", None), ("Eltanin", "Gam", "Dra", None), ("Schedar", "Alp", "Cas", None),
    ("Naos", "Zet", "Pup", None), ("Almach", "Gam", "And", None), ("Caph", "Bet", "Cas", None),
    ("Izar", "Eps", "Boo", None), ("Meissa", "Lam", "Ori", None),
    # variables notables et doubles célèbres
    ("Mira", "Omi", "Cet", None), ("Albireo", "Bet", "Cyg", None), ("Sheliak", "Bet", "Lyr", None),
    ("Alcyone", "Eta", "Tau", None), ("Cor Caroli", "Alp", "CVn", None), ("Markab", "Alp", "Peg", None),
    ("Scheat", "Bet", "Peg", None), ("Enif", "Eps", "Peg", None), ("Dschubba", "Del", "Sco", None),
    ("Acrab", "Bet", "Sco", None), ("Zubenelgenubi", "Alp", "Lib", None), ("Zosma", "Del", "Leo", None),
    ("Sheratan", "Bet", "Ari", None), ("Navi", "Gam", "Cas", None), ("Ruchbah", "Del", "Cas", None),
    ("Segin", "Eps", "Cas", None), ("Rastaban", "Bet", "Dra", None), ("Acamar", "The", "Eri", None),
    ("Thuban", "Alp", "Dra", None), ("Alderamin", "Alp", "Cep", None),
    ("Alcor", None, "UMa", "80"),  # 80 UMa, compagne de Mizar
]

def ang_dist_deg(ra1, de1, ra2, de2):
    """Séparation angulaire approximative (degrés) — suffisant pour du contrôle."""
    dra = math.radians(((ra2 - ra1 + 180) % 360) - 180)
    dde = math.radians(de2 - de1)
    rm = math.radians((ra1 + ra2) / 2.0)
    return math.degrees(math.sqrt((math.cos(rm) * dra) ** 2 + dde ** 2))

def build_bright_stars(hyg_rows, hip_map):
    # index (bayer, con) et (flam, con) ; bayer vide pour Alcor
    by_bc = {}
    by_fc = {}
    for r in hyg_rows:
        bayer, con, flam = r["bayer"].strip(), r["con"].strip(), r["flam"].strip()
        if bayer and con:
            by_bc.setdefault((bayer, con), []).append(r)
        if flam and con:
            by_fc.setdefault((flam, con), []).append(r)

    objects, misses, cross_deltas = [], [], []
    for target, bayer, con, flam in BRIGHT_STARS_LIST:
        cands = []
        if flam:  # ex: Alcor = 80 UMa
            cands = by_fc.get((flam, con), [])
        elif bayer:
            # HYG v4 note les composantes 'Alp-1'/'Alp-2' (ex: Acrux=Alp-1 Cru, Cor Caroli=Alp-2 CVn)
            for b in (bayer, bayer + "-1", bayer + "-2", bayer + "1", bayer + "2"):
                if (b, con) in by_bc:
                    cands.extend(by_bc[(b, con)])
            if not cands:
                misses.append(target)
                continue
        if not cands:
            misses.append(target)
            continue
        pick = None
        for c in cands:  # 1) nom propre identique
            if c["proper"].strip().lower() == target.lower():
                pick = c
                break
        if pick is None and len(cands) == 1:
            pick = cands[0]
        if pick is None:  # 2) la plus brillante (composante principale de la paire)
            pick = min(cands, key=lambda r: float(r["mag"]) if r["mag"] else 99)
        ra_hours = float(pick["ra"])            # HYG v4: RA en HEURES -> x15
        ra_deg = (ra_hours * 15.0) % 360.0
        dec_deg = float(pick["dec"])
        mag = float(pick["mag"]) if pick["mag"] else 99.0
        varname = pick["var"].strip()
        if varname and pick["var_max"].strip():
            vmax = float(pick["var_max"])   # convention HYG: var_max = valeur la PLUS BRILLANTE
            if mag - vmax > 1.0:
                # la colonne mag est visiblement une moyenne/époque trompeuse (ex: Mira 6.47 -> 4.87)
                mag = vmax
        sid = "STAR_" + re.sub(r"[^A-Za-z0-9]", "", target)
        objects.append({"id": sid, "name": target, "type": "STAR", "raDeg": round(ra_deg, 5),
                        "decDeg": round(dec_deg, 5), "mag": round(mag, 2),
                        "constel": con.upper()})
        # contre-vérification d3-celestial via HIP
        hip = pick["hip"].strip()
        if hip.isdigit() and int(hip) in hip_map:
            ra2, de2 = hip_map[int(hip)]
            cross_deltas.append(ang_dist_deg(ra_deg, dec_deg, ra2, de2))
    if misses:
        print("[stars] NON RÉSOLUES:", misses)
    if cross_deltas:
        print(f"[stars] contre-vérification d3-celestial: {len(cross_deltas)} étoiles croisées, "
              f"écart max = {max(cross_deltas):.4f}°, moyen = {sum(cross_deltas)/len(cross_deltas):.4f}°")
    objects.sort(key=lambda o: (o["mag"] if o["mag"] < 99 else 99, o["name"]))
    return objects

# ------------------------------------------------------------------ contrôles de validation
CONTROL = [
    # (fichier, id, RA attendu, Dec attendu) — valeurs de référence du contrat (tolérance 0.5°)
    ("messier.ts", "M31", 10.68, 41.27),
    ("messier.ts", "M42", 83.82, -5.39),
    ("messier.ts", "M45", 56.75, 24.12),
    ("ngc.ts", "NGC5139", 201.70, -47.48),
    ("stars.ts", "STAR_Sirius", 101.29, -16.72),
    ("stars.ts", "STAR_Polaris", 37.95, 89.26),
]
TOL = 0.5

def check_controls(files, messier_deltas=()):
    ok = True
    print("\n=== CONTRÔLES DE COORDONNÉES (tolérance 0.5°) ===")
    for fname, oid, ra_exp, dec_exp in CONTROL:
        obj = next((o for o in files[fname] if o["id"] == oid), None)
        if obj is None:
            print(f"  ✗ {oid}: ABSENT de {fname}")
            ok = False
            continue
        d = ang_dist_deg(obj["raDeg"], obj["decDeg"], ra_exp, dec_exp)
        status = "✓" if d <= TOL else "✗"
        if d > TOL:
            ok = False
        print(f"  {status} {oid:14s} obtenu=({obj['raDeg']:9.5f}, {obj['decDeg']:9.5f})  "
              f"attendu=({ra_exp:8.2f}, {dec_exp:8.2f})  écart={d:.4f}°")
    if messier_deltas:
        worst = max(messier_deltas, key=lambda t: t[1])
        avg = sum(s for _, s in messier_deltas) / len(messier_deltas)
        print(f"  • Messier: contre-vérification OpenNGC vs d3-celestial sur {len(messier_deltas)} objets "
              f"-> écart max = {worst[1]:.4f}° (M{worst[0]}), moyen = {avg:.4f}°")
        if worst[1] > TOL:
            print(f"    ✗ écart > {TOL}° entre sources pour M{worst[0]} !")
            ok = False
    return ok

# ------------------------------------------------------------------ émission TS
def ts_str(s):
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"

def obj_to_ts(o):
    parts = [f"id: {ts_str(o['id'])}", f"name: {ts_str(o['name'])}", f"type: {ts_str(o['type'])}",
             f"raDeg: {o['raDeg']:.5f}", f"decDeg: {o['decDeg']:.5f}", f"mag: {o['mag']:g}"]
    if "sizeMin" in o:
        parts.append(f"sizeMin: {o['sizeMin']:g}")
    if o.get("constel"):
        parts.append(f"constel: {ts_str(o['constel'])}")
    return "  { " + ", ".join(parts) + " },"

TYPES_TS = """/**
 * AutoStar Droid — types partagés des catalogues du ciel.
 * Définis par le contrat d'architecture (services/catalog). NE PAS ÉDITER.
 */

export type ObjType = 'GALAXY' | 'GLOBULAR' | 'OPEN_CLUSTER' | 'NEBULA' | 'PLANETARY_NEBULA' | 'STAR' | 'DOUBLE_STAR' | 'ASTERISM' | 'OTHER';

export interface SkyObject {
  id: string;        // 'M31', 'NGC5139', 'STAR_Sirius' etc.
  name: string;      // nom courant ou désignation
  type: ObjType;
  raDeg: number;     // ascension droite en DEGRÉS décimaux (0-360, époque J2000)
  decDeg: number;    // déclinaison en DEGRÉS décimaux (négatif sud, époque J2000)
  mag: number;       // magnitude (0 si inconnue -> mettre 99)
  sizeMin?: number;  // taille apparente en minutes d'arc
  constel?: string;  // abbr. constellation 3 lettres IAU (AND, ORI...)
}
"""

def write_ts(filename, banner, const_name, objects):
    lines = ["/**", f" * {banner}", f" * Généré le {GEN_DATE} par scripts/gen_catalogs.py — NE PAS ÉDITER À LA MAIN.",
             " */", "import type { SkyObject } from './types';", "",
             f"export const {const_name}: SkyObject[] = ["]
    lines += [obj_to_ts(o) for o in objects]
    lines += ["];", ""]
    path = os.path.join(OUTDIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"[out] {path} ({len(objects)} objets)")
    return path

# ------------------------------------------------------------------ main
def main():
    os.makedirs(OUTDIR, exist_ok=True)
    print("=== Téléchargement / lecture des sources ===")
    by_name, messier_map = load_openngc()
    print(f"[openngc] {len(by_name)} objets, {len(messier_map)} références Messier")
    d3_messier = load_d3_messier()
    print(f"[d3-celestial messier.json] {len(d3_messier)} objets (contre-vérification)")
    hyg_rows = load_hyg()
    print(f"[hyg] {len(hyg_rows)} étoiles")
    hip_map = load_d3_celestial_hip_map()
    print(f"[d3-celestial] carte HIP -> coordonnées: {len(hip_map)} étoiles")

    print("\n=== Construction des catalogues ===")
    messier, issues_m, messier_deltas = build_messier(by_name, messier_map, d3_messier)
    ngc, dropped = build_ngc_famous(by_name)
    stars = build_bright_stars(hyg_rows, hip_map)
    for i in issues_m:
        print("[messier] " + i)
    for d in dropped:
        print("[ngc] ignoré: " + d)

    print(f"\nCounts: MESSIER={len(messier)}  NGC_FAMOUS={len(ngc)}  BRIGHT_STARS={len(stars)}")
    if len(messier) != 110:
        print(f"✗ ERREUR: MESSIER doit contenir 110 objets (obtenu {len(messier)})")
    if not (60 <= len(ngc) <= 80):
        print(f"✗ ERREUR: NGC_FAMOUS doit contenir 60..80 objets (obtenu {len(ngc)})")
    if not (80 <= len(stars) <= 100):
        print(f"✗ ERREUR: BRIGHT_STARS doit contenir 80..100 objets (obtenu {len(stars)})")

    files = {"messier.ts": messier, "ngc.ts": ngc, "stars.ts": stars}

    # contrôles de coordonnées AVANT écriture
    if not check_controls(files, messier_deltas):
        print("✗ Écart > 0.5° détecté : la conversion d'unités doit être corrigée. Abandon.")
        sys.exit(1)

    # distribution des types + mags inconnues
    from collections import Counter
    for fname, objs in files.items():
        print(f"\n[{fname}] types: {dict(Counter(o['type'] for o in objs))}")
        unknown = [o["id"] for o in objs if o["mag"] == 99]
        if unknown:
            print(f"  mag=99 (inconnue): {unknown}")

    # émission TS
    os.makedirs(OUTDIR, exist_ok=True)
    with open(os.path.join(OUTDIR, "types.ts"), "w", encoding="utf-8") as f:
        f.write(TYPES_TS)
    print(f"\n[out] {os.path.join(OUTDIR, 'types.ts')}")
    write_ts("messier.ts",
             "AutoStar Droid — Catalogue de Messier (M1..M110), 110 objets du ciel profond.\n"
             " * Source: OpenNGC (github.com/mattiaverga/OpenNGC, CC-BY-SA-4.0), NGC.csv + addendum.csv (M40, M45).\n"
             " * Coordonnées J2000 en degrés décimaux (RA converti de HH:MM:SS en heures vers degrés ×15).\n"
             " * Noms et types curés à la main ; M102 = NGC 5866 (désignation usuelle).",
             "MESSIER", messier)
    write_ts("ngc.ts",
             "AutoStar Droid — Objets NGC célèbres (hors catalogue de Messier), sélection d'amateurs.\n"
             " * Source: OpenNGC (github.com/mattiaverga/OpenNGC, CC-BY-SA-4.0), NGC.csv.\n"
             " * Quelques magnitudes absentes d'OpenNGC proviennent de valeurs publiées (Wikipedia/SEDS) ;\n"
             "   mag=99 = magnitude inconnue.\n"
             " * Coordonnées J2000 en degrés décimaux (RA converti de HH:MM:SS en heures vers degrés ×15).\n"
             " * Double Cluster (NGC869/884), Oméga du Centaure, 47 Tuc, Veil, Rosette, Carina, Tarantule, etc.",
             "NGC_FAMOUS", ngc)
    write_ts("stars.ts",
             "AutoStar Droid — Étoiles brillantes nommées (navigation, doubles et variables célèbres).\n"
             " * Source: HYG v4.4 (codeberg.org/astronexus/hyg, CC-BY-SA-4.0), croisé avec d3-celestial stars.6.json.\n"
             " * Coordonnées J2000 en degrés décimaux (RA converti d'heures décimales vers degrés ×15).\n"
             " * id = 'STAR_<NomSansEspaces>' ; variables célèbres : magnitude à l'éclat maximum (ex. Mira).",
             "BRIGHT_STARS", stars)

    print("\nGénération terminée avec succès.")

if __name__ == "__main__":
    main()
