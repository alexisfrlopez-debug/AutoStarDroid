/**
 * Modèle de menus de la raquette virtuelle — arborescence fidèle à l'esprit
 * Autostar (#497 / II) mais limitée à ce que l'application sait réellement
 * faire (catalogues embarqués, protocole LX200, réglages du téléphone).
 *
 * Sémantique de navigation (identique à la vraie raquette) :
 *  - le curseur désigne l'item SÉLECTIONNÉ dans la liste affichée ;
 *  - ENTER descend d'un niveau (ou exécute l'action d'une feuille) ;
 *  - MODE remonte ; appui long = retour à « Select Item » ;
 *  - les touches de défilement ▲▼ parcourent la liste courante ;
 *  - dans une liste numérotée (numbered), la saisie de chiffres saute
 *    directement à l'item n (ex. « 45 » puis ENTER -> M45).
 */
import type {Dict} from '../i18n/en';
import type {SiteInfo, ScopeModelId} from '../store/settingsStore';
import {MESSIER, NGC_FAMOUS, BRIGHT_STARS, tourOfSky, planetObjects, withAlt, type DisplayObject} from './catalog';
import {raDegToHMS, decDegToDMS} from './astro/time';

export interface MenuNode {
  key: string;
  /** 1ʳᵉ ligne LCD. */
  line1: string;
  /** 2ᵉ ligne LCD (facultative : dérivée des enfants sinon). */
  line2?: string;
  children?: MenuNode[];
  /** ENTER sur une feuille. */
  onEnter?: () => void;
  /** GO TO sur une feuille. */
  onGoto?: () => void;
  /** Liste numérotée : saisie de chiffres + ENTER pour sauter à l'item. */
  numbered?: boolean;
  /** Aide contextuelle affichée par la touche ?. */
  help?: string;
}

export type SpeedId = 'guide' | 'center' | 'find' | 'slew';
export type TrackMode = 'altaz' | 'polar' | 'land';

export interface MenuActions {
  gotoObject(o: DisplayObject): void;
  showMsg(m: string, ms?: number): void;
  syncPhone(): void;
  readScope(): void;
  setSpeed(s: SpeedId): void;
  setTracking(m: TrackMode): void;
  toggleNight(): void;
  toggleBeeps(): void;
  focusIn(): void;
  focusOut(): void;
  focusStop(): void;
}

export interface MenuCtx {
  t: Dict;
  site: SiteInfo;
  model: ScopeModelId;
  speed: SpeedId;
  alignMode: string;
  nightVision: boolean;
  keySounds: boolean;
  actions: MenuActions;
}

const altTag = (alt: number) => (alt >= 0 ? `H+${alt.toFixed(0)}°` : `H${alt.toFixed(0)}°`);

/** Liste défilable d'objets (liste numérotée, GOTO sur chaque item). */
function objList(key: string, title: string, objs: DisplayObject[], a: MenuActions, help: string): MenuNode {
  return {
    key,
    line1: title,
    line2: objs.length ? `1/${objs.length} ${objs[0].name}` : '—',
    numbered: true,
    help,
    children: objs.map((o, i) => ({
      key: `${key}-${o.id}`,
      line1: o.name.slice(0, 16),
      line2: `${i + 1}/${objs.length} ${altTag(o.altDeg)}`,
      onGoto: () => a.gotoObject(o),
      help: `${o.name}  AD ${raDegToHMS(o.raDeg)}  DEC ${decDegToDMS(o.decDeg)}`,
    })),
  };
}

