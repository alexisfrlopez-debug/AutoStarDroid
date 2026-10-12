/**
 * Réglage fin télémétrique AUTOMATIQUE après GOTO (v2.2.0 — demande
 * utilisateur : « quand la précision télémétrie est activée et que je
 * pointe un objet avec la raquette ou l'appli, une fois le télescope
 * aligné sur l'objet demandé, qu'un réglage fin s'effectue automatiquement
 * grâce à la télémétrie du téléphone puis correction et validation de
 * l'utilisateur si besoin, et enregistrement des nouveaux paramètres de
 * télémétrie après validation »).
 *
 * DÉROULEMENT :
 *  1. un GOTO se termine (app OU raquette physique — auditeur :D# du
 *     client), la précision télémétrique est ACTIVÉE et une cible est
 *     connue (cible partagée de l'app, sinon position raquette) ;
 *  2. l'erreur de pointage est mesurée (fit Wahba + gyro) ;
 *  3. si l'erreur dépasse le seuil (2′) : CENTRAGE FIN automatique
 *     (impulsions guide, anti-backlash, signes appris — tracker.centerOnce) ;
 *  4. le résultat (avant → après) passe en ATTENTE DE VALIDATION : une
 *     bannière dans le panneau de suivi propose « Valider » (enregistre un
 *     NOUVEAU point d'alignement télémétrique — les paramètres du recalage
 *     s'améliorent) ou « Ignorer » ;
 *  5. rien ne bouge sans l'utilisateur : la validation n'envoie AUCUNE
 *     commande moteur, elle enregistre la télémétrie.
 *
 * JS pur côté app (aucune fonction passée au natif) — le pont ne voit que
 * des valeurs ; les auditeurs GOTO sont des callbacks internes au JS.
 */
import {autostar} from '../protocol/client';
import {useSettingsStore} from '../../store/settingsStore';
import {useTrackingStore, type TrackTarget} from '../../store/trackingStore';
import {telemetryFitOf, useTelemetryStore} from '../../store/telemetryStore';
import {applyFit, averageQuat, type Quat} from '../astro/telemetry';
import {pointingError} from '../astro/tracking';
import {raDecToAltAz} from '../astro/coords';
import {planetRaDec, type PlanetName} from '../astro/planets';
import {startOrientation} from '../phone/sensors';
import {telemetryTracker} from './tracker';
import {lastGotoVerdict} from '../../store/gotoCheckStore';
import {sleep} from '../util';


/** Sous ce résidu (min d'arc), pas de correction ni de demande de validation. */
const FINE_THRESHOLD_ARCMIN = 2;

let unsubscribe: (() => void) | null = null;
let busy = false;

/** Capture l'orientation moyenne du téléphone sur ~0,7 s (null si absent). */
async function captureQuat(): Promise<Quat | null> {
  const samples: Quat[] = [];
  const release = startOrientation((o) => {
    if (typeof o.qw === 'number') {
      samples.push({w: o.qw, x: o.qx ?? 0, y: o.qy ?? 0, z: o.qz ?? 0});
      if (samples.length > 12) samples.shift();
    }
  }, 100);
  try {
    await sleep(700);
    return averageQuat(samples);
  } finally {
    release();
  }
}

/** Mesure d'erreur de pointage pour une cible donnée (fit courant). */
function measureErr(target: TrackTarget, quat: Quat): number | null {
  const fit = telemetryFitOf(useTelemetryStore.getState().points);
  if (!fit || fit.rmsDeg > 0.5) return null;
  const site = useSettingsStore.getState().site;
  const nowD = new Date();
  const rd = target.moving
    ? planetRaDec(target.moving as PlanetName, nowD)
    : {raDeg: target.raDeg, decDeg: target.decDeg};
  const aa = applyFit(fit, quat);
  return pointingError(rd, aa, site.latDeg, site.lonDeg, nowD).totalArcmin;
}

/** Cible effective du réglage fin : cible partagée de l'app, sinon la
 *  position raquette (GOTO lancé SUR la raquette physique). */
function effectiveTarget(scopeRaDec: {raDeg: number; decDeg: number} | null): TrackTarget | null {
  const ts = useTrackingStore.getState();
  if (ts.target) return ts.target;
  if (scopeRaDec) {
    const t: TrackTarget = {
      name: 'Cible raquette',
      raDeg: scopeRaDec.raDeg,
      decDeg: scopeRaDec.decDeg,
      moving: null,
      from: 'scope',
    };
    useTrackingStore.getState().setTarget(t);
    return t;
  }
  return null;
}

