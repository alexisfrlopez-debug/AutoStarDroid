/**
 * Cerveau du télescope SIMULÉ (mode Démo) — émulateur Autostar II complet.
 * Implémente le jeu de commandes Meade/LX200 avec mouvement physique simulé,
 * suivi sidéral, horizon, alignement, date/heure/site réels du téléphone.
 */
import {raDecToAltAz, altAzToRaDec, separationDeg} from '../astro/coords';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const SIDEREAL_DEG_S = 360.9856 / 86400; // ~0.004178 °/s

interface Site {latDeg: number; lonDeg: number}

export class DemoScopeBrain {
  private site: Site = {latDeg: 48.8566, lonDeg: 2.3522};
  private raDeg: number;
  private decDeg: number;
  private target: {raDeg: number; decDeg: number} | null = null;
  private speed = 'center' as 'guide' | 'center' | 'find' | 'slew';
  private moving = {n: false, s: false, e: false, w: false};
  private gotoUntil: number | null = null;
  private tracking = true;
  private aligned = false;
  private lastTick = Date.now();
  private selRa = '00:00:00';
  private selDec = '+00*00';
  private focusMoving: '+' | '-' | null = null;
  private focusPos = 0;
  private tzOffset = 0; // sHH (négatif = ouest)
  private pendingAlign: string | null = null;
  private sites: Site[] = [
    {latDeg: 48.8566, lonDeg: 2.3522},
    {latDeg: 45.1885, lonDeg: 0.7193},
    {latDeg: 43.6108, lonDeg: 3.8767},
    {latDeg: 0, lonDeg: 0},
  ];
  private activeSite = 0;

  constructor() {
    // départ : zenith du site
    const now = new Date();
    const {raDeg, decDeg} = altAzToRaDec(70, 180, this.site.latDeg, this.site.lonDeg, now);
    this.raDeg = raDeg;
    this.decDeg = decDeg;
  }

  setSiteForDemo(site: Site) {this.site = {...site}; this.sites[0] = {...site};}

  private tick() {
    const now = Date.now();
    const dt = Math.min((now - this.lastTick) / 1000, 5);
    this.lastTick = now;
    if (dt <= 0) return;
    let alt = 0; let az = 0; let decRate = 0; let raRate = 0;
    if (this.tracking && !this.anyMoving() && this.gotoUntil === null) {
      raRate = SIDEREAL_DEG_S; // suivi : la monture compense, mais simule la dérive relative
    }
    if (this.gotoUntil !== null) {
      // GOTO : accélération simplifiée à vitesse slew vers la cible
      if (now >= this.gotoUntil) {
        this.gotoUntil = null;
        this.raDeg = this.target!.raDeg;
        this.decDeg = this.target!.decDeg;
        this.tracking = true;
        if (this.pendingAlign) {
          this.aligned = true;
          this.pendingAlign = null;
        }
      } else {
        const remain = (this.gotoUntil - now) / 1000;
        const dRa = ((((this.target!.raDeg - this.raDeg) % 360) + 540) % 360) - 180;
        const dDec = this.target!.decDeg - this.decDeg;
        raRate = dRa / Math.max(remain, 0.05);
        decRate = dDec / Math.max(remain, 0.05);
      }
    } else if (this.anyMoving()) {
      const rate = {guide: SIDEREAL_DEG_S * 2, center: 0.25, find: 1.5, slew: 6}[this.speed];
      if (this.moving.n) decRate += rate;
      if (this.moving.s) decRate -= rate;
      if (this.moving.e) raRate -= rate;
      if (this.moving.w) raRate += rate;
      this.tracking = false;
    }
    this.decDeg = Math.max(-89.9, Math.min(89.9, this.decDeg + decRate * dt));
    this.raDeg = ((this.raDeg + raRate * dt) % 360 + 360) % 360;
    if (this.focusMoving === '+') this.focusPos += dt;
    if (this.focusMoving === '-') this.focusPos = Math.max(0, this.focusPos - dt);
    void alt; void az; void D2R; void R2D;
  }

