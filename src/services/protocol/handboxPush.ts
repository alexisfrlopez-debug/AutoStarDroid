/**
 * Mise à jour automatique de la raquette PHYSIQUE avec les données de
 * précision (v2.2.0 — demande utilisateur : « après ces tests, je veux que
 * la raquette soit mise à jour automatiquement avec toutes ces données »).
 *
 * Ce qui part vers la raquette :
 *  1. HORLOGE + SITE : :SG/:SL/:SC/:St/:Sg — le téléphone fait autorité
 *     (via autostar.pushPhoneData, déjà éprouvé v2.1.2) ;
 *  2. RÉTRO-JEU AD / DEC : la valeur n'est PAS accessible par une commande
 *     LX200 sur une #497 — elle vit dans les menus de la raquette. La mise
 *     à jour se fait par ÉMULATION DE TOUCHES (:EK#) avec VÉRIFICATION de
 *     CHAQUE ÉCRAN au miroir :ED# (le même mécanisme que la raquette
 *     virtuelle). La valeur poussée est déduite du jeu mesuré au gyro par
 *     une heuristique documentée (backlashPctFromArcsec).
 *
 * Best-effort et SANS RISQUE : chaque étape est vérifiée au miroir ; au
 * premier écran inattendu, ABORT propre (plusieurs MODE pour revenir à
 * l'écran d'accueil) et statut « fail » — la raquette n'est jamais laissée
 * au milieu d'un menu sans tentative de sortie, et un échec n'affecte
 * jamais la liaison ni le reste de l'app. Aucune fonction JS ne traverse
 * le pont natif (règle de survie Hermes) — tout est Promise + valeurs.
 */
import {autostar} from './client';
import {HB_KEYS} from './client';
import {useScopeStore} from '../../store/scopeStore';

export interface HandboxPushReport {
  clock: 'ok' | 'fail';
  backlashRa: 'ok' | 'fail' | 'skipped';
  backlashDec: 'ok' | 'fail' | 'skipped';
  raPct: number | null;
  decPct: number | null;
  /** Détail du premier problème rencontré (journal/i18n clé libre). */
  note: string | null;
}

export type PushPhase = 'clock' | 'ra' | 'dec' | 'done';

/* ------------------------------------------------------------------ */
/* Heuristique rétro-jeu                                                */
/* ------------------------------------------------------------------ */

/**
 * Jeu mesuré (″) → % rétro-jeu Autostar (0..99, écran de la raquette).
 *
 * HEURISTIQUE : sur #49x, le % de rétro-jeu multiplie le temps de rattrapage
 * moteur à l'inversion. La pratique terrain (ETX/LX90) place 20″ de jeu
 * mesuré ≈ 1 % — un ETX-125 DEC typique (90-120″ mesurés) tombe à 5-6 %,
 * cohérent avec les réglages d'usine usuels. La valeur reste modifiable à
 * la main sur la raquette ; l'app pousse un POINT DE DÉPART mesuré.
 */
export function backlashPctFromArcsec(arcsec: number | null): number | null {
  if (arcsec == null || !Number.isFinite(arcsec) || arcsec <= 0) return null;
  return Math.min(50, Math.max(1, Math.round(arcsec / 20)));
}

/* ------------------------------------------------------------------ */
/* Navigation de menus au miroir :ED#                                   */
/* ------------------------------------------------------------------ */

/** Un écran LCD (2×16) : le caractère de SÉLECTION (flèche) est un octet
 *  de contrôle en tête de la ligne sélectionnée dans la réponse :ED#. */
export interface LcdScreen {
  line1: string;
  line2: string;
  /** Ligne portant la flèche de sélection, si identifiable. */
  selected: 1 | 2 | null;
}

export function parseLcdWithSelection(reply: string): LcdScreen | null {
  if (reply.length < 32) return null;
  const body = reply.slice(reply.length - 32);
  const deDegree = (s: string) => s.replace(/\u00DF/g, '\u00B0');
  const c0 = body.charCodeAt(0);
  const c16 = body.charCodeAt(16);
  const isCtrl = (c: number) => c < 0x20 || (c >= 0x80 && c <= 0x9f);
  const line1 = deDegree(body.slice(0, 16));
  const line2 = deDegree(body.slice(16, 32));
  let selected: 1 | 2 | null = null;
  if (isCtrl(c0)) selected = 1;
  else if (isCtrl(c16)) selected = 2;
  // Les raquettes qui n'exposent pas la flèche : la ligne « sélectionnée »
  // est alors inconnue — les décisions se prennent sur le TEXTE visible.
  return {line1, line2, selected};
}

