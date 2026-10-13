/**
 * Driver MEADE — Autostar #49x / Autostar II / LX200 classique.
 * Protocole historique de l'app (v1.x → v2.5.0) : commandes LX200 '#'-terminal,
 * robustesse complète (double précision haute/basse, reset ESC ESC sur mutisme,
 * sonde :D# « slew parti ? »). Extrait du client v2.5.0 lors du passage
 * multi-marques (v2.6.0) — comportement INCHANGÉ.
 */
import {proto, lonDegFromMeade} from '../../astro/time';
import {
  registerDriver, parseMeadeDec, parseMeadeRa, VALID, NO_CAPS,
  type DriverClient, type GotoStatus, type RaDec, type Dir, type Speed,
  type TelescopeDriver,
} from '../driver';
import {SPEED_CMDS} from '../profiles';
import {sleep} from '../../util';

/** Découpe une réponse :ED# en 2 lignes de 16 ; renvoie null si hors format. */
export function parseLcdReply(reply: string): {line1: string; line2: string} | null {
  if (reply.length < 32) return null;
  const body = reply.slice(reply.length - 32); // tolère 1+ marqueurs en tête
  const deDegree = (s: string) => s.replace(/\u00DF/g, '\u00B0');
  return {
    line1: deDegree(body.slice(0, 16)),
    line2: deDegree(body.slice(16, 32)),
  };
}

/** Driver Meade enrichi de ses helpers internes (cible, sonde de slew). */
export interface MeadeDriver extends TelescopeDriver {
  setTargetBit(c: DriverClient, prefix: string, formats: string[]): Promise<'1' | '0' | 'mute' | 'noLink'>;
  probeSlewStarted(c: DriverClient, tries?: number): Promise<boolean>;
}

