/**
 * Driver IOPTRON Go2Nova (v2.6.0) — handbox 8407 (iEQ30, CEM25/26/40,
 * GEM45, SmartEQ…). Le 8407 accepte un SOUS-ENSEMBLE LX200 (position :GR#/
 * :GD#, cible :Sr/:Sd, GOTO :MS#, sync :CM#) avec ses PROPRES commandes
 * vitesse/jog/arrêt et une SÉMANTIQUE DE RÉPONSE DIFFÉRENTE de Meade :
 *  - :MS# → '1' = accepté, '0' = sous l'horizon, '2' = hors limites
 *    (Meade : '0' = ok — inversion historique, source de bugs) ;
 *  - cible : ':Sr HH:MM:SS#' et ':Sd ±DD*MM:SS#' (avec espace, '1' attendu).
 *
 * Référence : driver INDIGO mount_ioptron (GSS), commandes HC_8407.
 * Non implémenté (v1, retours terrain attendus) : push site, park, vitesses
 * natives avancées, protocoles V2.0+/V3.0 (formats bruts différents).
 */
import {
  registerDriver, parseMeadeDec, parseMeadeRa, VALID, NO_CAPS,
  type DriverClient, type GotoStatus, type RaDec, type Dir, type Speed,
  type TelescopeDriver,
} from '../driver';
import {proto} from '../../astro/time';

/** Vitesse de jog : crans app → :SR%d# (1 lent … 9 rapide). */
const IO_RATE: Record<Speed, number> = {guide: 1, center: 3, find: 6, slew: 9};

/** ":MountInfo#" → "8407,0308," (modèle, version) — signature iOptron. */
export function parseMountInfo(reply: string): {product: string; version: string} | null {
  const m = (reply ?? '').trim().match(/^(\w{3,12})[, ]+([\d.]+)/);
  if (!m) return null;
  return {product: m[1], version: m[2]};
}

/** Driver iOptron avec position stricte (getRaDec requis en interne). */
export interface IoptronDriver extends TelescopeDriver {
  getRaDec(c: DriverClient, timeoutMs: number): Promise<RaDec>;
}