/** Lit l'écran courant avec la flèche de sélection (null = miroir
 *  indisponible / raquette muette). La réponse BRUTE :ED# porte l'octet de
 *  contrôle en tête de la ligne sélectionnée — lisible par
 *  parseLcdWithSelection ; getLcd() (parsée) le perdrait. */
async function readLcd(): Promise<LcdScreen | null> {
  const raw = await autostar.getLcdRaw().catch(() => null);
  if (!raw) return null;
  return parseLcdWithSelection(raw);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Appui d'une touche SUR la raquette (émulation :EK#). */
const key = (code: number) => autostar.keyPress(code);

const RE_IDLE = /objet|object|astro/i; // écran d'accueil #49x
const RE_SETUP = /configuration|setup/i;
const RE_TELESCOPE = /t[eé]lescope/i;
// « Rétro-jeu » porte un accent sur les raquettes françaises : [eé] requis.
const RE_BACKLASH_RA = /r[eé]tro[\s-]?jeu\s*(ad|az)|ra\s*backlash|az(imuth)?\s*(backlash|%|percent)/i;
const RE_BACKLASH_DEC = /r[eé]tro[\s-]?jeu\s*(d[eé]c|alt)|dec\s*backlash|alt(itude)?\s*(backlash|%|percent)/i;

/** Texte de la ligne SÉLECTIONNÉE (ou des deux si flèche inconnue). */
function selectedTexts(lcd: LcdScreen): string[] {
  if (lcd.selected === 1) return [lcd.line1];
  if (lcd.selected === 2) return [lcd.line2];
  return [lcd.line1, lcd.line2];
}

/** La sélection courante correspond-elle au motif ? */
function selectionMatches(lcd: LcdScreen, re: RegExp): boolean {
  return selectedTexts(lcd).some((s) => re.test(s));
}

/**
 * Sortie de secours : remonte tous les menus (×6 MODE, vérifie l'accueil).
 * Toujours appelée en fin de navigation (succès OU échec) : la raquette
 * physique est rendue à son écran d'accueil dans tous les cas.
 *
 * L'accueil se reconnaît à l'ABSENCE de flèche de sélection (un menu a
 * toujours un item fléché) + texte « Objet/Object » sans « Configuration ».
 * Sur une raquette qui n'expose pas la flèche, repli sur le texte seul.
 */
async function escapeToIdle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const lcd = await readLcd();
    if (lcd && lcd.selected == null
      && RE_IDLE.test(lcd.line1)
      && !RE_SETUP.test(lcd.line1) && !RE_SETUP.test(lcd.line2)) {
      return; // déjà à l'accueil
    }
    await key(HB_KEYS.mode);
    await sleep(650);
  }
}

/** Depuis l'accueil, ouvre Configuration → Télescope. */
async function openTelescopeMenu(): Promise<boolean> {
  // MODE depuis l'accueil → menu principal (1ᵉʳ item sélectionné : Objet)
  await key(HB_KEYS.mode);
  await sleep(700);
  // Chercher « Configuration » : la sélection avance avec BAS
  for (let i = 0; i < 6; i++) {
    const lcd = await readLcd();
    if (!lcd) return false;
    if (selectionMatches(lcd, RE_SETUP)) break;
    await key(HB_KEYS.down);
    await sleep(550);
  }
  const lcdSetup = await readLcd();
  if (!lcdSetup || !selectionMatches(lcdSetup, RE_SETUP)) return false;
  await key(HB_KEYS.enter);
  await sleep(700);
  // Chercher « Télescope » dans Configuration
  for (let i = 0; i < 8; i++) {
    const lcd = await readLcd();
    if (!lcd) return false;
    if (selectionMatches(lcd, RE_TELESCOPE)) {
      await key(HB_KEYS.enter);
      await sleep(700);
      return true;
    }
    await key(HB_KEYS.down);
    await sleep(550);
  }
  return false;
}

/**
 * Règle UN rétro-jeu dans le menu Télescope : cherche la ligne du réglage,
 * entre, tape les 2 chiffres, valide, vérifie la sortie de l'écran-valeur.
 */