  private anyMoving() {
    return this.moving.n || this.moving.s || this.moving.e || this.moving.w;
  }

  /** Traite une commande et renvoie la réponse (peut être ''). */
  handle(cmd: string): string {
    this.tick();
    const c = cmd.trim().replace(/#$/, '');
    if (!c.startsWith(':')) return '';
    const belowHorizon = (ra: number, dec: number) => {
      const aa = raDecToAltAz(ra, dec, this.site.latDeg, this.site.lonDeg, new Date());
      return aa.altDeg < 0;
    };
    switch (true) {
      case c === ':Gr' || c === ':GR':
        return this.hms(this.raDeg) + '#';
      case c === ':Gd' || c === ':GD':
        return this.dms(this.decDeg) + '#';
      case c === ':Gz':
        return this.dms(raDecToAltAz(this.raDeg, this.decDeg, this.site.latDeg, this.site.lonDeg, new Date()).azDeg) + '#';
      case c === ':Galt' || c === ':Ga':
        return this.dms(raDecToAltAz(this.raDeg, this.decDeg, this.site.latDeg, this.site.lonDeg, new Date()).altDeg) + '#';
      case c === ':GL': {
        const d = new Date(Date.now() - this.tzOffset * 3600e3);
        return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}#`;
      }
      case c === ':GC': {
        const d = new Date(Date.now() - this.tzOffset * 3600e3);
        return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${String(d.getUTCFullYear()).slice(2)}#`;
      }
      case c === ':GG':
        return `${this.tzOffset >= 0 ? '+' : '-'}${String(Math.abs(Math.round(this.tzOffset / 3600))).padStart(2, '0')}#`;
      case c.startsWith(':SG'): {
        const m = c.match(/^:SG([+-])(\d{1,2})/);
        if (m) this.tzOffset = (m[1] === '-' ? -1 : 1) * +m[2] * 3600;
        return '1#';
      }
      case c.startsWith(':SL'): {
        const m = c.match(/^:SL(\d{1,2}):(\d{2}):(\d{2})/);
        return m ? '1#' : '0#'; // l'horloge simulée est déjà juste
      }
      case c.startsWith(':SC'):
        return '1#';
      case c === ':Gt':
        return this.dms(this.site.latDeg) + '#';
      case c === ':Gg':
        return this.dms(this.site.lonDeg) + '#';
      case c.startsWith(':St'): {
        const v = this.parseDms(c.slice(3));
        if (v === null || Math.abs(v) > 90) return '0#';
        this.site.latDeg = v; this.sites[this.activeSite] = {...this.site};
        return '1#';
      }
      case c.startsWith(':Sg'): {
        const v = this.parseDms(c.slice(3));
        if (v === null) return '0#';
        this.site.lonDeg = v; this.sites[this.activeSite] = {...this.site};
        return '1#';
      }
      case c === ':GM': case c === ':GN': case c === ':GO': case c === ':GP':
        return 'SITE#' ;
      case c === ':W1': case c === ':W2': case c === ':W3': case c === ':W4': {
        const idx = +c[2] - 1;
        if (idx >= 0 && idx < 4) {this.activeSite = idx; this.site = {...this.sites[idx]};}
        return '';
      }
      case c.startsWith(':Sr'):
        this.selRa = c.slice(3);
        return '1#';
      case c.startsWith(':Sd'): {
        const v = this.parseDms(c.slice(3));
        this.selDec = c.slice(3);
        return v !== null ? '1#' : '0#';
      }
      case c === ':MS': {
        const ra = this.hmsToDeg(this.selRa);
        const dec = this.parseDms(this.selDec);
        if (ra === null || dec === null) return '2#';
        if (belowHorizon(ra, dec)) return '1#';
        const dist = separationDeg(this.raDeg, this.decDeg, ra, dec);
        const dur = Math.min(Math.max(dist / 6, 0.8), 45); // ~6°/s
        this.target = {raDeg: ra, decDeg: dec};
        this.gotoUntil = Date.now() + dur * 1000;
        this.aligned = this.aligned; // pas de changement
        return '0#';
      }
      case c === ':CM':
        this.target = {raDeg: this.raDeg, decDeg: this.decDeg};
        this.tracking = true;
        return 'TARGET SYNCED#';
      case c === ':Mn': this.moving.n = true; return '';
      case c === ':Ms': this.moving.s = true; return '';
      case c === ':Me': this.moving.e = true; return '';
      case c === ':Mw': this.moving.w = true; return '';
      case c === ':Qn': this.moving.n = false; return '';
      case c === ':Qs': this.moving.s = false; return '';
      case c === ':Qe': this.moving.e = false; return '';
      case c === ':Qw': this.moving.w = false; return '';
      case c === ':Q': this.moving = {n: false, s: false, e: false, w: false}; this.gotoUntil = null; return '';
      case c === ':RG': this.speed = 'guide'; return '';
      case c === ':RC': this.speed = 'center'; return '';
      case c === ':RM': this.speed = 'find'; return '';
      case c === ':RS': this.speed = 'slew'; return '';
      case c === ':AA': this.tracking = true; return '';
      case c === ':AP': this.tracking = true; return '';
      case c === ':AL': this.tracking = false; return '';
      case c === ':Aa': case c === ':Ab': case c === ':Ac': case c === ':Ad': case c === ':Ae':

        this.pendingAlign = c;
        // cible : étoile brillante simulée au-dessus de 45°
        this.target = {raDeg: (this.raDeg + 30) % 360, decDeg: 45};
        this.gotoUntil = Date.now() + 4000;
        return '';
      case c === ':hP':
        this.tracking = false;
        return '';
      case c === ':GVP':
        return 'Autostar II#';
      case c === ':GVN':
        return '43Eg#';
      case c === ':GVD':
        return 'HSM#';
      case c === ':GVT':
        return '1.0g#';
      case c === ':Gc':
        return 'CK#';
      case c === ':F+': this.focusMoving = '+'; return '';
      case c === ':F-': this.focusMoving = '-'; return '';
      case c === ':FQ': this.focusMoving = null; return '';
      case c === ':FP': this.focusMoving = '+'; return '';
      case c === ':FS': this.focusMoving = '-'; return '';
      case c === ':GPS':
        return '';
      default:
        return '';
    }
  }