export const MEADE_DRIVER: MeadeDriver = {
  id: 'meade',
  label: 'Meade Autostar / LX200',
  brands: 'Meade (ETX, LX90, LX200, DS) · montures tierces émulant LX200',
  caps: {
    ...NO_CAPS,
    position: true, altAz: true, goto: true, relay: true, sync: true,
    syncHere: true, readSite: true, pushSite: true, trackingModes: true,
    alignWizards: true, focus: true, reticle: true, park: true,
    lcdMirror: true, keyPress: true, isMoving: true,
  },
  probe: {
    cmd: ':GVP#',
    timeoutMs: 1500,
    expect: VALID.any,
    classify: (reply: string): boolean => {
      const p = (reply ?? '').trim().toLowerCase();
      if (!p || p === '?') return false;
      // noms d'usine Meade (matchFirmware en reconnaît davantage)
      return /autostar|lx-?200|etx|lx90|magellan|starfinder|ds-?\d|49[457]/.test(p);
    },
  },

  async firmware(c: DriverClient): Promise<{product: string; version: string}> {
    const product = await c.cmd(':GVP#').catch(() => '?');
    const version = await c.cmd(':GVN#').catch(() => '?');
    return {product, version};
  },

  async getRaDec(c: DriverClient, timeoutMs: number): Promise<RaDec> {
    // séquentiel avec échec rapide : si :Gr# ne répond pas, inutile d'attendre
    // aussi :Gd# (raquette muette sur la position = cycle 2× plus court)
    const ra = await c.cmd(':Gr#', timeoutMs, VALID.ra);
    const dec = await c.cmd(':Gd#', timeoutMs, VALID.dec);
    const raDeg = parseMeadeRa(ra);
    const decDeg = parseMeadeDec(dec);
    if (raDeg === null || decDeg === null) throw new Error('Réponse position illisible');
    return {raDeg, decDeg};
  },

  async readPosition(c: DriverClient, timeoutMs: number) {
    // Tolérant : chaque axe indépendant (une raquette peut répondre à :Gr#
    // mais tarder sur :Gd#). Respiration 40 ms : le tampon UART des Autostar
    // est minuscule, deux commandes collées peuvent perdre la 2e.
    let raDeg: number | null = null;
    let decDeg: number | null = null;
    try {
      const ra = await c.cmd(':Gr#', timeoutMs, VALID.ra);
      raDeg = parseMeadeRa(ra);
    } catch (_) { /* axe muet ce cycle */ }
    await sleep(40);
    try {
      const dec = await c.cmd(':Gd#', timeoutMs, VALID.dec);
      decDeg = parseMeadeDec(dec);
    } catch (_) { /* axe muet ce cycle */ }
    return {raDeg, decDeg};
  },

  async readAltAz(c: DriverClient) {
    // repli v1.8.0 : :Ga#/:Gz# répondent même quand :Gr#/:Gd# tardent
    const alt = await c.cmd(':Ga#', 2500, VALID.dec).catch(() => '');
    if (!alt) return null;
    await sleep(40);
    const az = await c.cmd(':Gz#', 2500, VALID.dec).catch(() => '');
    if (!az) return null;
    const altDeg = parseMeadeDec(alt);
    const azDeg = parseMeadeDec(az);
    if (altDeg === null || azDeg === null) return null;
    return {altDeg, azDeg};
  },

  async setTargetBit(c: DriverClient, prefix: string, formats: string[]): Promise<'1' | '0' | 'mute' | 'noLink'> {
    // Pose la cible (:Sr OU :Sd) avec la ROBUSTESSE complète (v2.0.1) :
    // refus explicite → l'AUTRE précision est essayée ; mutisme → reset ESC ESC
    // puis UNE retentative ; liaison morte → 'noLink'.
    let explicitRefused = false;
    for (const f of formats) {
      const full = `${prefix}${f}#`;
      let r: string;
      try {
        r = await c.cmd(full, 2500, VALID.bit);
      } catch (_) {
        if (!c.transportAlive()) return 'noLink';
        // muette : reset parseur (ESC ESC) puis UNE retentative
        await c.resetParser();
        try {
          r = await c.cmd(full, 2500, VALID.bit);
        } catch (_) {
          if (!c.transportAlive()) return 'noLink';
          return 'mute'; // raquette muette même après reset — pas un problème de format
        }
      }
      if (r === '1') return '1';
      explicitRefused = true; // « 0 » explicite : la raquette VIT et refuse → autre précision
    }
    return explicitRefused ? '0' : 'mute';
  },

  async goto(c: DriverClient, raDeg: number, decDeg: number): Promise<GotoStatus> {
    // v2.9.4 — BOOST DE VITESSE avant la séquence : le GOTO natif :MS# roule
    // au taux COURANT de la raquette — si elle est restée à un taux lent
    // (center/guide du suivi ou du réglage fin), le pointage natif part en
    // rampe. :RS# + :R9# (doublon de famille, cf. setSpeed) remontent le
    // taux AVANT :Sr/:Sd/:MS — sans effet si déjà au maximum.
    // Best-effort : une écriture impossible ici ne doit PAS court-circuiter
    // la gestion d'erreur de la séquence (noLink/mute — tests v2.0.1).
    // SANS sommeil intermédiaire : les tests à timers factifs (fineTune)
    // n'avancent jamais les timers pendant un await — et en production les
    // allers-retours du pont natif espacent déjà les écritures.
    try {
      await c.cmdSilent(':RS#');
      await c.cmdSilent(':R9#');
    } catch (_) { /* liaison en défaut : la séquence :Sr le détectera */ }
    const r1 = await this.setTargetBit(c, ':Sr', [proto.raCmd(raDeg), proto.raCmdLow(raDeg)]);
    if (r1 !== '1') {
      c.log('error', `GO TO : AD refusée par la raquette (${
        r1 === '0' ? ':Sr = 0, les 2 précisions' : r1 === 'mute' ? 'aucune réponse, même après ESC ESC' : 'liaison morte'})`);
      return r1 === '0' ? 'refused' : r1;
    }
    const r2 = await this.setTargetBit(c, ':Sd', [proto.decCmdHigh(decDeg), proto.decCmd(decDeg)]);
    if (r2 !== '1') {
      c.log('error', `GO TO : DEC refusée par la raquette (${
        r2 === '0' ? ':Sd = 0, les 2 précisions' : r2 === 'mute' ? 'aucune réponse, même après ESC ESC' : 'liaison morte'})`);
      return r2 === '0' ? 'refused' : r2;
    }
    let ms = '';
    try {
      // 3000 ms (v2.9.4, avant 5000) : une raquette qui répond le fait en
      // < 100 ms — 3 s suffisent, et un mutisme coûte 2 s de moins à chaque
      // GOTO qui retombera sur le relais.
      ms = await c.cmd(':MS#', 3000, VALID.digit);
    } catch (_) {
      if (!c.transportAlive()) return 'noLink';
      // :MS muet — le slew a peut-être démarré : on SONDE :D# avant d'échouer
      c.log('info', 'GO TO : :MS sans réponse — sonde :D# (slew parti ?)');
      if (await this.probeSlewStarted(c)) {
        c.log('info', 'GO TO : monture en mouvement détectée — slew confirmé parti');
        return 'ok';
      }
      c.log('error', 'GO TO : raquette muette (:MS et :D# sans réponse) — vérifiez la liaison, appuyez MODE sur la raquette puis réessayez');
      return 'mute';
    }
    if (ms === '0') return 'ok';
    if (ms === '1') return 'belowHorizon';
    if (ms === '2') return 'noObject';
    c.log('error', `GO TO : :MS réponse inattendue « ${ms} »`);
    return 'refused';
  },

  /** :MS muet — le GOTO a PEUT-ÊTRE démarré quand même (raquettes qui
   *  n'accusent pas réception avant de slewer). Sonde :D# (barre "|" pendant
   *  le moteur, vide à l'arrêt — spec Autostar). ~4 s max. */
  async probeSlewStarted(c: DriverClient, tries = 4): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      await sleep(700);
      if (!c.transportAlive()) return false;
      try {
        const d = await c.cmd(':D#', 1500);
        if (d.includes('|')) return true; // monture EN MOUVEMENT : le GOTO est parti
        if (d === '') return false; // monture À L'ARRÊT : :MS est resté sans effet
      } catch (_) { /* muette ce cycle : on retente */ }
    }
    return false;
  },

  async syncRaDec(c: DriverClient, raDeg: number, decDeg: number): Promise<boolean> {
    const r1 = await this.setTargetBit(c, ':Sr', [proto.raCmd(raDeg), proto.raCmdLow(raDeg)]);
    if (r1 !== '1') {
      c.log('error', `SYNC : AD refusée (${r1 === '0' ? ':Sr = 0' : r1 === 'mute' ? 'raquette muette' : 'liaison morte'})`);
      return false;
    }
    const r2 = await this.setTargetBit(c, ':Sd', [proto.decCmdHigh(decDeg), proto.decCmd(decDeg)]);
    if (r2 !== '1') {
      c.log('error', `SYNC : DEC refusée (${r2 === '0' ? ':Sd = 0' : r2 === 'mute' ? 'raquette muette' : 'liaison morte'})`);
      return false;
    }
    await c.cmdSilent(':CM#');
    return true;
  },

  async syncHere(c: DriverClient): Promise<void> {
    await c.cmdSilent(':CM#');
  },

  async setSpeed(c: DriverClient, s: Speed): Promise<void> {
    // v2.9.3 — DOUBLON DE FAMILLE pour slew/find : :RS#/:RM# (famille LX200
    // classique) ET :R9#/:R4# (niveaux explicites Autostar 1-9). Les #49x
    // acceptent les DEUX familles, LX200 classique ignore :Rn# — le doublon
    // garantit le taux voulu même si l'une des deux est avalée par le
    // tampon UART minuscule (une vitesse perdue = la monture reste au taux
    // précédent — center/guide du suivi — et TOUT le GOTO rampe).
    // 'center'/'guide' restent en simple : leur taux est MESURÉ au calibrage
    // avec :RC#/:RG# — ne pas décaler la mécanique mesurée.
    await c.cmdSilent(SPEED_CMDS[s]);
    if (s === 'slew') { await sleep(30); await c.cmdSilent(':R9#'); }
    else if (s === 'find') { await sleep(30); await c.cmdSilent(':R4#'); }
  },

  async startMove(c: DriverClient, dir: Dir): Promise<void> {
    const map: Record<Dir, string> = {n: ':Mn#', s: ':Ms#', e: ':Me#', w: ':Mw#'};
    await c.cmdSilent(map[dir]);
  },

  async stopMove(c: DriverClient, dir: Dir): Promise<void> {
    const map: Record<Dir, string> = {n: ':Qn#', s: ':Qs#', e: ':Qe#', w: ':Qw#'};
    await c.cmdSilent(map[dir]);
  },

  async stopAll(c: DriverClient): Promise<void> {
    await c.cmdSilent(':Q#');
  },

  async isMoving(c: DriverClient): Promise<boolean | null> {
    try {
      const d = await c.cmd(':D#', 1500);
      return d.includes('|');
    } catch (_) {
      return null;
    }
  },

  async setTracking(c: DriverClient, mode: 'altaz' | 'polar' | 'land'): Promise<void> {
    const map = {altaz: ':AA#', polar: ':AP#', land: ':AL#'};
    await c.cmdSilent(map[mode]);
  },

  async startAlign(c: DriverClient, kind: 'easy' | 'one' | 'two'): Promise<void> {
    const map = {easy: ':Aa#', one: ':Ab#', two: ':Ac#'};
    await c.cmdSilent(map[kind]);
  },

  async focusStart(c: DriverClient, inward: boolean): Promise<void> {
    await c.cmdSilent(inward ? ':F-#' : ':F+#');
  },
  async focusStop(c: DriverClient): Promise<void> {
    await c.cmdSilent(':FQ#');
  },
  /** Vitesse du moteur de mise au point — commandes LX200 classiques
   *  :FS#/:FM#/:FF# — silencieuses : une raquette qui ne les connaît pas
   *  les ignore sans erreur. */
  async setFocusSpeed(c: DriverClient, s: 'slow' | 'medium' | 'fast'): Promise<void> {
    await c.cmdSilent(s === 'fast' ? ':FF#' : s === 'medium' ? ':FM#' : ':FS#');
  },
  async reticleAdjust(c: DriverClient, delta: 1 | -1): Promise<void> {
    await c.cmdSilent(delta > 0 ? ':B+#' : ':B-#');
  },
  async park(c: DriverClient): Promise<void> {
    await c.cmdSilent(':hP#');
  },

  /** Lecture date/heure/site de la raquette (commande utilisateur). */
  async readSite(c: DriverClient) {
    const [time, date, tz, lat, lon] = await Promise.all([
      c.cmd(':GL#', 3000, VALID.ra), c.cmd(':GC#', 3000, VALID.date),
      c.cmd(':GG#', 3000, VALID.tz),
      c.cmd(':Gt#', 3000, VALID.dec).catch(() => ''),
      c.cmd(':Gg#', 3000, VALID.dec).catch(() => ''),
    ]);
    // v2.2.1 — MEADE → cartographique :
    //  - :Gg# renvoie la longitude avec l'EST NÉGATIF ("-002*21" pour Paris)
    //    ou en 0-360 Ouest-positif ("357*39") selon le firmware — les deux
    //    formes sont converties vers Est-positif (lonDegFromMeade) ;
    //  - :GG# renvoie les heures ajoutées à l'heure locale pour obtenir UTC
    //    ("-02" en France été) — affiché en convention standard ("+02.0").
    const lonMeade = parseMeadeDec(lon);
    const tzMeade = parseFloat(tz);
    return {
      time,
      date,
      tz: Number.isNaN(tzMeade) ? tz : String(-tzMeade),
      latDeg: parseMeadeDec(lat),
      lonDeg: lonMeade === null ? null : lonDegFromMeade(lonMeade),
    };
  },

  /** Envoie date/heure/site du téléphone vers la raquette. Les commandes
   *  :SG/:SL/:SC/:St/:Sg RÉPONDENT ("1") — la réponse est consommée (et
   *  tolérée si muette). CONVENTIONS MEADE (protocole révision 2010.10) :
   *  :SG = UTC − local ; :Sg = longitude Est-NEGATIF. */
  async pushSite(c: DriverClient, latDeg: number, lonDeg: number): Promise<{time: string; date: string}> {
    const now = new Date();
    const tzOffsetMin = -now.getTimezoneOffset(); // standard : local − UTC (+120 France été)
    // :SG accepte les heures décimales fractionnaires (ex. +05.5 pour l'Inde)
    const tzH = Math.floor(Math.abs(tzOffsetMin) / 60);
    const tzM = Math.abs(tzOffsetMin) % 60;
    const tzVal = (tzH + tzM / 60).toFixed(1).padStart(4, '0');
    // heure locale de la raquette
    const local = new Date(now.getTime() + tzOffsetMin * 60000);
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const mm = String(local.getUTCMinutes()).padStart(2, '0');
    const ss = String(local.getUTCSeconds()).padStart(2, '0');
    const dd = String(local.getUTCDate()).padStart(2, '0');
    const mo = String(local.getUTCMonth() + 1).padStart(2, '0');
    const yy = String(local.getUTCFullYear()).slice(2);
    const rejected: string[] = [];
    const send = async (cmdStr: string, timeoutMs: number) => {
      const r = await c.cmd(cmdStr, timeoutMs, VALID.bit).catch(() => null);
      if (r === '0') rejected.push(cmdStr.slice(0, 3));
    };
    await send(`:SG${tzOffsetMin >= 0 ? '-' : '+'}${tzVal}#`, 2000);
    await sleep(120);
    await send(`:SL${hh}:${mm}:${ss}#`, 2000);
    await sleep(120);
    await send(`:SC${mo}/${dd}/${yy}#`, 2500);
    await sleep(400);
    await send(`:St${proto.decCmd(latDeg)}#`, 2000);
    await sleep(120);
    await send(`:Sg${proto.lonCmd(lonDeg)}#`, 2000);
    if (rejected.length > 0) {
      c.warn(
        `Raquette : commandes refusées (${rejected.join(', ')}) — fuseau/site non appliqués, vérifiez Réglages`);
    }
    return {time: `${hh}:${mm}:${ss}`, date: `${mo}/${dd}/${yy}`};
  },

  async lcd(c: DriverClient) {
    const reply = await c.cmd(':ED#', 900, /^[\u0080-\u00FF]/).catch(() => '');
    return parseLcdReply(reply);
  },

  /** Réponse BRUTE :ED# (marqueur inclus) — pour la flèche de SÉLECTION. */
  async lcdRaw(c: DriverClient): Promise<string | null> {
    const reply = await c.cmd(':ED#', 900, /^[\u0080-\u00FF]/).catch(() => '');
    return reply && reply.length >= 32 ? reply : null;
  },

  async keyPress(c: DriverClient, code: number): Promise<void> {
    await c.cmdSilent(`:EK${code}#`);
  },
};

registerDriver(MEADE_DRIVER);
