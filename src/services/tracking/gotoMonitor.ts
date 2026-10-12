/**
 * Moniteur de GOTO (v2.3.0) — collecte en DIRECT, pendant chaque slew lancé
 * par l'app, les deux sources de vérité :
 *  - le GYROSCOPE brut (solidaire du tube) = mouvement des MOTEURS ;
 *  - le ROTATION VECTOR (orientation absolue) = TÉLÉMÉTRIE du téléphone.
 *
 * Armé par l'événement `onGotoStart` du client (GOTO app), clôturé à
 * l'ARRIVÉE (`onGotoArrival`) ou par garde-temps (4 min). Le verdict croisé
 * (gotocheck.crossCheck) est posé dans gotoCheckStore :
 *  - l'UI de la carte du ciel affiche les deux arcs et la qualité ;
 *  - le réglage fin automatique (fineTune) REFUSE de déplacer les moteurs
 *    sur une télémétrie jugée instable (« poor ») — la garde demandée par
 *    l'utilisateur : « la télémétrie peut être faussée ou avoir des
 *    problèmes de sensibilité ».
 *
 * JS pur côté app : les callbacks restent internes au JS, rien ne traverse
 * le pont natif (règle de survie v1.7.2).
 */
import {autostar} from '../protocol/client';
import {startOrientation, startGyro, sensorsAvailable} from '../phone/sensors';
import {useGotoCheckStore} from '../../store/gotoCheckStore';
import {useTrackingStore} from '../../store/trackingStore';
import {useScopeStore} from '../../store/scopeStore';
import {crossCheck, gyroPathDeg, telePathDeg, type TeleSample, type GyroLite} from '../astro/gotocheck';
import {sleep} from '../util';


const TELE_INTERVAL_MS = 200; // 5 Hz : suffisant pour la fluidité, léger
const GYRO_INTERVAL_MS = 60;
const MAX_SLEW_S = 240; // garde : un GOTO ne dure jamais si longtemps
const LIVE_PERIOD_MS = 1000;

class GotoMonitor {
  private tele: TeleSample[] = [];
  private gyro: GyroLite[] = [];
  private releaseTele: (() => void) | null = null;
  private releaseGyro: (() => void) | null = null;
  private startedAt = 0;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private liveTimer: ReturnType<typeof setInterval> | null = null;

  /** GOTO de l'app démarré : on arme la collecte (silencieux si capteurs absents). */
  async arm(targetName: string | null): Promise<void> {
    this.disarmCollectors();
    const st = useGotoCheckStore.getState();
    st.reset();
    const sensors = await sensorsAvailable().catch(() => null);
    if (!sensors || !(sensors.rotationVector || sensors.gyroscope)) {
      st.setNoSensors(); // monitoring sans mesure : verdict 'unknown'
      return;
    }
    this.tele = [];
    this.gyro = [];
    this.startedAt = Date.now();
    this.active = true;
    st.setMonitoring(targetName);
    this.releaseTele = startOrientation((o) => {
      if (typeof o.qw === 'number') {
        this.tele.push({t: Date.now(), qw: o.qw, qx: o.qx ?? 0, qy: o.qy ?? 0, qz: o.qz ?? 0});
        if (this.tele.length > 4000) this.tele.shift();
      }
    }, TELE_INTERVAL_MS);
    this.releaseGyro = startGyro((g) => {
      this.gyro.push({t: g.ts, x: g.x, y: g.y, z: g.z});
      if (this.gyro.length > 8000) this.gyro.shift();
    }, GYRO_INTERVAL_MS);
    // Arcs live ~1 Hz pour l'UI (carte du ciel)
    this.liveTimer = setInterval(() => {
      if (!this.active) return;
      const bias = this.gyroBias();
      const t1 = Date.now();
      useGotoCheckStore.getState().setLive(
        gyroPathDeg(this.gyro, this.startedAt, t1, bias),
        telePathDeg(this.tele, this.startedAt, t1),
      );
    }, LIVE_PERIOD_MS);
    this.timer = setTimeout(() => void this.finish('timeout'), MAX_SLEW_S * 1000);
  }

  /** Biais gyro : médiane simple des 1,5 premières secondes (pré-slew). */
  private gyroBias(): GyroLite {
    const pre = this.gyro.filter((s) => s.t <= this.startedAt + 1500);
    if (pre.length < 4) return {t: 0, x: 0, y: 0, z: 0};
    const med = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)] ?? 0;
    };
    return {t: 0, x: med(pre.map((s) => s.x)), y: med(pre.map((s) => s.y)), z: med(pre.map((s) => s.z))};
  }

  /** Clôture : verdict croisé posé dans le store (arrivée OU garde-temps). */
  async finish(_reason: 'arrival' | 'timeout'): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {clearTimeout(this.timer); this.timer = null;}
    if (this.liveTimer) {clearInterval(this.liveTimer); this.liveTimer = null;}
    const t1 = Date.now();
    this.releaseTele?.(); this.releaseTele = null;
    this.releaseGyro?.(); this.releaseGyro = null;
    const st = useGotoCheckStore.getState();
    // laisser le tampon d'événements se vider (événements natifs asynchrones)
    await sleep(400);
    const bias = this.gyroBias();
    const report = crossCheck(this.gyro, this.tele, this.startedAt, t1, {
      expectedTeleMs: TELE_INTERVAL_MS,
      bias,
    });
    st.setReport(report);
  }

  /** Désarme la collecte SANS verdict (déconnexion, nouveau GOTO…). */
  private disarmCollectors(): void {
    this.active = false;
    if (this.timer) {clearTimeout(this.timer); this.timer = null;}
    if (this.liveTimer) {clearInterval(this.liveTimer); this.liveTimer = null;}
    this.releaseTele?.(); this.releaseTele = null;
    this.releaseGyro?.(); this.releaseGyro = null;
  }
}

export const gotoMonitor = new GotoMonitor();

let inited = false;
/** Abonne le moniteur aux événements GOTO du client (UNE fois au démarrage). */
export function initGotoMonitor(): void {
  if (inited) return;
  inited = true;
  autostar.onGotoStart(() => {
    // Nom de cible : cible partagée de l'app, sinon cible raquette (posée
    // juste avant le GOTO par l'écran appelant) — le store gotoCheck vient
    // d'être réarmé, il ne connaît pas encore le nom.
    const name = useTrackingStore.getState().target?.name
      ?? (useScopeStore.getState().targetName || null);
    void gotoMonitor.arm(name);
  });
  autostar.onGotoArrival(() => {
    void gotoMonitor.finish('arrival');
  });
}
