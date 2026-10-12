/**
 * Driver CELESTRON NexStar (v2.6.0) — NexStar+ / NexStar v4 (SE, SLT, Evo,
 * NexStar GT, AVX, CGX…) via le port série de la raquette (USB-série, BT ou
 * pont Wi-Fi). Jeu de commandes ASCII '#'-terminal + passthrough AUX pour
 * les flèches.
 *
 * Références : « NexStar Hand Control Communication Protocol » (Celestron),
 * drivers INDI celestrondriver.cpp / obsolete celestronprotocol.c,
 * Stellarium plugins/TelescopeControl/src/NexStar.
 *
 *  - Position : 'e' → "HHHHHHHH,DDDDDDDD#" en HEXA (1/2³² de tour précis,
 *    coarse 'E' sur 1/2¹⁶) — UNE commande pour AD+DEC (2× moins de trafic
 *    série qu'un Autostar).
 *  - GOTO : 'r' + AD,DEC hex précis → ACK '#' ; SYNC : 's' (sémantique
 *    NexStar = « la position COURANTE vaut ces coordonnées »).
 *  - Arrêt : 'M' (stop moteurs) ; fin de GOTO : 'L' ('0'/'1').
 *  - Flèches : passthrough AUX binaire 0x50 0x02 <axe> <sens> <vitesse> 0 0 0
 *    (axe 0x11 az/AD, 0x10 alt/DEC ; sens 0x24 positif, 0x25 négatif ;
 *    vitesse 1–9, 0 = arrêt) — ACK '#'. Mappage alt-az par défaut
 *    (N/S = azimut), équatorial (N/S = DEC) si tracking 't' = 2/3.
 *  - Tracking : 't' (lecture) / 'T<mode>' (0 off, 1 alt-az, 2 éq N, 3 éq S).
 *
 * Volontairement SANS les commandes binaires H/W (heure/site) : octets
 * arbitraires dans la chaîne d'écriture — les octets ≥ 0x80 dépendent de la
 * table d'encodage du transport ; capabilities.pushSite reste false (v1).
 */
import {
  registerDriver, VALID, NO_CAPS,
  type DriverClient, type GotoStatus, type RaDec, type Dir, type Speed,
  type TelescopeDriver,
} from '../driver';
import {norm360} from '../../util';

/* ---------- conversions hex NexStar (1/2¹⁶ et 1/2³² de tour) ---------- */

/** Degrés → coarse hex (16 bits : 65536/360). */
export function dd2nex(angle: number): number {
  return Math.floor((norm360(angle) * 0x10000) / 360) & 0xFFFF;
}
/** Degrés → précis hex (32 bits : 2³²/360). */
export function dd2pnex(angle: number): number {
  return Math.floor((norm360(angle) * 4294967296) / 360) >>> 0;
}
/** Coarse hex → degrés [0,360). */
export function nex2dd(v: number): number {
  return (360 * (v / 0x10000)) % 360;
}
/** Précis hex → degrés [0,360). */
export function pnex2dd(v: number): number {
  return (360 * (v / 4294967296)) % 360;
}
/** La DECLINAISON est codée 0..360 : >180° = déclinaison négative. */
const unwrapDec = (deg: number): number => (deg > 180 ? deg - 360 : deg);

const HEX8 = (v: number) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** Parse la réponse 'e' : "34A6B2C1,0F2E3D40#" (déjà débarassé du '#'). */
export function parseNexStarRadec(reply: string): RaDec | null {
  const m = reply.trim().match(/^([0-9A-Fa-f]{1,8}),([0-9A-Fa-f]{1,8})$/);
  if (!m) return null;
  const raDeg = pnex2dd(parseInt(m[1].padStart(8, '0'), 16));
  const decDeg = unwrapDec(pnex2dd(parseInt(m[2].padStart(8, '0'), 16)));
  return {raDeg, decDeg};
}

/* ---------- vitesse : les crans app → crans NexStar 1..9 ---------- */
// (mappage historique du driver INDI obsolète : SLEW=9, FIND=6, CENTER=3, GUIDE=1)
const NEX_RATE: Record<Speed, number> = {guide: 1, center: 3, find: 6, slew: 9};

/** Le passthrough AUX flèche — ACK '#' attendu. */
const AUX = (dev: number, dirByte: number, rate: number): string =>
  `P\x02${String.fromCharCode(dev)}${String.fromCharCode(dirByte)}${String.fromCharCode(rate)}\x00\x00\x00`;