export const IOPTRON_DRIVER: IoptronDriver = {
  id: 'ioptron',
  label: 'iOptron Go2Nova 8407',
  brands: 'iOptron (CEM, GEM, iEQ, SmartEQ — handbox 8407)',
  caps: {
    ...NO_CAPS,
    position: true, goto: true, relay: true, sync: true, syncHere: true,
    trackingModes: true,
  },
  probe: {
    cmd: ':MountInfo#',
    timeoutMs: 1500,
    expect: VALID.any,
    classify: (reply: string): boolean => parseMountInfo(reply) !== null,
  },

  async firmware(c: DriverClient): Promise<{product: string; version: string}> {
    const info = await c.cmd(':MountInfo#', 2000, VALID.any).catch(() => '');
    const parsed = parseMountInfo(info);
    return parsed ?? {product: 'iOptron', version: '?'};
  },

  async getRaDec(c: DriverClient, timeoutMs: number): Promise<RaDec> {
    // :GR# → "HH:MM:SS" · :GD# → "±DD*MM" (formats Meade)
    const ra = await c.cmd(':GR#', timeoutMs, VALID.ra);
    const dec = await c.cmd(':GD#', timeoutMs, VALID.dec);
    const raDeg = parseMeadeRa(ra);
    const decDeg = parseMeadeDec(dec);
    if (raDeg === null || decDeg === null) throw new Error('Réponse position illisible');
    return {raDeg, decDeg};
  },

  async readPosition(c: DriverClient, timeoutMs: number) {
    try {
      return await this.getRaDec(c, timeoutMs);
    } catch (_) {
      return {raDeg: null, decDeg: null};
    }
  },

  async goto(c: DriverClient, raDeg: number, decDeg: number): Promise<GotoStatus> {
    // cible : ':Sr HH:MM:SS#' puis ':Sd ±DD*MM:SS#' → '1'
    const r1 = await c.cmd(`:Sr ${proto.raCmd(raDeg)}#`, 3000, VALID.bit).catch(() => '');
    if (r1 !== '1') {
      if (!c.transportAlive()) return 'noLink';
      c.log('error', `GO TO : cible AD refusée (${r1 === '0' ? 'refus explicite' : 'sans réponse'})`);
      return r1 === '0' ? 'refused' : 'mute';
    }
    const r2 = await c.cmd(`:Sd ${proto.decCmdHigh(decDeg)}#`, 3000, VALID.bit).catch(() => '');
    if (r2 !== '1') {
      if (!c.transportAlive()) return 'noLink';
      c.log('error', `GO TO : cible DEC refusée (${r2 === '0' ? 'refus explicite' : 'sans réponse'})`);
      return r2 === '0' ? 'refused' : 'mute';
    }
    // :MS# → '1' accepté, '0' sous l'horizon, '2' hors limites (INVERSÉ vs Meade)
    const ms = await c.cmd(':MS#', 5000, VALID.digit).catch(() => '');
    if (ms === '1') return 'ok';
    if (ms === '0') return 'belowHorizon';
    if (ms === '2') return 'noObject';
    if (!c.transportAlive()) return 'noLink';
    c.log('info', `GO TO : :MS sans réponse exploitable (« ${ms || 'muet'} ») — relais`);
    return 'mute';
  },

  async syncRaDec(c: DriverClient, raDeg: number, decDeg: number): Promise<boolean> {
    const r1 = await c.cmd(`:Sr ${proto.raCmd(raDeg)}#`, 3000, VALID.bit).catch(() => '');
    const r2 = r1 === '1'
      ? await c.cmd(`:Sd ${proto.decCmdHigh(decDeg)}#`, 3000, VALID.bit).catch(() => '')
      : '';
    if (r2 !== '1') {
      c.log('error', 'SYNC : cible refusée ou sans réponse');
      return false;
    }
    await c.cmdSilent(':CM#');
    return true;
  },

  async syncHere(c: DriverClient): Promise<void> {
    await c.cmdSilent(':CM#');
  },

  async setSpeed(c: DriverClient, s: Speed): Promise<void> {
    // :SR<n># → '1' (8407) — l'erreur est tolérée : certains firmware muets
    try {
      await c.cmd(`:SR${IO_RATE[s]}#`, 1500, VALID.any);
    } catch (_) { /* muet : la vitesse peut malgré tout être appliquée */ }
  },

  /** Jog : ':m<dir>#' (n/s/e/w, SANS réponse) après :SR — 8407. */
  async startMove(c: DriverClient, dir: Dir): Promise<void> {
    await c.cmdSilent(`:m${dir}#`);
  },

  async stopMove(c: DriverClient, dir: Dir): Promise<void> {
    // :qR# (axe AD/E-O) · :qD# (axe DEC/N-S) → '1'
    const cmd = dir === 'n' || dir === 's' ? ':qD#' : ':qR#';
    try {
      await c.cmd(cmd, 1500, VALID.any);
    } catch (_) {
      await c.cmdSilent(cmd).catch(() => undefined);
    }
  },

  async stopAll(c: DriverClient): Promise<void> {
    // :q# = arrêt des 2 axes (8407 v1.4+)
    try {
      await c.cmd(':q#', 1500, VALID.any);
    } catch (_) {
      await c.cmdSilent(':q#').catch(() => undefined);
      await c.cmdSilent(':qR#').catch(() => undefined);
      await c.cmdSilent(':qD#').catch(() => undefined);
    }
  },

  /** Pas de sonde de mouvement native fiable en 8407 (le :GAS# 6 chiffres
   *  varie selon firmware) : null = indéterminé → la surveillance de fin de
   *  GOTO bascule sur la stabilisation de position (socle client). */
  async isMoving(): Promise<boolean | null> {
    return null;
  },

  /** Tracking : :ST1# / :ST0# — pas de modes alt-az/terrestre séparés. */
  async setTracking(c: DriverClient, mode: 'altaz' | 'polar' | 'land'): Promise<void> {
    const on = mode !== 'land';
    try {
      await c.cmd(`:ST${on ? '1' : '0'}#`, 2000, VALID.any);
    } catch (_) { /* muet toléré */ }
  },
};

registerDriver(IOPTRON_DRIVER);
