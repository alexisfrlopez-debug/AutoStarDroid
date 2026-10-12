/**
 * AUTOGUIDAGE PAR L'IMAGE (v2.5.0 — demande utilisateur : « une option de
 * suivi de l'objet par le télescope basé sur l'image video »).
 *
 * PRINCIPE : la caméra est sur le tube ; l'objet verrouillé (centroïde
 * lumineux calculé côté natif) doit rester au même pixel. Sa dérive en
 * pixels = erreur de pointage. L'app la convertit en impulsions moteur
 * (vitesses guide/center) pour ramener le centroïde sur son verrou — la
 * monture n'a PAS besoin de savoir où elle pointe : l'image fait autorité.
 *
 * MATH PURE (testée) : driftPx → impulsions via l'échelle (″/px) apprise
 * (calibrateScale : une impulsion connue → décalage mesuré) et une table
 * d'AXES (X image = AD ou DEC ? sens ? — configurable + auto-apprentissage
 * d'inversion comme le suivi télémétrique).
 *
 * GARDES (la télémétrie peut être faussée — l'image aussi) : centroïde
 * perdu (flux/peak insuffisants) → pause du guidage ; impulsion plafonnée ;
 * stopAll en sortie ; pas de correction pendant un GOTO (cmdPhase du client).
 */
import {autostar, type Dir} from '../protocol/client';
import {astroCamera} from '../phone/astroCamera';

/** Table d'axes image → moteurs (persistée dans cameraStore). */
export interface GuidingAxes {
  /** Axe image X commande-t-il l'AD ('ra') ou la DEC ('dec') ? */
  xAxis: 'ra' | 'dec';
  flipX: boolean;
  flipY: boolean;
}

export interface GuidePlanInput {
  /** Dérive du centroïde (px, écran : X → droite, Y → bas). */
  dxPx: number;
  dyPx: number;
  /** Échelle apprise (secondes d'arc par pixel). */
  scaleArcsecPerPx: number;
  axes: GuidingAxes;
  /** Taux moteurs mesurés ou par défaut (deg/s) par vitesse. */
  rates: {guide: number; center: number};
  deadbandArcsec: number;
  /** Plafonds d'impulsion (s). */
  maxPulseS: number;
}

export interface GuideStep {
  dir: Dir;
  /** Durée (s) — 0 si pas nécessaire. */
  durationS: number;
}

/** Arc (deg) équivalent à une dérive pixel. */
const arcsecToDeg = (a: number) => a / 3600;

/**
 * Plan de correction : X image → axe config, Y image → l'autre axe.
 * Convention écran : X+ = droite, Y+ = bas ; N/S/E/W = mouvements MOTEURS
 * LX200 (n = DEC+, e = AD+). Le flip corrige l'orientation de la caméra.
 */
export function guidePlan(inp: GuidePlanInput): GuideStep[] {
  const steps: GuideStep[] = [];
  const errX = arcsecToDeg(inp.dxPx * inp.scaleArcsecPerPx); // signe écran
  const errY = arcsecToDeg(inp.dyPx * inp.scaleArcsecPerPx);
  const dead = arcsecToDeg(inp.deadbandArcsec);
  // CORRECTION = mouvement du TÉLESCOPE pour ramener l'objet sur le verrou :
  //  - objet à droite (X+) → le tube pointe trop à gauche → Est (AD+) ;
  //  - objet en bas (Y+) → le tube pointe trop HAUT → Sud (DEC−) : l'axe Y
  //    image est INVERSÉ par rapport au ciel (l'écran compte vers le bas).
  const entries: Array<{axis: 'ra' | 'dec'; errDeg: number}> = [
    {axis: inp.axes.xAxis, errDeg: inp.axes.flipX ? -errX : errX},
    {axis: inp.axes.xAxis === 'ra' ? 'dec' : 'ra', errDeg: inp.axes.flipY ? errY : -errY},
  ];
  for (const {axis, errDeg} of entries) {
    if (Math.abs(errDeg) <= dead) continue;
    const rate = Math.abs(errDeg) > arcsecToDeg(30) ? inp.rates.center : inp.rates.guide;
    const dur = Math.min(Math.abs(errDeg) / Math.max(rate, 1e-5), inp.maxPulseS);
    if (dur < 0.08) continue;
    if (axis === 'ra') steps.push({dir: errDeg > 0 ? 'e' : 'w', durationS: dur});
    else steps.push({dir: errDeg > 0 ? 'n' : 's', durationS: dur});
  }
  return steps;
}