  private hms(raDeg: number): string {
    const ra = (((raDeg % 360) + 360) % 360) / 15;
    const h = Math.floor(ra);
    const m = Math.floor((ra - h) * 60);
    const s = Math.round(((ra - h) * 60 - m) * 60);
    const s2 = s === 60 ? 0 : s;
    const m2 = s === 60 ? (m === 59 ? 0 : m + 1) : m;
    const h2 = s === 60 && m === 59 ? (h + 1) % 24 : h;
    return `${p(h2)}:${p(m2)}:${p(s2)}`;
  }

  private dms(deg: number): string {
    const sign = deg < 0 ? '-' : '+';
    const d = Math.abs(deg);
    const dd = Math.floor(d);
    const mm = Math.round((d - dd) * 60);
    const mm2 = mm === 60 ? 0 : mm;
    const dd2 = mm === 60 ? dd + 1 : dd;
    return `${sign}${p(dd2)}*${p(mm2)}`;
  }

  private hmsToDeg(s: string): number | null {
    const m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return (+m[1] + +m[2] / 60 + +m[3] / 3600) * 15;
  }

  private parseDms(s: string): number | null {
    const m = s.match(/^([+-]?)\s*(\d{1,3})\*?(\d{1,2})?/);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (+m[2] + (+m[3] || 0) / 60);
  }
}

function p(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
