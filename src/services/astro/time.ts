/** Calculs temporels astronomiques. */

/** Jour julien depuis une date JS (UTC interne). */
export function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Temps sidéral de Greenwich en DEGRÉS (formule IAU simplifiée, précision ~0.1s). */
export function gmstDeg(date: Date): number {
  const jd = julianDay(date);
  const T = (jd - 2451545.0) / 36525.0;
  let gmst =
    280.46061837 +
    360.98564736629 * (jd - 2451545.0) +
    0.000387933 * T * T -
    T * T * T / 38710000.0;
  gmst = ((gmst % 360) + 360) % 360;
  return gmst;
}

/** Temps sidéral LOCAL en degrés. */
export function lstDeg(date: Date, lonDeg: number): number {
  const l = ((gmstDeg(date) + lonDeg) % 360 + 360) % 360;
  return l;
}

/** Angle horaire en degrés (RA en degrés). */
export function hourAngleDeg(date: Date, lonDeg: number, raDeg: number): number {
  const ha = ((lstDeg(date, lonDeg) - raDeg) % 360 + 360) % 360;
  return ha > 180 ? ha - 360 : ha;
}

/** Degrés -> "HH:MM:SS" (ascension droite). */
export function raDegToHMS(raDeg: number): string {
  const ra = (((raDeg % 360) + 360) % 360) / 15;
  const h = Math.floor(ra);
  const m = Math.floor((ra - h) * 60);
  const s = Math.round(((ra - h) * 60 - m) * 60);
  const s2 = s === 60 ? 0 : s;
  const m2 = s === 60 ? (m === 59 ? 0 : m + 1) : m;
  const h2 = s === 60 && m === 59 ? h + 1 : h;
  return `${pad(h2 % 24)}:${pad(m2)}:${pad(s2)}`;
}

/** Degrés -> "±DD°MM'" (déclinaison). */
export function decDegToDMS(decDeg: number): string {
  const sign = decDeg < 0 ? '-' : '+';
  const d = Math.abs(decDeg);
  const deg = Math.floor(d);
  const min = Math.round((d - deg) * 60);
  const min2 = min === 60 ? 0 : min;
  const deg2 = min === 60 ? deg + 1 : deg;
  return `${sign}${pad(deg2)}°${pad(min2)}'`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Formats pour le protocole Meade. */
export const proto = {
  /** AD "HH:MM:SS#" pour :Sr */
  raCmd(raDeg: number): string {
    return raDegToHMS(raDeg);
  },
  /** DEC "sDD*MM#" pour :Sd (minutes seulement, compatible LX200) */
  decCmd(decDeg: number): string {
    const sign = decDeg < 0 ? '-' : '+';
    const d = Math.abs(decDeg);
    const deg = Math.floor(d);
    const min = Math.round((d - deg) * 60);
    const min2 = min === 60 ? 0 : min;
    const deg2 = min === 60 ? deg + 1 : deg;
    return `${sign}${pad(deg2)}*${pad(min2)}`;
  },
};