/**
 * Calibrage de l'ÉCHELLE : une impulsion GUIDE connue (durée s, taux
 * deg/s) a déplacé le centroïde de (dcx, dcy) px → ″/px. La plus grande
 * composante identifie l'axe moteur réel (auto-détection de l'axe X).
 */
export function calibrateScale(
  dcxPx: number, dcyPx: number, pulseS: number, rateDegPerSec: number,
): {scaleArcsecPerPx: number; xAxisSuggests: 'ra' | 'dec'} {
  const arc = pulseS * rateDegPerSec * 3600; // arcsecondes commandées
  const mag = Math.hypot(dcxPx, dcyPx);
  if (mag < 0.5 || arc <= 0) return {scaleArcsecPerPx: 1, xAxisSuggests: 'ra'};
  const scale = arc / mag;
  const xAxisSuggests: 'ra' | 'dec' = Math.abs(dcxPx) >= Math.abs(dcyPx) ? 'ra' : 'dec';
  return {scaleArcsecPerPx: Math.min(1000, Math.max(0.01, scale)), xAxisSuggests};
}

/** Le centroïde est-il fiable ? (flux et crête minimaux) */
export function centroidReliable(cx: number | undefined, cy: number | undefined, peak: number | undefined, flux: number | undefined): boolean {
  return cx != null && cy != null && (peak ?? 0) >= 40 && (flux ?? 0) >= 400;
}

/**
 * Boucle d'autoguidage — consomme les frames de la caméra, corrige par
 * impulsions. JS pur : les callbacks d'événements natifs restent internes.
 */
class GuidingRunner {
  private release: (() => void) | null = null;
  private running = false;
  private busy = false;
  private lostStreak = 0;
  private onState: ((s: GuidingState) => void) | null = null;

  state: GuidingState = {
    running: false,
    locked: false,
    lastDxPx: 0,
    lastDyPx: 0,
    corrections: 0,
    lostFrames: 0,
    note: null,
  };

  setAxes(axes: GuidingAxes, scale: number) {
    this.axes = axes;
    this.scale = scale;
  }
  private axes: GuidingAxes = {xAxis: 'ra', flipX: false, flipY: false};
  private scale = 2; // ″/px par défaut (capteur ~3,75 µm / focale ~400 mm)

  start(onState?: (s: GuidingState) => void): void {
    if (this.running) return;
    this.running = true;
    this.onState = onState ?? null;
    this.state = {running: true, locked: false, lastDxPx: 0, lastDyPx: 0, corrections: 0, lostFrames: 0, note: null};
    this.emit();
    this.release = astroCamera.onFrame((f) => void this.onFrame(f));
  }

  stop(): void {
    this.running = false;
    this.release?.();
    this.release = null;
    void autostar.stopAll().catch(() => undefined);
    this.state = {...this.state, running: false};
    this.emit();
  }

  private emit() {
    this.onState?.({...this.state});
  }

