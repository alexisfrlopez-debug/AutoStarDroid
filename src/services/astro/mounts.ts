/**
 * Presets de monture (v2.2.0) — mathématiques pures.
 *
 * La raquette détectée (#494/#495/#497/Autostar II/LX200) identifie la
 * GÉNÉRATION de commandes, pas la monture mécanique : un #497 équipe aussi
 * bien un ETX-90 qu'un LX90. Les presets décrivent donc la MÉCANIQUE
 * (butées d'élévation réelles, taux attendus, jeu typique) pour :
 *  - borner le test des butées (garde = distance à parcourir / taux) ;
 *  - donner une base de ratio réaliste quand aucune mesure n'existe ;
 *  - proposer un jeu mécanique de départ (backlash) avant mesure ;
 *  - suggérer un mode d'alignement (Alt-Az sauf LX200 sur embase polaire).
 *
 * Détection : la réponse :GVP#/:GVN# (cf. matchFirmware dans client.ts)
 * identifie la RAQUETTE — le preset est déduit de cette génération, et
 * l'utilisateur peut toujours corriger (choix manuel) si la monture réelle
 * diffère (ex. #497 sur un tube autre que ETX/LX90).
 *
 * 100 % pur TypeScript, aucune dépendance RN — testable sous Jest.
 */
import type {ScopeModelId} from '../../store/settingsStore';

export type MountPresetId =
  | 'etx90' | 'etx105' | 'etx125' | 'lx90' | 'lx200' | 'ds114' | 'generic';

export interface MountPreset {
  id: MountPresetId;
  label: string;
  /** Butées d'élévation mécaniques (deg) — garde-fous du test des butées. */
  minAltDeg: number;
  maxAltDeg: number;
  /** Taux attendus sur le ciel (deg/s) — base du ratio si non calibré. */
  expectedRates: {center: number; find: number; slew: number};
  /** Jeu mécanique typique (secondes d'arc) — point de départ avant mesure. */
  typicalBacklashArcsec: {ra: number; dec: number};
  /** Monture azimutale d'origine (Alt-Az) ou à l'embase polaire. */
  altaz: boolean;
}

export const MOUNT_PRESETS: Record<MountPresetId, MountPreset> = {
  etx90: {
    id: 'etx90',
    label: 'ETX-90',
    minAltDeg: 8,
    maxAltDeg: 88,
    expectedRates: {center: 0.053, find: 2.0, slew: 5.0},
    typicalBacklashArcsec: {ra: 30, dec: 90},
    altaz: true,
  },
  etx105: {
    id: 'etx105',
    label: 'ETX-105',
    minAltDeg: 8,
    maxAltDeg: 88,
    expectedRates: {center: 0.053, find: 2.0, slew: 5.0},
    typicalBacklashArcsec: {ra: 30, dec: 90},
    altaz: true,
  },
  etx125: {
    id: 'etx125',
    label: 'ETX-125',
    minAltDeg: 10,
    maxAltDeg: 87,
    expectedRates: {center: 0.053, find: 2.0, slew: 4.5},
    typicalBacklashArcsec: {ra: 30, dec: 120},
    altaz: true,
  },
  lx90: {
    id: 'lx90',
    label: 'LX90',
    minAltDeg: 5,
    maxAltDeg: 90,
    expectedRates: {center: 0.08, find: 2.0, slew: 6.5},
    typicalBacklashArcsec: {ra: 25, dec: 60},
    altaz: true,
  },
  lx200: {
    id: 'lx200',
    label: 'LX200 / Autostar II',
    minAltDeg: 0,
    maxAltDeg: 90,
    expectedRates: {center: 0.08, find: 2.0, slew: 7.0},
    typicalBacklashArcsec: {ra: 20, dec: 45},
    altaz: false,
  },
  /* Meade DS-114AT (monture d'origine des DS, entraînement servo à pignons —
   * v2.2.1, demande utilisateur : « la raquette est réglée sur DS114 mais
   * l'application ne détecte pas cette monture »). La raquette #49x NE
   * TRANSMET PAS le choix de monture en série : ce preset est à choisir
   * MANUELLEMENT dans la carte Monture. Courbe alt-az en fourche : butées
   * larges ; pignons plus lents et plus jeux qu'un ETX (vis sans fin). */
  ds114: {
    id: 'ds114',
    label: 'DS-114 / série DS',
    minAltDeg: 0,
    maxAltDeg: 88,
    expectedRates: {center: 0.053, find: 2.0, slew: 3.5},
    typicalBacklashArcsec: {ra: 120, dec: 180},
    altaz: true,
  },
  generic: {
    id: 'generic',
    label: 'Autre / générique',
    minAltDeg: 0,
    maxAltDeg: 90,
    expectedRates: {center: 0.08, find: 0.4, slew: 2.0},
    typicalBacklashArcsec: {ra: 60, dec: 120},
    altaz: true,
  },
};

/**
 * Preset déduit de la RAQUETTE détectée (:GVP#/:GVN# via matchFirmware).
 * Le #49x équipe ETX/LX90 — sans information de tube, ETX-125 (le plus
 * courant sur #497) propose ses butées prudentes ; Autostar II → LX200 ;
 * LX200 classique → LX200. Renvoie null si la raquette est inconnue :
 * l'app garde le preset « générique » (butées larges, rien de spécial).
 * IMPORTANT (v2.2.1) : la monture RÉELLE n'est PAS transmise par la
 * raquette (Meade n'expose pas le menu Telescope > Mount en série) —
 * un #497 réglé « DS-114 » sur son clavier reste ici « ETX-125 ». La
 * carte Monture le rappelle et propose le choix manuel DS-114 (entre
 * autres) : c'est le choix manuel qui fait foi pour les presets.
 */
export function suggestPresetForModel(model: ScopeModelId | null): MountPresetId {
  switch (model) {
    case 'autostar2': return 'lx200';
    case 'autostar497': return 'etx125';
    case 'autostar495': return 'etx125';
    case 'autostar494': return 'etx90';
    case 'lx200': return 'lx200';
    default: return 'generic';
  }
}

/**
 * Garde-temps (s) d'une jambe du test des butées : le temps nécessaire pour
 * rejoindre la butée du preset depuis l'altitude de départ, au taux donné,
 * MAJORÉ d'une marge 1,4× (taux réel inférieur au nominal, approche douce).
 * Plafonné à 240 s : même une monture bloquée ne reste pas en mouvement.
 */
export function limitLegGuardSec(
  altStartDeg: number | null,
  goingUp: boolean,
  preset: MountPreset,
  rateDegPerSec: number,
): number {
  if (!(rateDegPerSec > 1e-4)) return 90;
  const limit = goingUp ? preset.maxAltDeg : preset.minAltDeg;
  const dist = altStartDeg == null
    ? Math.max(10, (preset.maxAltDeg - preset.minAltDeg) / 2) // altitude inconnue : moitié de la course
    : Math.max(2, Math.abs(limit - altStartDeg));
  return Math.min(240, Math.round((dist / rateDegPerSec) * 1.4) + 10);
}

/** Preset actif : le choix manuel s'il existe, sinon la suggestion. */
export function resolvePreset(
  manual: MountPresetId | 'auto',
  detectedModel: ScopeModelId | null,
): MountPreset {
  const id = manual === 'auto' ? suggestPresetForModel(detectedModel) : manual;
  return MOUNT_PRESETS[id] ?? MOUNT_PRESETS.generic;
}
