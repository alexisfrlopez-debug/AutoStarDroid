/**
 * CATALOGUE MONTURES & TÉLESCOPES (v2.7.0 — demande utilisateur : « pour les
 * modèles de montures/télescopes, je voudrais une liste de choix aussi
 * fournie que pour Meade pour chaque marque, avec un menu déroulant pour
 * choisir la marque et un autre menu déroulant pour les modèles, menu
 * déroulant qui sera alimenté en fonction de la marque choisie. et si
 * l'utilisateur ne trouve pas la marque/le modèle correspondant, la
 * possibilité de choisir manuellement les caractéristiques du modèle/
 * marque. il faudra un onglet entier dédié à ça et supprimer les
 * redondances dans les autres onglets »).
 *
 * Source de vérité UNIQUE de la sélection de monture :
 *  - Onglet « Montures » : marque → modèle (listes en cascade), ou saisie
 *    manuelle complète (marque « Autre » ou modèle non listé) ;
 *  - L'application écrit dans les réglages existants (protocole, interface
 *    de raquette, preset mécanique) — diagnostic, butées, taux, alignement
 *    et connexion utilisent SANS CHANGEMENT la base v2.6.0 ;
 *  - 100 % pur TypeScript (aucune dépendance RN) — testable sous Jest.
 */
import type {DriverId, DriverPref} from '../protocol/driver';
import type {MountPresetId, MountPreset} from '../astro/mounts';
import {MOUNT_PRESETS, resolvePreset} from '../astro/mounts';
import type {ScopeModelId} from '../../store/settingsStore';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type BrandId =
  | 'meade' | 'celestron' | 'skywatcher' | 'ioptron' | 'orion' | 'vixen'
  | 'losmandy' | 'explore' | 'bresser' | 'tenmicron' | 'astrophysics'
  | 'zwo' | 'other';

export interface MountModelInfo {
  id: string;
  label: string;
  /** Le modèle a des moteurs GOTO (sinon : informationnel seulement). */
  goto: boolean;
  /** Protocole de connexion — null = non pris en charge à ce jour. */
  protocol: DriverId | null;
  /** Génération de raquette Meade (profils/limites de commandes). */
  interfaceId: ScopeModelId;
  /** Preset mécanique (butées d'élévation, taux, jeu). */
  preset: MountPresetId;
  noteFr?: string;
  noteEn?: string;
}

export interface MountBrand {
  id: BrandId;
  label: string;
  /** Protocole majoritaire de la marque (affichage). */
  protocol: DriverId | null;
  models: MountModelInfo[];
}

/** Saisie manuelle (marque « Autre » ou modèle non listé). */
export interface CustomMount {
  /** Nom saisi par l'utilisateur (« ma EQ5 maison »…). */
  label: string;
  /** Protocole — 'auto' = détection à la connexion. */
  protocol: DriverPref;
  /** Monture azimutale (Alt-Az) ou à embase polaire. */
  altaz: boolean;
  /** Butées d'élévation réelles saisies (garde des tests). */
  minAltDeg: number;
  maxAltDeg: number;
  /** Référence de taux/jeu (famille mécanique la plus proche). */
  preset: MountPresetId;
  /** true tant que la config personnalisée est la sélection courante. */
  active: boolean;
}

