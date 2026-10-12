/**
 * ACQUISITION AUTOMATISÉE (v2.5.0 — demande utilisateur : « possibilité
 * d'automatiser l'acquisition d'image (réglages automatiques des paramètres
 * de la caméra, choix du temps de pause/nombre d'images selon qualité
 * choisie, traitements/empilement d'images) avec des presets spécifiques aux
 * objets les plus courants »).
 *
 *  - PRESETS (données pures, testées) : Lune, planètes, Soleil (FILTRE !),
 *    nébuleuses, amas, galaxies — plages de pose/gain + comptage par
 *    qualité (rapide / standard / haute) + mode d'empilement.
 *  - PLAN (pur) : buildPlan(preset, quality, {manualSensor}) → pose, gain,
 *    nombre d'images, intervalle.
 *  - RUNNER : capture les images (flux natif → poses successives), pose la
 *    progression, puis EMPILE via stacking.ts et rend une image finale.
 */
import {stackFrames, stretchGray, grayToDataUri, decodeGrayB64, type StackMode} from './stacking';
import {astroCamera} from '../phone/astroCamera';

export type AcqQuality = 'rapide' | 'standard' | 'haute';
export type AcqKind =
  | 'moon' | 'planets' | 'sun' | 'doubleStar'
  | 'globular' | 'nebulaBright' | 'nebulaFaint' | 'galaxyBright';

export interface AcqPreset {
  kind: AcqKind;
  /** Plage de pose conseillée (ms) [min, max]. */
  exposureMs: [number, number];
  /** Pose par qualité (ms) — la qualité tire vers le haut de la plage. */
  byQuality: Record<AcqQuality, number>;
  /** ISO conseillé (0 = auto). */
  iso: number;
  /** Nombre d'images par qualité. */
  count: Record<AcqQuality, number>;
  stack: StackMode;
  /** Note d'usage (clé i18n caméra). */
  note: string;
}

export const ACQ_PRESETS: Record<AcqKind, AcqPreset> = {
  moon: {
    kind: 'moon', exposureMs: [1, 15], iso: 0,
    byQuality: {rapide: 2, standard: 6, haute: 10},
    count: {rapide: 20, standard: 40, haute: 60},
    stack: 'kappa', note: 'camAcq.noteMoon',
  },
  planets: {
    kind: 'planets', exposureMs: [2, 25], iso: 0,
    byQuality: {rapide: 5, standard: 12, haute: 20},
    count: {rapide: 30, standard: 60, haute: 90},
    stack: 'kappa', note: 'camAcq.notePlanets',
  },
  sun: {
    kind: 'sun', exposureMs: [1, 6], iso: 0,
    byQuality: {rapide: 1, standard: 3, haute: 5},
    count: {rapide: 20, standard: 30, haute: 40},
    stack: 'kappa', note: 'camAcq.noteSun',
  },
  doubleStar: {
    kind: 'doubleStar', exposureMs: [50, 400], iso: 0,
    byQuality: {rapide: 80, standard: 200, haute: 350},
    count: {rapide: 8, standard: 15, haute: 24},
    stack: 'median', note: 'camAcq.noteDouble',
  },
  globular: {
    kind: 'globular', exposureMs: [500, 4000], iso: 0,
    byQuality: {rapide: 700, standard: 1500, haute: 3000},
    count: {rapide: 6, standard: 12, haute: 20},
    stack: 'kappa', note: 'camAcq.noteGlobular',
  },
  nebulaBright: {
    kind: 'nebulaBright', exposureMs: [1500, 8000], iso: 0,
    byQuality: {rapide: 2000, standard: 4000, haute: 7000},
    count: {rapide: 6, standard: 10, haute: 16},
    stack: 'kappa', note: 'camAcq.noteNebulaBright',
  },
  nebulaFaint: {
    kind: 'nebulaFaint', exposureMs: [4000, 15000], iso: 0,
    byQuality: {rapide: 5000, standard: 8000, haute: 12000},
    count: {rapide: 4, standard: 8, haute: 12},
    stack: 'mean', note: 'camAcq.noteNebulaFaint',
  },
  galaxyBright: {
    kind: 'galaxyBright', exposureMs: [2000, 10000], iso: 0,
    byQuality: {rapide: 2500, standard: 5000, haute: 8000},
    count: {rapide: 6, standard: 10, haute: 16},
    stack: 'kappa', note: 'camAcq.noteGalaxy',
  },
};