/** Sens positif/négatif du passthrough AUX (MC_MOVE_POS=0x24 / NEG=0x25). */
const POS = 0x24;
const NEG = 0x25;
const AXIS_RA = 0x11;   // azimut (alt-az) / ascension droite (équatorial)
const AXIS_DEC = 0x10;  // altitude (alt-az) / déclinaison (équatorial)

export class NexStarDriver implements TelescopeDriver {
  readonly id: DriverId_NexStar;
  readonly label: string;
  readonly brands: string;
  readonly caps;
  /** Mode d'axes des flèches : alt-az (défaut) ou équatorial (tracking éq). */
  protected axisMode: 'altaz' | 'eq' = 'altaz';
  /** Vitesse courante des flèches (les P commandes emportent leur vitesse). */
  protected rate: number = NEX_RATE.center;

  constructor(id: DriverId_NexStar, label: string, brands: string, brandCaps = {}) {
    this.id = id;
    this.label = label;
    this.brands = brands;
    this.caps = {
      ...NO_CAPS,
      position: true, altAz: true, goto: true, relay: true, sync: true,
      syncHere: true, trackingModes: true, isMoving: true,
      ...brandCaps,
    };
  }

  probe = {
    cmd: 'V',
    timeoutMs: 1500,
    expect: VALID.any,
    classify: (reply: string): boolean => /^\d+\.\d+$/.test((reply ?? '').trim()),
  };

  /** Rafraîchit le mode d'axes depuis le mode de tracking réel ('t'). */
  async refreshAxisMode(c: DriverClient): Promise<void> {
    try {
      const mode = await c.cmd('t', 1500, /^[0-3]$/);
      this.axisMode = mode === '2' || mode === '3' ? 'eq' : 'altaz';
    } catch (_) { /* muette : alt-az par défaut */ }
  }

  async firmware(c: DriverClient): Promise<{product: string; version: string}> {
    const version = await c.cmd('V', 2000, /^\d/).catch(() => '?');
    let model = '';
    try {
      const m = await c.cmd('m', 1500, /^\d/);
      model = NEXSTAR_MODELS[m] ?? `modèle ${m}`;
    } catch (_) { /* optionnel */ }
    return {product: model ? `NexStar ${model}` : 'NexStar', version};
  }

  async getRaDec(c: DriverClient, timeoutMs: number): Promise<RaDec> {
    // UNE seule commande pour les 2 axes (18 octets précis)
    const r = await c.cmd('e', timeoutMs, /^[0-9A-Fa-f]{8},[0-9A-Fa-f]{8}$/);
    const rd = parseNexStarRadec(r);
    if (!rd) throw new Error('Réponse position illisible');
    return rd;
  }

  async readPosition(c: DriverClient, timeoutMs: number) {
    try {
      return await this.getRaDec(c, timeoutMs);
    } catch (_) {
      return {raDeg: null, decDeg: null}; // axe(s) muets ce cycle
    }
  }

  async readAltAz(c: DriverClient) {
    // 'z' précis : "AZM,ALT#" — l'azimut n'est PAS déplié (>180° légitime)
    const r = await c.cmd('z', 2500, /^[0-9A-Fa-f]{8},[0-9A-Fa-f]{8}$/).catch(() => '');
    if (!r) return null;
    const m = r.trim().match(/^([0-9A-Fa-f]{8}),([0-9A-Fa-f]{8})$/);
    if (!m) return null;
    const azDeg = pnex2dd(parseInt(m[1], 16));
    const altDeg = unwrapDec(pnex2dd(parseInt(m[2], 16)));
    return {altDeg, azDeg};
  }

  async goto(c: DriverClient, raDeg: number, decDeg: number): Promise<GotoStatus> {
    // 'r' + hex précis → '#' = accepté. Pas de signalement d'horizon dans le
    // protocole : le garde horizon du relais / de l'app s'applique.
    try {
      await c.cmd(`r${HEX8(dd2pnex(raDeg))},${HEX8(dd2pnex(decDeg))}`, 3500, VALID.any);
      return 'ok';
    } catch (_) {
      if (!c.transportAlive()) return 'noLink';
      return 'mute'; // pas d'ACK → relais boucle fermée (socle v2.5.0)
    }
  }

  async syncRaDec(c: DriverClient, raDeg: number, decDeg: number): Promise<boolean> {
    // Sémantique NexStar : « la position COURANTE = ces coordonnées » —
    // identique au :Sr/:Sd/:CM Meade après centrage manuel.
    try {
      await c.cmd(`s${HEX8(dd2pnex(raDeg))},${HEX8(dd2pnex(decDeg))}`, 3000, VALID.any);
      return true;
    } catch (_) {
      c.log('error', 'SYNC : NexStar sans réponse (liaison ?)');
      return false;
    }
  }