export interface MountConfig {
  brandLabel: string;
  modelLabel: string;
  driverPref: DriverPref;
  interfaceId: ScopeModelId;
  preset: MountPresetId;
  custom: CustomMount | null;
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

function m(
    brand: string, slug: string, label: string,
    protocol: DriverId | null, interfaceId: ScopeModelId, preset: MountPresetId,
    noteFr?: string, noteEn?: string, goto = true,
): MountModelInfo {
  return {id: `${brand}-${slug}`, label, protocol, interfaceId, preset, goto, noteFr, noteEn};
}

export const BRANDS: MountBrand[] = [
  {
    id: 'meade',
    label: 'Meade',
    protocol: 'meade',
    models: [
      m('meade', 'etx60', 'ETX-60 AT', 'meade', 'autostar494', 'etx90'),
      m('meade', 'etx70', 'ETX-70 AT', 'meade', 'autostar494', 'etx90'),
      m('meade', 'etx80', 'ETX-80 AT-TC / Observer', 'meade', 'autostar494', 'etx90'),
      m('meade', 'etx90', 'ETX-90 (RA/EC/AT/Observer)', 'meade', 'autostar497', 'etx90'),
      m('meade', 'etx105', 'ETX-105 (EC/AT/Observer)', 'meade', 'autostar497', 'etx105'),
      m('meade', 'etx125', 'ETX-125 (EC/AT/Observer)', 'meade', 'autostar497', 'etx125'),
      m('meade', 'ds90', 'DS-90 AT', 'meade', 'autostar494', 'ds114'),
      m('meade', 'ds114', 'DS-114 AT', 'meade', 'autostar494', 'ds114'),
      m('meade', 'ds2000', 'Série DS-2000 (2090/2102/2114/2130)', 'meade', 'autostar494', 'ds114'),
      m('meade', 'starnavigator', 'StarNavigator NG 102/125', 'meade', 'autostar494', 'ds114'),
      m('meade', 'lx10', 'LX-10 (manuel, DSC en option)', 'meade', 'lx200', 'lx200',
          undefined, undefined, false),
      m('meade', 'lx50', 'LX-50', 'meade', 'lx200', 'lx200'),
      m('meade', 'lx90-6', 'LX90 6″ ACF', 'meade', 'autostar497', 'lx90'),
      m('meade', 'lx90-8', 'LX90 8″ (classic/ACF)', 'meade', 'autostar497', 'lx90'),
      m('meade', 'lx90-10', 'LX90 10″', 'meade', 'autostar497', 'lx90'),
      m('meade', 'lx90-12', 'LX90 12″', 'meade', 'autostar497', 'lx90'),
      m('meade', 'lx200-7', 'LX200 classic 7″ MCT', 'meade', 'lx200', 'lx200'),
      m('meade', 'lx200-8', 'LX200 classic 8″', 'meade', 'lx200', 'lx200'),
      m('meade', 'lx200-10', 'LX200 classic 10″', 'meade', 'lx200', 'lx200'),
      m('meade', 'lx200-12', 'LX200 classic 12″', 'meade', 'lx200', 'lx200'),
      m('meade', 'lx200-16', 'LX200 classic 16″', 'meade', 'lx200', 'lx200'),
      m('meade', 'lx200gps-7', 'LX200GPS 7″ MCT', 'meade', 'autostar2', 'lx200'),
      m('meade', 'lx200gps-8', 'LX200GPS/R 8″', 'meade', 'autostar2', 'lx200'),
      m('meade', 'lx200gps-10', 'LX200GPS/R 10″', 'meade', 'autostar2', 'lx200'),
      m('meade', 'lx200gps-12', 'LX200GPS/R 12″', 'meade', 'autostar2', 'lx200'),
      m('meade', 'lx200gps-14', 'LX200GPS/R 14″', 'meade', 'autostar2', 'lx200'),
      m('meade', 'lx200gps-16', 'LX200GPS/R 16″', 'meade', 'autostar2', 'lx200'),
      m('meade', 'rcx400', 'RCX400 (8/10/12/16″)', 'meade', 'autostar2', 'lx200'),
      m('meade', 'lx400', 'LX400-ACF (10/12/14/16″)', 'meade', 'autostar2', 'lx200'),
      m('meade', 'lx600', 'LX600 ACF (10/12/14″)', 'meade', 'autostar2', 'lx200'),
      m('meade', 'lx850', 'LX850 German Equatorial', 'meade', 'autostar2', 'lx200'),
      m('meade', 'lx65-6', 'LX65 6″ ACF', 'meade', 'autostar497', 'lx90'),
      m('meade', 'lx65-8', 'LX65 8″ ACF', 'meade', 'autostar497', 'lx90'),
      m('meade', 'lx85-6', 'LX85 6″', 'meade', 'autostar497', 'lx90'),
      m('meade', 'lx85-8', 'LX85 8″', 'meade', 'autostar497', 'lx90'),
      m('meade', 'lx85-10', 'LX85 10″', 'meade', 'autostar497', 'lx90'),
      m('meade', 'lx70', 'LX70 (manuel)', 'meade', 'autostar497', 'generic',
          undefined, undefined, false),
      m('meade', 'starpro', 'StarPro AZ (manuel)', 'meade', 'autostar497', 'generic',
          undefined, undefined, false),
    ],
  },
  {
    id: 'celestron',
    label: 'Celestron',
    protocol: 'celestron',
    models: [
      m('celestron', 'astrofi-90', 'Astro Fi 90', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'astrofi-102', 'Astro Fi 102', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'astrofi-130', 'Astro Fi 130', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'lcm-60', 'LCM 60', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'lcm-80', 'LCM 80', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'lcm-90', 'LCM 90', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'lcm-114', 'LCM 114', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'lcm-127', 'LCM 127', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'nexstar4se', 'NexStar 4SE', 'celestron', 'autostar2', 'etx105'),
      m('celestron', 'nexstar5se', 'NexStar 5SE', 'celestron', 'autostar2', 'etx105'),
      m('celestron', 'nexstar6se', 'NexStar 6SE', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'nexstar8se', 'NexStar 8SE', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'nexstar60slt', 'NexStar 60SLT', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'nexstar80slt', 'NexStar 80SLT', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'nexstar90slt', 'NexStar 90SLT', 'celestron', 'autostar2', 'etx90'),
      m('celestron', 'nexstar102slt', 'NexStar 102SLT', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'nexstar127slt', 'NexStar 127SLT', 'celestron', 'autostar2', 'etx125'),
      m('celestron', 'nexstar130slt', 'NexStar 130SLT', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'nexstar-gt', 'NexStar GT (80/114/4/5/8/9.25/11)', 'celestron', 'autostar2', 'generic'),
      m('celestron', 'nexstar8gps', 'NexStar 8GPS', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'nexstar11gps', 'NexStar 11GPS', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'evolution5', 'NexStar Evolution 5', 'celestron', 'autostar2', 'etx105'),
      m('celestron', 'evolution6', 'NexStar Evolution 6', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'evolution8', 'NexStar Evolution 8', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'evolution925', 'NexStar Evolution 9.25', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'cpc800', 'CPC 800', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'cpc925', 'CPC 925', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'cpc1100', 'CPC 1100', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'cpcdx800', 'CPC Deluxe 800 HD', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'cpcdx925', 'CPC Deluxe 925 HD', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'cpcdx1100', 'CPC Deluxe 1100 HD', 'celestron', 'autostar2', 'lx90'),
      m('celestron', 'cg5gt', 'CG-5 GT (Advanced GT)', 'celestron', 'autostar2', 'lx200'),
      m('celestron', 'avx', 'Advanced VX (AVX)', 'celestron', 'autostar2', 'lx200'),
      m('celestron', 'cgepro', 'CGE Pro', 'celestron', 'autostar2', 'lx200'),
      m('celestron', 'cgx', 'CGX', 'celestron', 'autostar2', 'lx200'),
      m('celestron', 'cgxl', 'CGX-L', 'celestron', 'autostar2', 'lx200'),
      m('celestron', 'origin', 'Origin Intelligence Home Observatory', 'celestron', 'autostar2', 'generic',
          'Protocole propriétaire app Celestron Origin — non pris en charge.',
          'Proprietary Origin app protocol — not supported.', false),
      m('celestron', 'astromaster', 'AstroMaster (série manuelle)', 'celestron', 'autostar2', 'generic',
          'Sans moteurs : informationnel seulement.', 'No motors: informational only.', false),
      m('celestron', 'starsense', 'StarSense Explorer (push-to)', 'celestron', 'autostar2', 'generic',
          'Push-to (sans moteurs) : informationnel.', 'Push-to (no motors): informational.', false),
    ],
  },
  {
    id: 'skywatcher',
    label: 'Sky-Watcher',
    protocol: 'skywatcher',
    models: [
      m('skywatcher', 'azgti', 'AZ-GTi (Wi-Fi)', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'azgte', 'AZ-GTe (Wi-Fi)', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'star-discovery-90i', 'Star Discovery 90i Wi-Fi', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'star-discovery-102i', 'Star Discovery 102i Wi-Fi', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'star-discovery-127i', 'Star Discovery 127i Wi-Fi', 'skywatcher', 'autostar2', 'etx125'),
      m('skywatcher', 'star-discovery-150i', 'Star Discovery 150i Wi-Fi', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'star-discovery-p150i', 'Star Discovery P150i', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'skymax-127-az', 'SkyMax-127 AZ GoTo', 'skywatcher', 'autostar2', 'etx125'),
      m('skywatcher', 'skymax-180', 'SkyMax-180 Pro SynScan', 'skywatcher', 'autostar2', 'lx90'),
      m('skywatcher', 'explorer-130ps', 'Explorer-130PS AZ GoTo', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'heritage-150i', 'Heritage 150i Flextube', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'virtuoso-150', 'Virtuoso GTi 150', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'virtuoso-200', 'Virtuoso GTi 200', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'flextube-250', 'Flextube 250P SynScan', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'flextube-300', 'Flextube 300P SynScan', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'dob-10-goto', 'Dob 10″ GoTo (SynScan)', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'dob-12-goto', 'Dob 12″ GoTo (SynScan)', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'eq5-pro', 'EQ5 Pro SynScan', 'skywatcher', 'autostar2', 'lx200'),
      m('skywatcher', 'heq5-pro', 'HEQ5 Pro SynScan', 'skywatcher', 'autostar2', 'lx200'),
      m('skywatcher', 'eqm-35-pro', 'EQM-35 Pro', 'skywatcher', 'autostar2', 'lx200'),
      m('skywatcher', 'eq6-r', 'EQ6-R Pro', 'skywatcher', 'autostar2', 'lx200'),
      m('skywatcher', 'az-eq5', 'Az-EQ5 GT', 'skywatcher', 'autostar2', 'lx200'),
      m('skywatcher', 'az-eq6', 'Az-EQ6 GT', 'skywatcher', 'autostar2', 'lx200'),
      m('skywatcher', 'eq8-r', 'EQ8-R Pro', 'skywatcher', 'autostar2', 'lx200'),
      m('skywatcher', 'gti', 'Star Adventurer GTi', 'skywatcher', 'autostar2', 'generic'),
      m('skywatcher', 'star-adventurer', 'Star Adventurer (suivi seul)', 'skywatcher', 'autostar2', 'generic',
          'Suivi sans GOTO : informationnel.', 'Tracking only, no GOTO: informational.', false),
    ],
  },
  {
    id: 'ioptron',
    label: 'iOptron',
    protocol: 'ioptron',
    models: [
      m('ioptron', 'cube-a', 'Cube-A / Cube Pro', 'ioptron', 'autostar2', 'generic'),
      m('ioptron', 'smarteq', 'SmartEQ / SmartEQ Pro+', 'ioptron', 'autostar2', 'generic'),
      m('ioptron', 'minitower', 'MiniTower II / Pro', 'ioptron', 'autostar2', 'generic'),
      m('ioptron', 'azmountpro', 'AZ Mount Pro', 'ioptron', 'autostar2', 'generic'),
      m('ioptron', 'cem25', 'CEM25 / CEM25P', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'cem26', 'CEM26', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'cem40', 'CEM40', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'cem45', 'CEM45', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'cem60', 'CEM60', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'cem70', 'CEM70', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'gem28', 'GEM28', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'gem45', 'GEM45', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'ieq30', 'iEQ30 Pro', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'ieq45', 'iEQ45 Pro', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'ieq85', 'iEQ85', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'hae16', 'HAE16C (strain wave)', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'hae29', 'HAE29 (strain wave)', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'hae43', 'HAE43 (strain wave)', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'hae69', 'HAE69 (strain wave)', 'ioptron', 'autostar2', 'lx200'),
      m('ioptron', 'skyhunter', 'SkyHunter', 'ioptron', 'autostar2', 'generic'),
      m('ioptron', 'lx200-mode', 'Montures iOptron en mode LX200', 'meade', 'autostar2', 'lx200',
          'Mode « LX200 compatible » de la raquette : passer par le protocole Meade.',
          'Hand control “LX200 compatible” mode: use the Meade protocol.'),
    ],
  },
  {
    id: 'orion',
    label: 'Orion',
    protocol: 'skywatcher',
    models: [
      m('orion', 'starseeker', 'StarSeeker IV (Wi-Fi)', 'celestron', 'autostar2', 'generic'),
      m('orion', 'skyview-pro', 'SkyView Pro GoTo', 'skywatcher', 'autostar2', 'lx200'),
      m('orion', 'sirius', 'Sirius EQ-G (HEQ5)', 'skywatcher', 'autostar2', 'lx200'),
      m('orion', 'atlas', 'Atlas EQ-G (EQ6)', 'skywatcher', 'autostar2', 'lx200'),
      m('orion', 'starblast-45', 'StarBlast 4.5 AutoTracker', 'skywatcher', 'autostar2', 'generic'),
      m('orion', 'starblast-6', 'StarBlast 6 AutoTracker', 'skywatcher', 'autostar2', 'generic'),
      m('orion', 'starmax-90', 'StarMax 90 GoTo', 'celestron', 'autostar2', 'etx90'),
      m('orion', 'starmax-127', 'StarMax 127 GoTo', 'celestron', 'autostar2', 'etx125'),
    ],
  },
  {
    id: 'vixen',
    label: 'Vixen',
    protocol: null,
    models: [
      m('vixen', 'porta2', 'Porta II (manuel)', null, 'autostar2', 'generic',
          'Sans moteurs : informationnel.', 'No motors: informational.', false),
      m('vixen', 'gpd2', 'GP2 / GP-DX (manuel)', null, 'autostar2', 'generic',
          'Sans moteurs : informationnel.', 'No motors: informational.', false),
      m('vixen', 'sxd2', 'SXD2 (Star Book Ten)', null, 'autostar2', 'lx200',
          'Protocole Star Book propriétaire — non pris en charge à ce jour.',
          'Proprietary Star Book protocol — not supported yet.'),
      m('vixen', 'sxp2', 'SXP2 (Star Book Ten)', null, 'autostar2', 'lx200',
          'Protocole Star Book propriétaire — non pris en charge à ce jour.',
          'Proprietary Star Book protocol — not supported yet.'),
    ],
  },
  {
    id: 'losmandy',
    label: 'Losmandy',
    protocol: 'meade',
    models: [
      m('losmandy', 'gm8', 'GM8 / GM811 (Gemini 2)', 'meade', 'autostar2', 'lx200',
          'Gemini 2 : mode émulation LX200 à activer dans la raquette.',
          'Gemini 2: enable LX200 emulation on the hand control.'),
      m('losmandy', 'g9', 'G9 (Gemini 2)', 'meade', 'autostar2', 'lx200'),
      m('losmandy', 'g11', 'G11 (Gemini 1/2)', 'meade', 'autostar2', 'lx200'),
      m('losmandy', 'titan', 'Titan (Gemini 2)', 'meade', 'autostar2', 'lx200'),
    ],
  },
  {
    id: 'explore',
    label: 'Explore Scientific',
    protocol: null,
    models: [
      m('explore', 'exos-nano', 'EXOS Nano GoTo', null, 'autostar2', 'generic',
          'Protocole non pris en charge — utilisez la saisie manuelle.',
          'Protocol not supported — use manual entry.'),
      m('explore', 'exos2-pmc8', 'EXOS-2 PMC-8', null, 'autostar2', 'lx200',
          'Protocole PMC-8 propriétaire — non pris en charge à ce jour.',
          'Proprietary PMC-8 protocol — not supported yet.'),
      m('explore', 'fl-mc100', 'FirstLight (EXOS-2 GoTo)', null, 'autostar2', 'lx200',
          'GoTo EXOS-2 : protocole partiellement LX200 — tester la détection.',
          'EXOS-2 GoTo: partially LX200 — try detection.'),
    ],
  },
  {
    id: 'bresser',
    label: 'Bresser',
    protocol: null,
    models: [
      m('bresser', 'exos1', 'EXOS-1 GoTo', null, 'autostar2', 'generic',
          'Protocole Messier — non pris en charge à ce jour.',
          'Messier protocol — not supported yet.'),
      m('bresser', 'exos2', 'EXOS-2 GoTo (Messier)', null, 'autostar2', 'lx200',
          'Protocole Messier partiellement LX200 — tester la détection.',
          'Messier protocol partially LX200 — try detection.'),
      m('bresser', 'messier-ar', 'Messier AR/NT (EXOS-2 GoTo)', null, 'autostar2', 'lx200'),
    ],
  },
  {
    id: 'tenmicron',
    label: '10Micron',
    protocol: 'meade',
    models: [
      m('tenmicron', 'gm1000', 'GM 1000 HPS', 'meade', 'autostar2', 'lx200',
          'Émulation LX200 native (10Micron GM).', 'Native LX200 emulation (10Micron GM).'),
      m('tenmicron', 'gm2000', 'GM 2000 QCI HPS', 'meade', 'autostar2', 'lx200'),
      m('tenmicron', 'gm3000', 'GM 3000 HPS', 'meade', 'autostar2', 'lx200'),
      m('tenmicron', 'gm4000', 'GM 4000 HPS', 'meade', 'autostar2', 'lx200'),
    ],
  },
  {
    id: 'astrophysics',
    label: 'Astro-Physics',
    protocol: 'meade',
    models: [
      m('astrophysics', 'mach1', 'Mach1GTO', 'meade', 'autostar2', 'lx200',
          'Via APCC : serveur d’émulation LX200.', 'Via APCC: LX200 emulation server.'),
      m('astrophysics', 'ap1100', 'AP1100GTO', 'meade', 'autostar2', 'lx200'),
      m('astrophysics', 'ap1600', 'AP1600GTO', 'meade', 'autostar2', 'lx200'),
    ],
  },
  {
    id: 'zwo',
    label: 'ZWO',
    protocol: 'meade',
    models: [
      m('zwo', 'am3', 'AM3 (strain wave)', 'meade', 'autostar2', 'lx200',
          'Mode LX200 du Wi-Fi intégré (AMxx).', 'Built-in Wi-Fi LX200 mode (AMxx).'),
      m('zwo', 'am5', 'AM5 (strain wave)', 'meade', 'autostar2', 'lx200',
          'Mode LX200 du Wi-Fi intégré (AMxx).', 'Built-in Wi-Fi LX200 mode (AMxx).'),
      m('zwo', 'am6', 'AM6 (strain wave)', 'meade', 'autostar2', 'lx200'),
    ],
  },
];

/** Modèles génériques par protocole (raccourcis « sans marque »). */
export const GENERIC_MODELS: MountModelInfo[] = [
  m('other', 'gen-meade', 'Monture LX200 / Autostar générique', 'meade', 'autostar497', 'generic'),
  m('other', 'gen-autostar2', 'LX200GPS / Autostar II générique', 'meade', 'autostar2', 'lx200'),
  m('other', 'gen-nexstar', 'Monture NexStar générique', 'celestron', 'autostar2', 'generic'),
  m('other', 'gen-synscan', 'Monture SynScan générique', 'skywatcher', 'autostar2', 'generic'),
  m('other', 'gen-ioptron', 'Monture iOptron 8407 générique', 'ioptron', 'autostar2', 'generic'),
];

/* ------------------------------------------------------------------ */
/* Résolution                                                          */
/* ------------------------------------------------------------------ */

export const BRAND_OTHER = 'other';
export const MODEL_NOT_LISTED = 'not-listed';
export const MODEL_CUSTOM = 'custom';

export function findBrand(brandId: string | null): MountBrand | null {
  return BRANDS.find((b) => b.id === brandId) ?? null;
}

export function findModel(brandId: string | null, modelId: string | null): MountModelInfo | null {
  if (!modelId) return null;
  const b = findBrand(brandId);
  if (b) {
    const inBrand = b.models.find((x) => x.id === modelId);
    if (inBrand) return inBrand;
  }
  return GENERIC_MODELS.find((x) => x.id === modelId) ?? null;
}

/** Interface de raquette par défaut pour un protocole (hors catalogue). */
function defaultInterface(protocol: DriverId): ScopeModelId {
  return protocol === 'meade' ? 'autostar497' : 'autostar2';
}

/**
 * Configuration effective à partir de la sélection persistée.
 *  - sélection catalogue (marque + modèle) → protocole/preset du modèle ;
 *  - saisie manuelle (custom.active) → caractéristiques saisies ;
 *  - rien de sélectionné → repli identique à v2.6.0 (Meade auto, générique)
 *    pour ne jamais casser une installation existante.
 */
export function resolveMountConfig(
    brandId: string | null,
    modelId: string | null,
    custom: CustomMount | null,
): MountConfig {
  if (custom && custom.active) {
    const proto: DriverPref = custom.protocol;
    return {
      brandLabel: '—',
      modelLabel: custom.label || '—',
      driverPref: proto,
      interfaceId: proto !== 'auto' ? defaultInterface(proto) : 'autostar497',
      preset: custom.preset,
      custom,
    };
  }
  const mdl = findModel(brandId, modelId);
  if (mdl) {
    const brand = findBrand(brandId);
    return {
      brandLabel: brand?.label ?? '—',
      modelLabel: mdl.label,
      driverPref: mdl.protocol ?? 'auto',
      interfaceId: mdl.interfaceId,
      preset: mdl.preset,
      custom: null,
    };
  }
  // Repli v2.6.0 : détection à la connexion, preset déduit de la raquette.
  return {
    brandLabel: '—',
    modelLabel: '—',
    driverPref: 'auto',
    interfaceId: 'autostar2',
    preset: 'generic',
    custom: null,
  };
}

/**
 * Preset MÉCANIQUE actif — priorité :
 *  1. saisie manuelle (custom.active) → caractéristiques saisies ;
 *  2. modèle du catalogue (marque+modèle choisis) → preset du modèle ;
 *  3. comportement v2.6.0 (choix manuel historique des puces, sinon
 *     déduit de la raquette détectée) — compatibilité ascendante.
 * La saisie manuelle surcharge butées et type de monture.
 */
export function activePreset(
    brandId: string | null,
    modelId: string | null,
    custom: CustomMount | null,
    detectedModel: ScopeModelId | null,
    manualPreset: MountPresetId | 'auto' = 'auto',
): MountPreset {
  const cfg = resolveMountConfig(brandId, modelId, custom);
  if (cfg.custom) {
    const base = MOUNT_PRESETS[cfg.preset] ?? MOUNT_PRESETS.generic;
    return {
      ...base,
      label: cfg.custom.label || base.label,
      minAltDeg: cfg.custom.minAltDeg,
      maxAltDeg: cfg.custom.maxAltDeg,
      altaz: cfg.custom.altaz,
    };
  }
  if (cfg.modelLabel !== '—') {
    return MOUNT_PRESETS[cfg.preset] ?? MOUNT_PRESETS.generic;
  }
  // rien de sélectionné dans l'onglet Montures : comportement v2.6.0
  return resolvePreset(manualPreset, detectedModel);
}