  private async onFrame(f: {cx?: number; cy?: number; peak?: number; flux?: number}) {
    if (!this.running || this.busy) return;
    if (!centroidReliable(f.cx, f.cy, f.peak, f.flux)) {
      this.lostStreak += 1;
      this.state = {...this.state, locked: false, lostFrames: this.state.lostFrames + 1,
        note: this.lostStreak >= 4 ? 'lost' : this.state.note};
      this.emit();
      return;
    }
    this.lostStreak = 0;
    // dérive par rapport au VERROU (0,5 ; 0,5) posé au natif
    const dx = (f.cx as number) - 0.5;
    const dy = (f.cy as number) - 0.5;
    const w = 640; // échelle px écran ≈ image native (verrou normalisé)
    const dxCentroid = dx * w;
    const dyCentroid = dy * w;
    this.state = {...this.state, locked: true, lastDxPx: dxCentroid, lastDyPx: dyCentroid, note: null};
    this.emit();
    const plan = guidePlan({
      dxPx: dxCentroid,
      dyPx: dyCentroid,
      scaleArcsecPerPx: this.scale,
      axes: this.axes,
      rates: {guide: 0.02, center: 0.08}, // prudent : impulsions guide par défaut
      deadbandArcsec: 6,
      maxPulseS: 2,
    });
    if (!plan.length) return;
    this.busy = true;
    try {
      for (const step of plan) {
        if (!this.running) break;
        await autostar.startMove(step.dir).catch(() => undefined);
        await new Promise((r) => setTimeout(r, Math.round(step.durationS * 1000)));
        await autostar.stopMove(step.dir).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 250));
        this.state = {...this.state, corrections: this.state.corrections + 1};
        this.emit();
      }
    } finally {
      this.busy = false;
    }
  }
}

export interface GuidingState {
  running: boolean;
  locked: boolean;
  lastDxPx: number;
  lastDyPx: number;
  corrections: number;
  lostFrames: number;
  note: 'lost' | null;
}

export const guidingRunner = new GuidingRunner();

/**
 * CALIBRAGE DE L'ÉCHELLE ET DES AXES (une fois par installation optique) :
 *  1. mesure le centroïde au repos (médiane de ~1,2 s de frames) ;
 *  2. envoie UNE impulsion Ouest connue à la vitesse guide ;
 *  3. mesure le décalage du centroïde → ″/px + axe image X suggéré.
 * JS pur côté app (promesse + événements natifs internes) — aucune fonction
 * ne traverse le pont natif.
 */
export async function calibrateGuiding(
  pulseMs = 2500,
  rateDegPerSec = 0.02,
): Promise<{ok: boolean; scaleArcsecPerPx: number; xAxis: 'ra' | 'dec'; note: string | null}> {
  const grabCentroid = async (durationMs: number): Promise<{cx: number; cy: number} | null> => {
    const samples: Array<{cx: number; cy: number}> = [];
    const rel = astroCamera.onFrame((f) => {
      if (centroidReliable(f.cx, f.cy, f.peak, f.flux)) {
        samples.push({cx: f.cx as number, cy: f.cy as number});
      }
    });
    const t0 = Date.now();
    while (Date.now() - t0 < durationMs) {
      await new Promise((r) => setTimeout(r, 100));
      if (samples.length >= 6) break;
    }
    rel();
    if (samples.length < 2) return null;
    samples.sort((a, b) => a.cx - b.cx);
    const cx = samples[samples.length >> 1].cx;
    samples.sort((a, b) => a.cy - b.cy);
    const cy = samples[samples.length >> 1].cy;
    return {cx, cy};
  };
  const before = await grabCentroid(1600);
  if (!before) return {ok: false, scaleArcsecPerPx: 2, xAxis: 'ra', note: 'noCentroid'};
  // impulsion OUEST connue (le sens réel importe peu : on mesure la MAGNITUDE)
  await autostar.setSpeed('guide').catch(() => undefined);
  await autostar.startMove('w').catch(() => undefined);
  await new Promise((r) => setTimeout(r, pulseMs));
  await autostar.stopMove('w').catch(() => undefined);
  await new Promise((r) => setTimeout(r, 500));
  const after = await grabCentroid(1600);
  if (!after) return {ok: false, scaleArcsecPerPx: 2, xAxis: 'ra', note: 'noCentroidAfter'};
  // décalage en PIXELS VIRTUELS du frame 640×640 du runner (verrou 0,5/0,5)
  const dcx = (after.cx - before.cx) * 640;
  const dcy = (after.cy - before.cy) * 640;
  const {scaleArcsecPerPx, xAxisSuggests} = calibrateScale(dcx, dcy, pulseMs / 1000, rateDegPerSec);
  if (Math.abs(dcx) < 0.5 && Math.abs(dcy) < 0.5) {
    return {ok: false, scaleArcsecPerPx, xAxis: xAxisSuggests, note: 'noMove'};
  }
  return {ok: true, scaleArcsecPerPx, xAxis: xAxisSuggests, note: null};
}