/** Traite une arrivée de GOTO. Ne lève jamais (auditeur fire-and-forget). */
async function onGotoArrival(): Promise<void> {
  if (busy) return;
  const st = useSettingsStore.getState();
  if (!st.telemetryPrecision) return;
  const conn = autostar.isConnected();
  if (!conn) return;
  const target = effectiveTarget(autostar.scopeRaDec);
  if (!target) return;
  const ts = useTrackingStore.getState();

  busy = true;
  try {
    // 0. GARDE DE FLUIDITÉ (v2.3.0) : le contrôle croisé du slew qui vient
    //    de se terminer a-t-il jugé la télémétrie INSTABLE ? Alors AUCUNE
    //    correction automatique — on ne déplace pas des moteurs sur la foi
    //    d'une boussole qui décroche. L'utilisateur est informé (bannière
    //    'unreliable' du panneau de suivi) et peut valider plus tard.
    const verdict = lastGotoVerdict();
    if (verdict === 'poor') {
      await sleep(1200);
      const qb = await captureQuat();
      const errB = qb ? measureErr(target, qb) : null;
      ts.setFineTune({
        state: 'unreliable',
        beforeArcmin: errB,
        afterArcmin: null,
        iterations: 0,
        name: target.name,
      });
      return;
    }

    // 1. mesurer AVANT (le tube vient de s'arrêter — laisser se stabiliser)
    await sleep(1200);
    const q0 = await captureQuat();
    const before = q0 ? measureErr(target, q0) : null;
    if (before == null) return; // pas de fit exploitable : silencieux
    ts.setFineTune({state: before >= FINE_THRESHOLD_ARCMIN ? 'running' : 'idle', beforeArcmin: before, afterArcmin: null, iterations: 0, name: target.name});
    if (before < FINE_THRESHOLD_ARCMIN) return; // déjà précis : rien à faire

    // 2. centrage fin AUTOMATIQUE (impulsions guide via le tracker)
    ts.setPhase('centering');
    const r = await telemetryTracker.centerOnce();

    // 3. mesurer APRÈS → attente de validation utilisateur
    const q1 = await captureQuat();
    const after = q1 ? measureErr(target, q1) : null;
    ts.setFineTune({
      state: 'awaitValidation',
      beforeArcmin: before,
      afterArcmin: after ?? r.errArcmin,
      iterations: r.iterations,
      name: target.name,
    });
  } catch (_) {
    useTrackingStore.getState().setFineTune({state: 'idle'});
  } finally {
    busy = false;
  }
}

/** Abonne le service aux arrivées GOTO (à appeler UNE fois au démarrage). */
export function initFineTune(): void {
  if (unsubscribe) return;
  unsubscribe = autostar.onGotoArrival(() => {
    void onGotoArrival();
  });
}

/**
 * VALIDATION UTILISATEUR : enregistre un point d'alignement télémétrique
 * avec l'orientation ACTUELLE du téléphone (le tube vient d'être recorrigé
 * — la télémétrie validée améliore le recalage Wahba). Aucune commande
 * moteur : c'est un enregistrement pur.
 */
export async function validateFineTune(): Promise<boolean> {
  const ts = useTrackingStore.getState();
  const ft = ts.fineTune;
  if (ft.state !== 'awaitValidation' || !ts.target) return false;
  const target = ts.target;
  const q = await captureQuat();
  if (!q) {
    ts.setFineTune({state: 'idle', beforeArcmin: null, afterArcmin: null, iterations: 0, name: null});
    return false;
  }
  const site = useSettingsStore.getState().site;
  const nowD = new Date();
  const rd = target.moving
    ? planetRaDec(target.moving as PlanetName, nowD)
    : {raDeg: target.raDeg, decDeg: target.decDeg};
  const aa = raDecToAltAz(rd.raDeg, rd.decDeg, site.latDeg, site.lonDeg, nowD);
  useTelemetryStore.getState().addPoint({
    name: target.name,
    raDeg: rd.raDeg,
    decDeg: rd.decDeg,
    altDeg: aa.altDeg,
    azDeg: aa.azDeg,
    quat: q,
  });
  ts.setFineTune({state: 'applied'});
  return true;
}

/** L'utilisateur refuse la correction proposée. */
export function dismissFineTune(): void {
  useTrackingStore.getState().setFineTune({state: 'dismissed'});
}