async function setBacklashAxis(re: RegExp, pct: number): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    const lcd = await readLcd();
    if (!lcd) return false;
    if (selectionMatches(lcd, re)) break;
    await key(HB_KEYS.down);
    await sleep(550);
  }
  const lcdItem = await readLcd();
  if (!lcdItem || !selectionMatches(lcdItem, re)) return false;
  await key(HB_KEYS.enter); // ouvre l'écran-valeur (curseur sur un chiffre)
  await sleep(750);
  // Tape la valeur (2 chiffres) — l'écran-valeur accepte les chiffres directs
  const digits = String(Math.max(0, Math.min(99, pct))).padStart(2, '0');
  for (const d of digits) {
    await key(HB_KEYS.digit0 + Number(d));
    await sleep(450);
  }
  await key(HB_KEYS.enter); // valide la valeur
  await sleep(750);
  const after = await readLcd();
  // Sortie de l'écran-valeur : le '%' (ou l'écran-valeur) n'est plus affiché
  if (!after) return false;
  const stillValue = after.line1.includes('%') || after.line2.includes('%');
  return !stillValue;
}

/* ------------------------------------------------------------------ */
/* Orchestrateur                                                        */
/* ------------------------------------------------------------------ */

/**
 * Pousse horloge/site + rétro-jeu (si mesuré) vers la raquette physique.
 * Ne lève JAMAIS d'exception : chaque étape est tolérante et journalisée.
 */
export async function pushCalibToHandbox(opts: {
  latDeg: number;
  lonDeg: number;
  backlash: {raArcsec: number | null; decArcsec: number | null} | null;
  onPhase?: (p: PushPhase) => void;
}): Promise<HandboxPushReport> {
  const rep: HandboxPushReport = {
    clock: 'fail', backlashRa: 'skipped', backlashDec: 'skipped',
    raPct: null, decPct: null, note: null,
  };
  const log = (m: string) => useScopeStore.getState().pushLog('info', m);

  // 1. Horloge + site (toujours)
  try {
    opts.onPhase?.('clock');
    await autostar.pushPhoneData(opts.latDeg, opts.lonDeg);
    rep.clock = 'ok';
    log('Raquette : horloge et site mises à jour depuis le téléphone');
  } catch (e) {
    rep.note = 'clock';
    log(`Raquette : horloge non confirmée (${(e as Error).message})`);
  }

  // 2. Rétro-jeu — nécessite le miroir :ED# et une raquette réelle
  const raPct = backlashPctFromArcsec(opts.backlash?.raArcsec ?? null);
  const decPct = backlashPctFromArcsec(opts.backlash?.decArcsec ?? null);
  const transportType = autostar.getTransportType();
  const demo = transportType === 'demo';
  if (raPct == null && decPct == null) {
    rep.note = rep.note ?? 'noBacklash';
    return rep; // rien à pousser : les menus ne sont pas ouverts
  }
  if (demo) {
    rep.raPct = raPct; rep.decPct = decPct;
    log('Démo : rétro-jeu calculé mais menus raquette non pilotés en démo');
    return rep;
  }

  const lcd0 = await readLcd();
  if (!lcd0) {
    rep.note = 'noMirror';
    log('Raquette : miroir :ED# indisponible — rétro-jeu non poussé (réglable à la main sur la raquette)');
    return rep;
  }

  try {
    await escapeToIdle();
    if (raPct != null) {
      opts.onPhase?.('ra');
      if (await openTelescopeMenu()) {
        rep.backlashRa = (await setBacklashAxis(RE_BACKLASH_RA, raPct)) ? 'ok' : 'fail';
      } else {
        rep.backlashRa = 'fail';
        rep.note = rep.note ?? 'menuNotFound';
      }
      rep.raPct = raPct;
      await escapeToIdle(); // repartir de l'accueil pour l'axe suivant
    }
    if (decPct != null) {
      opts.onPhase?.('dec');
      if (await openTelescopeMenu()) {
        rep.backlashDec = (await setBacklashAxis(RE_BACKLASH_DEC, decPct)) ? 'ok' : 'fail';
      } else {
        rep.backlashDec = 'fail';
        rep.note = rep.note ?? 'menuNotFound';
      }
      rep.decPct = decPct;
    }
  } finally {
    await escapeToIdle(); // la raquette retrouve son accueil dans TOUS les cas
  }

  if (rep.backlashRa === 'ok' || rep.backlashDec === 'ok') {
    log(`Raquette : rétro-jeu poussé depuis la mesure télémétrique (AD ${
      rep.backlashRa === 'ok' ? `${rep.raPct} %` : '—'}, DEC ${
      rep.backlashDec === 'ok' ? `${rep.decPct} %` : '—'}) — vérifiable dans Configuration > Télescope`);
  }
  opts.onPhase?.('done');
  return rep;
}
