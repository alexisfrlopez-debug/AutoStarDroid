#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_catalogs.py — Validation indépendante des catalogues TS générés (Task 6-b).

Parse chaque fichier .ts par regex (aucun import du projet requis) et vérifie :
  - counts : MESSIER == 110, NGC_FAMOUS 60..80, BRIGHT_STARS 80..100
  - ids uniques, format d'id, type ObjType valide, bornes RA/Dec/mag, constellation
  - présence des objets de contrôle + coordonnées à ±0.5° des valeurs de référence
  - présence des étoiles/NGC requis par le contrat
Exit code 0 si tout passe, 1 sinon.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CATDIR = os.path.join(os.path.dirname(HERE), "src", "services", "catalog")

VALID_TYPES = {"GALAXY", "GLOBULAR", "OPEN_CLUSTER", "NEBULA", "PLANETARY_NEBULA",
               "STAR", "DOUBLE_STAR", "ASTERISM", "OTHER"}

OBJ_RE = re.compile(
    r"\{\s*id:\s*'(?P<id>[^']+)',\s*name:\s*'(?P<name>(?:[^'\\]|\\.)*)',\s*"
    r"type:\s*'(?P<type>[A-Z_]+)',\s*raDeg:\s*(?P<ra>-?[\d.]+),\s*"
    r"decDeg:\s*(?P<dec>-?[\d.]+),\s*mag:\s*(?P<mag>-?[\d.]+)"
    r"(?:,\s*sizeMin:\s*(?P<size>[\d.]+))?(?:,\s*constel:\s*'(?P<constel>[A-Z0-9]{1,4})')?\s*\},?"
)

# id -> (RA attendu, Dec attendu) — valeurs de référence du contrat (tolérance 0.5°)
CONTROLS = {
    "M31": (10.68, 41.27),
    "M42": (83.82, -5.39),
    "M45": (56.75, 24.12),
    "NGC5139": (201.70, -47.48),
    "STAR_Sirius": (101.29, -16.72),
    "STAR_Polaris": (37.95, 89.26),
}

REQUIRED_NGC = {869, 884, 7000, 6960, 6992, 7009, 7293, 253, 4565, 891, 1365, 5128,
                55, 2237, 3372, 2070, 604, 5139, 104, 4755, 869}
REQUIRED_STARS = {
    "Sirius", "Canopus", "Arcturus", "Vega", "Capella", "Rigel", "Procyon", "Betelgeuse",
    "Achernar", "Acrux", "Altair", "Aldebaran", "Antares", "Spica", "Pollux", "Fomalhaut",
    "Deneb", "Regulus", "Castor", "Mimosa", "Adhara", "Shaula", "Gacrux", "Bellatrix",
    "Elnath", "Miaplacidus", "Alnilam", "Alnair", "Alnitak", "Alioth", "Dubhe", "Mirfak",
    "Wezen", "Regor", "Kaus Australis", "Alkaid", "Sargas", "Menkalinan", "Atria", "Alhena",
    "Peacock", "Alsephina", "Mirzam", "Alphard", "Polaris", "Hamal", "Algieba", "Diphda",
    "Mizar", "Nunki", "Menkent", "Mirach", "Alpheratz", "Rasalhague", "Kochab", "Saiph",
    "Denebola", "Algol", "Tiaki", "Muhlifain", "Aspidiske", "Suhail", "Alphecca", "Mintaka",
    "Sadr", "Eltanin", "Schedar", "Naos", "Almach", "Caph", "Izar",
}


def sep_deg(ra1, de1, ra2, de2):
    import math
    dra = math.radians(((ra2 - ra1 + 180.0) % 360.0) - 180.0)
    dde = math.radians(de2 - de1)
    rm = math.radians((ra1 + ra2) / 2.0)
    return math.degrees(math.sqrt((math.cos(rm) * dra) ** 2 + dde ** 2))