  async syncHere(c: DriverClient): Promise<void> {
    // Pas de :CM# ici : on relit la position et on la déclare à l'identique.
    const p = await this.readPosition(c, 3000);
    if (p.raDeg !== null && p.decDeg !== null) {
      await this.syncRaDec(c, p.raDeg, p.decDeg).catch(() => undefined);
    }
  }

  async setSpeed(c: DriverClient, s: Speed): Promise<void> {
    // Les passthrough AUX emportent leur vitesse : on la MÉMORISE.
    c.bump();
    this.rate = NEX_RATE[s];
  }

  /** (axe, sens) pour une direction app, selon le mode d'axes courant. */
  protected axisFor(dir: Dir): {dev: number; dirByte: number} {
    if (this.axisMode === 'eq') {
      // N/S sur DEC, E/W sur AD (convention INDI : N/W positif)
      return dir === 'n' ? {dev: AXIS_DEC, dirByte: POS}
        : dir === 's' ? {dev: AXIS_DEC, dirByte: NEG}
        : dir === 'e' ? {dev: AXIS_RA, dirByte: NEG}
        : {dev: AXIS_RA, dirByte: POS};
    }
    // alt-az (convention du driver historique Celestron) :
    // N = az+, S = az-, E = alt-, W = alt+
    return dir === 'n' ? {dev: AXIS_RA, dirByte: POS}
      : dir === 's' ? {dev: AXIS_RA, dirByte: NEG}
      : dir === 'e' ? {dev: AXIS_DEC, dirByte: NEG}
      : {dev: AXIS_DEC, dirByte: POS};
  }

  async startMove(c: DriverClient, dir: Dir): Promise<void> {
    const {dev, dirByte} = this.axisFor(dir);
    try {
      await c.cmd(AUX(dev, dirByte, this.rate), 1200, VALID.any); // ACK '#'
    } catch (_) {
      // le mouvement EST parti sur la plupart des HC même sans ACK lu
      await c.cmdSilent(AUX(dev, dirByte, this.rate)).catch(() => undefined);
    }
  }

  async stopMove(c: DriverClient, dir: Dir): Promise<void> {
    const {dev, dirByte} = this.axisFor(dir);
    try {
      await c.cmd(AUX(dev, dirByte, 0), 1200, VALID.any); // rate 0 = arrêt axe
    } catch (_) {
      await c.cmdSilent(AUX(dev, dirByte, 0)).catch(() => undefined);
    }
  }

  async stopAll(c: DriverClient): Promise<void> {
    try {
      await c.cmd('M', 1200, VALID.any); // "Motor stop" — ACK '#'
    } catch (_) {
      await c.cmdSilent('M').catch(() => undefined);
      // filet : arrêt individuel des 2 axes
      await c.cmdSilent(AUX(AXIS_RA, POS, 0)).catch(() => undefined);
      await c.cmdSilent(AUX(AXIS_DEC, POS, 0)).catch(() => undefined);
    }
  }

  async isMoving(c: DriverClient): Promise<boolean | null> {
    // 'L' : 0 = slew terminé, 1 = en cours
    try {
      const r = await c.cmd('L', 1500, /^[01]$/);
      return r === '1';
    } catch (_) {
      return null;
    }
  }

  async setTracking(c: DriverClient, mode: 'altaz' | 'polar' | 'land', latDeg: number): Promise<void> {
    // 0 = off, 1 = alt-az, 2 = éq NORD, 3 = éq SUD (déduit de la latitude site)
    const digit = mode === 'land' ? 0 : mode === 'altaz' ? 1 : latDeg >= 0 ? 2 : 3;
    try {
      await c.cmd(`T${digit}`, 2000, VALID.any);
      this.axisMode = digit === 2 || digit === 3 ? 'eq' : 'altaz';
    } catch (_) { /* muet : certains HC ne répondent pas — on tente quand même */ }
  }
}
type DriverId_NexStar = 'celestron' | 'skywatcher';

/** Modèles 'm' les plus courants (les autres s'affichent « modèle n »). */
const NEXSTAR_MODELS: Record<string, string> = {
  '0': 'GPS', '1': 'i-Series', '2': 'SE 4/5', '3': 'SLT', '4': 'LCM',
  '5': 'Dob', '6': 'CPC', '7': 'GT', '9': 'Omni', '11': 'SE 6/8',
};

export const CELESTRON_DRIVER: TelescopeDriver = new NexStarDriver(
  'celestron',
  'Celestron NexStar',
  'Celestron (SE, SLT, Evo, GT, AVX, CGX, StarSense…)',
);
registerDriver(CELESTRON_DRIVER);