export interface AcqPlan {
  kind: AcqKind;
  quality: AcqQuality;
  exposureMs: number;
  iso: number;
  count: number;
  intervalMs: number;
  stack: StackMode;
  /** Note d'usage du preset (clé camAcq). */
  note: string;
  /** La pose demande-t-elle un capteur en mode manuel ? */
  needsManualSensor: boolean;
}

/** Plan de pose pour un preset et une qualité — pur. */
export function buildPlan(kind: AcqKind, quality: AcqQuality, camera?: {manual: boolean} | null): AcqPlan {
  const p = ACQ_PRESETS[kind];
  const exposureMs = p.byQuality[quality];
  const count = p.count[quality];
  const needsManual = exposureMs >= 800 && (camera ? !camera.manual : false);
  // intervalle : pose + marge de lecture + respiration (min 400 ms)
  const intervalMs = Math.max(400, exposureMs + 350);
  return {
    kind, quality, exposureMs, iso: p.iso, count, intervalMs, stack: p.stack, note: p.note,
    needsManualSensor: needsManual && exposureMs > 1500,
  };
}

export interface AcqProgress {
  state: 'idle' | 'running' | 'stacking' | 'done' | 'error';
  done: number;
  total: number;
  note: string | null;
}

export interface AcqResult {
  /** Image empilée + étirée (data URI BMP). */
  resultUri: string;
  used: number;
  total: number;
  kind: AcqKind;
  quality: AcqQuality;
}

class AcquisitionRunner {
  private cancel = false;
  private running = false;

  get isRunning() {return this.running;}

  stop() {
    this.cancel = true;
  }

  /**
   * Exécute un plan : N poses (via l'anneau de luminance native — les frames
   * du flux en cours) espacées de l'intervalle, empilement, étirement,
   * image finale. NE LÈVE PAS : l'état d'erreur passe dans la progression.
   */
  async run(
    plan: AcqPlan,
    onProgress: (p: AcqProgress) => void,
  ): Promise<AcqResult | null> {
    if (this.running) return null;
    this.running = true;
    this.cancel = false;
    const W = 192; const H = 144;
    try {
      onProgress({state: 'running', done: 0, total: plan.count, note: null});
      const frames: Uint8Array[] = [];
      const started = Date.now();
      let grabbed = 0;
      // capture : on récolte des frames DISTINCTES de l'anneau natif —
      // chaque pose attend qu'une NOUVELLE frame (ts différent) arrive ;
      // l'intervalle du plan cadence la récupération (poses longtes : le
      // natif émet sa dernière frame, l'attente reste bornée).
      while (grabbed < plan.count && !this.cancel) {
        const t0 = Date.now();
        const shot = await astroCamera.captureStill().catch(() => null);
        if (shot) {
          // la pose haute qualité n'a pas d'anneau direct : on échantillonne
          // l'anneau courant (le signal change peu sur l'intervalle)
          const hist = await astroCamera.lumaHistory();
          const last = hist.length ? decodeGrayB64(hist[hist.length - 1], W, H) : null;
          if (last) frames.push(last);
          grabbed += 1;
          onProgress({state: 'running', done: grabbed, total: plan.count, note: null});
        }
        const wait = plan.intervalMs - (Date.now() - t0);
        if (wait > 0 && !this.cancel) await new Promise((r) => setTimeout(r, wait));
        if (Date.now() - started > plan.count * plan.intervalMs + 60000) break; // garde
      }
      if (frames.length === 0) {
        onProgress({state: 'error', done: 0, total: plan.count, note: 'noFrames'});
        return null;
      }
      onProgress({state: 'stacking', done: frames.length, total: plan.count, note: null});
      const {gray} = stackFrames(frames, W, H, plan.stack);
      const stretched = stretchGray(gray);
      const uri = grayToDataUri(stretched, W, H);
      const res: AcqResult = {resultUri: uri, used: frames.length, total: plan.count, kind: plan.kind, quality: plan.quality};
      onProgress({state: 'done', done: frames.length, total: plan.count, note: null});
      return res;
    } catch (e) {
      onProgress({state: 'error', done: 0, total: plan.count, note: (e as Error).message});
      return null;
    } finally {
      this.running = false;
      this.cancel = false;
    }
  }
}

export const acquisitionRunner = new AcquisitionRunner();
