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
  /** AD "HH:MM:SS" pour :Sr — HAUTE précision (Autostar/#49x par défaut). */
  raCmd(raDeg: number): string {
    return raDegToHMS(raDeg);
  },
  /** AD "HH:MM.T" pour :Sr — BASSE précision (LX200 classique par défaut). */
  raCmdLow(raDeg: number): string {
    const ra = (((raDeg % 360) + 360) % 360) / 15;
    const h = Math.floor(ra);
    const m = Math.floor((ra - h) * 60);
    const t = Math.round(((ra - h) * 60 - m) * 10);
    const t2 = t === 10 ? 0 : t;
    const m2 = t === 10 ? (m === 59 ? 0 : m + 1) : m;
    const h2 = t === 10 && m === 59 ? h + 1 : h;
    return `${pad(h2 % 24)}:${pad(m2)}.${t2}`;
  },
  /** DEC "sDD*MM" pour :Sd — BASSE précision (compatible LX200). */
  decCmd(decDeg: number): string {
    return decDegToMeade(decDeg, false);
  },
  /** DEC "sDD*MM:SS" pour :Sd — HAUTE précision (Autostar). */
  decCmdHigh(decDeg: number): string {
    return decDegToMeade(decDeg, true);
  },
};

/** DEC Meade : signe toujours présent, '*' entre degrés et minutes,
 *  secondes seulement en haute précision. */
function decDegToMeade(decDeg: number, seconds: boolean): string {
  const sign = decDeg < 0 ? '-' : '+';
  const d = Math.abs(decDeg);
  const deg = Math.floor(d);
  const minF = (d - deg) * 60;
  let min = Math.floor(minF);
  const sec = Math.round((minF - min) * 60);
  if (sec === 60) {min += 1; }
  let min2 = min;
  let deg2 = deg;
  if (min2 === 60) {min2 = 0; deg2 += 1;}
  if (!seconds) {
    const mr = Math.round((d - deg) * 60);
    const mr2 = mr === 60 ? 0 : mr;
    const dr2 = mr === 60 ? deg + 1 : deg;
    return `${sign}${pad(dr2)}*${pad(mr2)}`;
  }
  return `${sign}${pad(deg2)}*${pad(min2)}:${pad(sec === 60 ? 0 : sec)}`;
}