/** Construit l'arborescence complète (reconstruite quand le contexte change). */
export function buildMenuTree(ctx: MenuCtx): MenuNode {
  const {t, site, actions: a} = ctx;
  const now = new Date();

  const planets = planetObjects(site.latDeg, site.lonDeg, now, t);
  const messier = withAlt(MESSIER, site.latDeg, site.lonDeg, now);
  const ngc = withAlt(NGC_FAMOUS, site.latDeg, site.lonDeg, now);
  const stars = withAlt(BRIGHT_STARS, site.latDeg, site.lonDeg, now);
  const tour = tourOfSky(site.latDeg, site.lonDeg, now, 15, 12);

  const speedItem = (id: SpeedId, label: string): MenuNode => ({
    key: `speed-${id}`,
    line1: label,
    line2: ctx.speed === id ? '*  *  *' : '',
    onEnter: () => a.setSpeed(id),
    help: t.hb.helpSpeed,
  });

  const trackItem = (id: TrackMode, label: string): MenuNode => ({
    key: `track-${id}`,
    line1: label,
    line2: ctx.alignMode === id ? '*  *  *' : '',
    onEnter: () => a.setTracking(id),
    help: t.hb.helpTrack,
  });

  const focusItem = (label: string, fn: () => void, help: string): MenuNode => ({
    key: `focus-${label}`,
    line1: label,
    onGoto: fn,
    help,
  });

  return {
    key: 'root',
    line1: 'Select Item',
    children: [
      /* ---------- Objet ---------- */
      {
        key: 'object',
        line1: t.hb.menus.object,
        line2: '> ' + t.hb.menus.solar,
        help: t.hb.helpObject,
        children: [
          objList('planets', t.hb.menus.solar, planets, a, t.hb.helpList),
          {
            key: 'deepsky',
            line1: t.hb.menus.deepsky,
            line2: '> ' + t.hb.menus.messier,
            help: t.hb.helpDeepsky,
            children: [
              objList('messier', t.hb.menus.messier, messier, a, t.hb.helpMessier),
              objList('ngc', t.hb.menus.ngc, ngc, a, t.hb.helpList),
            ],
          },
          objList('stars', t.hb.menus.stars, stars, a, t.hb.helpList),
        ],
      },
      /* ---------- Config ---------- */
      {
        key: 'setup',
        line1: t.hb.menus.setup,
        line2: '> ' + t.hb.menus.site,
        help: t.hb.helpSetup,
        children: [
          {
            key: 'site',
            line1: t.hb.menus.site,
            line2: `${Math.abs(site.latDeg).toFixed(1)}${site.latDeg >= 0 ? 'N' : 'S'} ${Math.abs(site.lonDeg).toFixed(1)}${site.lonDeg >= 0 ? 'E' : 'W'}`,
            onEnter: () => a.syncPhone(),
            help: t.hb.helpSite,
          },
          {
            key: 'readscope',
            line1: t.hb.menus.readScope,
            line2: ':GL :GC :Gt',
            onEnter: () => a.readScope(),
            help: t.hb.helpRead,
          },
          {
            key: 'telescope',
            line1: t.hb.menus.telescope,
            line2: '> ' + t.hb.menus.speed,
            help: t.hb.helpTelescope,
            children: [
              {
                key: 'speed',
                line1: t.hb.menus.speed,
                line2: ctx.speed,
                children: [
                  speedItem('guide', t.slew.guide),
                  speedItem('center', t.slew.center),
                  speedItem('find', t.slew.find),
                  speedItem('slew', t.slew.slew),
                ],
              },
              {
                key: 'tracking',
                line1: t.hb.menus.tracking,
                line2: '> ' + t.align.altaz,
                children: [
                  trackItem('altaz', t.align.altaz),
                  trackItem('polar', t.align.polar),
                  trackItem('land', t.align.land),
                ],
              },
            ],
          },
        ],
      },
      /* ---------- Guide ---------- */
      {
        key: 'guide',
        line1: t.hb.menus.guiding,
        line2: '> ' + t.hb.menus.tour,
        help: t.hb.helpGuide,
        children: [
          objList('tour', t.hb.menus.tour, tour, a, t.hb.helpTour),
        ],
      },
      /* ---------- Util. ---------- */
      {
        key: 'util',
        line1: t.hb.menus.util,
        line2: '> ' + t.hb.menus.focus,
        help: t.hb.helpUtil,
        children: [
          {
            key: 'focus',
            line1: t.hb.menus.focus,
            line2: t.hb.helpFocus,
            children: [
              focusItem(t.hb.menus.focusIn, () => a.focusIn(), t.hb.helpFocusIn),
              focusItem(t.hb.menus.focusOut, () => a.focusOut(), t.hb.helpFocusOut),
              focusItem(t.hb.menus.focusStop, () => a.focusStop(), t.hb.helpFocusStop),
            ],
          },
          {
            key: 'night',
            line1: t.setup.night,
            line2: ctx.nightVision ? t.common.on : t.common.off,
            onEnter: () => a.toggleNight(),
            help: t.hb.helpNight,
          },
          {
            key: 'beeps',
            line1: t.setup.sounds,
            line2: ctx.keySounds ? t.common.on : t.common.off,
            onEnter: () => a.toggleBeeps(),
            help: t.hb.helpBeeps,
          },
        ],
      },
    ],
  };
}

/** Chemin du curseur vers un nœud identifié par sa clé stable (ex. 'messier'). */
export function findPath(root: MenuNode, key: string): number[] | null {
  const rec = (node: MenuNode, path: number[]): number[] | null => {
    if (node.key === key) return path;
    const kids = node.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      const r = rec(kids[i], [...path, i]);
      if (r) return r;
    }
    return null;
  };
  return rec(root, []);
}

/** Nœud atteint par un chemin de curseur. */
export function nodeAt(root: MenuNode, path: number[]): MenuNode {
  let node = root;
  for (const i of path) node = node.children?.[i] ?? node;
  return node;
}
