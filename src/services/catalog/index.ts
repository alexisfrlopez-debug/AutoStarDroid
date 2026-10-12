/** Index des catalogues : recherche, planètes, tour du ciel. */
import type {SkyObject} from './types';
import {MESSIER} from './messier';
import {NGC_FAMOUS} from './ngc';
import {BRIGHT_STARS} from './stars';
import {planetsWithAlt, PlanetName} from '../astro/planets';
import {raDecToAltAz} from '../astro/coords';
import type {Dict} from '../../i18n/en';

export {MESSIER, NGC_FAMOUS, BRIGHT_STARS};

export interface DisplayObject extends SkyObject {
  altDeg: number;
  azDeg: number;
}

/** Construit la liste des planètes au format d'affichage, à l'instant présent. */
export function planetObjects(latDeg: number, lonDeg: number, date: Date, tr: Dict): DisplayObject[] {
  const list = planetsWithAlt(latDeg, lonDeg, date);
  return list.map((p) => ({
    id: `PLANET_${p.name}`,
    name: tr.planets[p.name as PlanetName] ?? p.name,
    type: (p.name === 'Sun' ? 'SUN' : p.name === 'Moon' ? 'MOON' : 'PLANET') as SkyObject['type'],
    raDeg: p.raDeg,
    decDeg: p.decDeg,
    mag: p.mag,
    constel: '',
    altDeg: p.altDeg,
    azDeg: p.azDeg,
  }));
}

/** Avec altitude/azimut courants, au site et à l'instant donnés. */
export function withAlt(
  objects: SkyObject[],
  latDeg: number,
  lonDeg: number,
  date: Date,
): DisplayObject[] {
  return objects.map((o) => {
    const aa = raDecToAltAz(o.raDeg, o.decDeg, latDeg, lonDeg, date);
    return {...o, altDeg: aa.altDeg, azDeg: aa.azDeg};
  });
}

/** Tour du ciel : objets (hors planètes) les mieux placés maintenant. */
export function tourOfSky(
  latDeg: number,
  lonDeg: number,
  date: Date,
  minAlt = 20,
  limit = 30,
): DisplayObject[] {
  const all = withAlt([...MESSIER, ...NGC_FAMOUS, ...BRIGHT_STARS], latDeg, lonDeg, date);
  return all
    .filter((o) => o.altDeg >= minAlt)
    .sort((a, b) => b.altDeg - a.altDeg)
    .slice(0, limit);
}

/** Recherche globale (Messier + NGC + étoiles). */
export function searchAll(query: string): SkyObject[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const norm = (s: string) => s.toLowerCase();
  const all = [...MESSIER, ...NGC_FAMOUS, ...BRIGHT_STARS];
  // priorité : correspondance d'ID exacte, puis nom, puis contient
  const exact = all.filter((o) => norm(o.id) === q || norm(o.id).replace(' ', '') === q.replace(' ', ''));
  const byId = all.filter((o) => exact.indexOf(o) < 0 && norm(o.id).includes(q));
  const byName = all.filter((o) => exact.indexOf(o) < 0 && byId.indexOf(o) < 0 && norm(o.name).includes(q));
  return [...exact, ...byId, ...byName].slice(0, 60);
}