def parse_ts(path):
    """Retourne (count_export_line, [objets]) via parsing regex ligne à ligne."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"export const (\w+): SkyObject\[\]", text)
    const = m.group(1) if m else None
    objs = []
    for mm in OBJ_RE.finditer(text):
        o = mm.groupdict()
        objs.append({
            "id": o["id"], "name": o["name"].replace("\\'", "'"), "type": o["type"],
            "ra": float(o["ra"]), "dec": float(o["dec"]), "mag": float(o["mag"]),
            "size": float(o["size"]) if o["size"] else None,
            "constel": o["constel"] or "",
        })
    return const, objs


def main():
    failures = []
    ok = lambda cond, msg: None if cond else failures.append(msg)

    # ---- types.ts
    types_path = os.path.join(CATDIR, "types.ts")
    ok(os.path.exists(types_path), "types.ts absent")
    if os.path.exists(types_path):
        t = open(types_path, encoding="utf-8").read()
        ok("export type ObjType" in t, "types.ts: ObjType manquant")
        ok("export interface SkyObject" in t, "types.ts: SkyObject manquant")
        for f in ("id: string", "name: string", "type: ObjType", "raDeg: number",
                  "decDeg: number", "mag: number", "sizeMin?: number", "constel?: string"):
            ok(f in t, f"types.ts: champ manquant {f!r}")

    # ---- catalogues
    catalogs = {}
    for fname, const in (("messier.ts", "MESSIER"), ("ngc.ts", "NGC_FAMOUS"), ("stars.ts", "BRIGHT_STARS")):
        path = os.path.join(CATDIR, fname)
        ok(os.path.exists(path), f"{fname} absent")
        if not os.path.exists(path):
            continue
        found_const, objs = parse_ts(path)
        catalogs[const] = objs
        ok(found_const == const, f"{fname}: export const attendu {const}, trouvé {found_const}")
        ok(f"import type {{ SkyObject }} from './types';" in open(path, encoding="utf-8").read(),
           f"{fname}: import de types.ts manquant")

        ids = [o["id"] for o in objs]
        ok(len(ids) == len(set(ids)), f"{fname}: ids dupliqués -> {[i for i in ids if ids.count(i)>1][:5]}")
        for o in objs:
            ok(o["type"] in VALID_TYPES, f"{fname}:{o['id']} type invalide {o['type']}")
            ok(0.0 <= o["ra"] < 360.0, f"{fname}:{o['id']} RA hors bornes {o['ra']}")
            ok(-90.0 <= o["dec"] <= 90.0, f"{fname}:{o['id']} Dec hors bornes {o['dec']}")
            ok(-5.0 <= o["mag"] <= 99.0, f"{fname}:{o['id']} mag improbable {o['mag']}")
            if o["constel"]:
                ok(len(o["constel"]) == 3, f"{fname}:{o['id']} constel != 3 lettres ({o['constel']})")

    # counts du contrat
    ok(len(catalogs.get("MESSIER", [])) == 110,
       f"MESSIER: 110 attendus, {len(catalogs.get('MESSIER', []))} trouvés")
    n_ngc = len(catalogs.get("NGC_FAMOUS", []))
    ok(60 <= n_ngc <= 80, f"NGC_FAMOUS: 60..80 attendus, {n_ngc} trouvés")
    n_stars = len(catalogs.get("BRIGHT_STARS", []))
    ok(80 <= n_stars <= 100, f"BRIGHT_STARS: 80..100 attendus, {n_stars} trouvés")

    # cohérence des ids
    messier_ids = {o["id"] for o in catalogs.get("MESSIER", [])}
    expected_ids = {f"M{i}" for i in range(1, 111)}
    ok(messier_ids == expected_ids,
       f"MESSIER: ids manquants {sorted(expected_ids - messier_ids)[:6]} / en trop {sorted(messier_ids - expected_ids)[:6]}")
    for o in catalogs.get("NGC_FAMOUS", []):
        ok(re.fullmatch(r"NGC\d+", o["id"]) is not None, f"NGC id inattendu {o['id']}")
    for o in catalogs.get("BRIGHT_STARS", []):
        ok(re.fullmatch(r"STAR_[A-Za-z0-9]+", o["id"]) is not None, f"id étoile inattendu {o['id']}")
        ok(o["type"] == "STAR", f"{o['id']} devrait être STAR")

    # objets de contrôle (coordonnées)
    print("=== Contrôles de coordonnées (tolérance ±0.5°) ===")
    for oid, (ra_e, de_e) in CONTROLS.items():
        found = None
        for objs in catalogs.values():
            for o in objs:
                if o["id"] == oid:
                    found = o
        if found is None:
            failures.append(f"contrôle {oid}: ABSENT")
            print(f"  ✗ {oid}: ABSENT")
            continue
        d = sep_deg(found["ra"], found["dec"], ra_e, de_e)
        status = "✓" if d <= 0.5 else "✗"
        print(f"  {status} {oid:14s} obtenu=({found['ra']:9.5f}, {found['dec']:9.5f})  "
              f"attendu=({ra_e:8.2f}, {de_e:8.2f})  écart={d:.4f}°")
        ok(d <= 0.5, f"contrôle {oid}: écart {d:.4f}° > 0.5°")

    # présence des célébrités requises
    ngc_ids = {int(o["id"][3:]) for o in catalogs.get("NGC_FAMOUS", []) if o["id"].startswith("NGC")}
    missing_ngc = sorted(n for n in REQUIRED_NGC if n not in ngc_ids)
    ok(not missing_ngc, f"NGC requis absents: {missing_ngc}")
    star_names = {o["name"] for o in catalogs.get("BRIGHT_STARS", [])}
    missing_stars = sorted(REQUIRED_STARS - star_names)
    ok(not missing_stars, f"étoiles requises absentes: {missing_stars}")

    # aucun doublon Messier dans NGC_FAMOUS (par nom M### dans le champ name)
    for o in catalogs.get("NGC_FAMOUS", []):
        ok(re.search(r"\bM ?\d{1,3}\b", o["name"]) is None,
           f"NGC_FAMOUS {o['id']}: le nom semble être un Messier ({o['name']})")

    # ---- résumé
    print("\n=== Résumé ===")
    for const, objs in catalogs.items():
        from collections import Counter
        print(f"  {const}: {len(objs)} objets — types: {dict(Counter(o['type'] for o in objs))}")
    mag99 = [(o['id']) for objs in catalogs.values() for o in objs if o["mag"] == 99]
    if mag99:
        print(f"  mag=99 (inconnue, conforme au contrat): {mag99}")

    if failures:
        print(f"\n✗ ÉCHEC : {len(failures)} problème(s)")
        for f in failures:
            print("   - " + f)
        sys.exit(1)
    print("\n✓ Validation complète réussie : 4 fichiers TS conformes au contrat.")
    sys.exit(0)


if __name__ == "__main__":
    main()
