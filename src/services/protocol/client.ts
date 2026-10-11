/**
 * AutostarClient — moteur de protocole Meade (LX200 / Autostar / Autostar II).
 * File d'attente sérielle, gestion d'écho, délais, API haut niveau.
 */
import type {ConnectOptions, Transport, TransportType} from '../connection/types';
import {TransportError} from '../connection/types';
import {TcpTransport} from '../connection/tcp';
import {BluetoothTransport} from '../connection/bluetooth';
import {UsbTransport} from '../connection/usb';
import {DemoTransport, setDemoSite} from '../connection/demo';
import {SPEED_CMDS} from './profiles';
import {proto} from '../astro/time';
import type {ScopeModelId} from '../../store/settingsStore';
import {useSettingsStore} from '../../store/settingsStore';
import {useScopeStore} from '../../store/scopeStore';

export type Dir = 'n' | 's' | 'e' | 'w';
export type Speed = keyof typeof SPEED_CMDS;

export interface RaDec {raDeg: number; decDeg: number}

/** Résultat d'un GOTO (v2.0.1) — voir AutostarClient.gotoRaDec. */
export type GotoStatus = 'ok' | 'belowHorizon' | 'noObject' | 'refused' | 'mute' | 'noLink';

/** Textes i18n nécessaires pour traduire un statut de GOTO. */
export interface GotoErrorTexts {
  belowHorizon: string;
  empty: string;
  gotoNoLink: string;
  gotoMute: string;
  refused: string;
}

/** Message localisé pour un statut de GOTO — partagé par tous les écrans
 *  (v2.0.1 : chaque cause a SON message : liaison morte, raquette muette,
 *  refus protocolaire — au lieu d'un « Connexion refusée » fourre-tout). */
export function gotoErrorText(r: GotoStatus, x: GotoErrorTexts): string {
  if (r === 'ok') return '';
  return r === 'belowHorizon' ? x.belowHorizon
    : r === 'noObject' ? x.empty
    : r === 'noLink' ? x.gotoNoLink
    : r === 'mute' ? x.gotoMute
    : x.refused;
}

/**
 * MIROIR LCD (v1.8.1) — le LCD de la raquette VIRTUELLE affiche le LITTÉRAL
 * de l'écran de la raquette PHYSIQUE, relu en continu par :ED# (extension
 * raquette Autostar : réponse = marqueur 0x80–0xDF + 32 caractères (2×16)
 * + '#'). C'est le mécanisme exact du Remote Handbox d'AutostarSuite et de
 * ScopeBoss (prouvé matériellement : log astropad du repo LX200emulator —
 * une Autostar réelle répond \x97 + « Select Item:      Object         »).
 * Le glyphe 0xDF est le « ° » du LCD matériel ; les marqueurs varient
 * (0x97 menus, 0x9F boot/vitesses, 0xD0/0xD1 saisie numérique…).
 */
export const LCD_STALE_MS = 2500;

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

/**
 * Codes ASCII des touches physiques pour :EK<ascii># (simulation d'appuis
 * SUR la raquette physique). Sources : header de lx200emulator.py et log
 * astropad (ScopeBoss réel) : Mode=9, Enter=13, flèche haut/N=85, bas/S=68,
 * gauche/W=87, droite/E=69, GO TO=71, chiffres=48–57 (l'émulateur v2 ajoute
 * 63='?'). Sur #49x en mode menu, flèches et touches de défilement ont le
 * même effet → les touches de défilement VIRTUELLES réutilisent 85/68.
 */
export const HB_KEYS = {
  mode: 9,
  enter: 13,
  goto: 71,
  help: 63,
  up: 85,    // flèche haut (Nord)
  down: 68,  // flèche bas (Sud)
  west: 87,  // flèche gauche (Ouest)
  east: 69,  // flèche droite (Est)
  digit0: 48, // 0–9 = 48 + n
} as const;

/** Code :EK# d'une touche chiffre. */
export const hbDigitKey = (d: number): number => HB_KEYS.digit0 + d;

/**
 * Devine la génération de raquette d'après la réponse :GVP#/:GVN#.
 * Renvoie null si rien ne permet de trancher (l'app garde alors le modèle
 * choisi dans Réglages). Ordre des tests : du plus spécifique au plus large.
 */
export function matchFirmware(product: string, version: string): ScopeModelId | null {
  const p = (product ?? '').trim().toLowerCase();
  if (!p || p === '?') return null;
  if (/autostar\s*ii|autostar-?ii/.test(p)) return 'autostar2';
  // LX200GPS/RCX400/RMS : raquette de type Autostar II (firmware 4x/5x)
  if (/gps|rcx|rms|starlock/.test(p)) return 'autostar2';
  if (/lx-?200|magellan/.test(p)) return 'lx200';
  if (/autostar|#?49[457]|etx|lx90/.test(p)) {
    // mentions explicites du numéro (#494/#495/#497) — ponts ou démo
    if (/494/.test(p)) return 'autostar494';
    if (/495/.test(p)) return 'autostar495';
    if (/497/.test(p)) return 'autostar497';
    const maj = parseInt((version ?? '').trim()[0] ?? '', 10);
    // #497 : versions 4x+ (43E1, 52Eg…) — #495 : versions plus anciennes
    if (!Number.isNaN(maj) && maj >= 4) return 'autostar497';
    return 'autostar495';
  }
  return null;
}

// Longitudes Meade : +DDD*MM (3 chiffres) — latitudes : ±DD*MM
// Signe optionnel : certaines versions renvoient "45*23" pour +45°23'.
const DEC_RE = /^([+-])?(\d{1,3})\D(\d{1,2})/;

function parseDec(s: string): number | null {
  const m = s.trim().match(DEC_RE);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (+m[2] + +m[3] / 60);
}

function parseRa(s: string): number | null {
  // "HH:MM:SS" (Autostar) ou "HH:MM.T" (LX200 classique, dixièmes de minute)
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2})|\.(\d))?/);
  if (!m) return null;
  const h = +m[1];
  const mm = +m[2];
  const sec = m[3] ? +m[3] / 3600 : m[4] ? +m[4] / 10 / 60 : 0;
  return (h + mm / 60 + sec) * 15;
}

/**
 * Format attendu des réponses, par commande. Sert à rejeter une réponse
 * « en retard » d'une commande expirée (raquette occupée pendant un moteur)
 * qui sinon serait attribuée à la commande suivante : une réponse hors
 * format est jetée, la vraie réponse qui suit est acceptée normalement.
 * IMPORTANT (v1.5.0) : le tampon série n'est PAS purgé entre deux commandes
 * — une réponse qui arrive APRÈS son délai d'attente reste dans le tampon
 * et sera consommée (rejetée ou acceptée) par la commande suivante. Purger
 * détruisait ces réponses tardives et faisait échouer la synchro en boucle
 * sur les raquettes qui répondent lentement (écran LCD en cours de
 * rafraîchissement, bus moteur occupé).
 */
const VALID = {
  ra: /^\d{1,2}:\d{2}/,          // :Gr# :GL#  → "HH:MM:SS" ou "HH:MM.T"
  dec: /^[+-]?\d{1,3}[°*]\d{1,2}|^[+-]\d{1,3}:\d{1,2}/, // :Gd# :Ga# :Gz#… → "sDD*MM" (tolère "sDD:MM")
  date: /^\d{1,2}\/\d{1,2}/,     // :GC# → "MM/JJ/AA"
  tz: /^[+-]?\d/,                // :GG# → heures de décalage
  bit: /^[01]$/,                 // :Sr# :Sd# → validé/refusé
  digit: /^\d/,                  // :MS# → 0/1/2
} as const;

export class AutostarClient {
  private transport: Transport | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private buffer = '';
  private pending: {cmd: string; expect?: RegExp; resolve: (s: string) => void; reject: (e: Error) => void; timer: number} | null = null;
  private pollTimer: number | null = null;
  private pollIntervalMs = 1200;
  private pollAltAzOn = false;
  private pollTick = 0;
  private pollBusy = false;
  private failCount = 0;
  private lastRaDeg: number | null = null;
  private lastDecDeg: number | null = null;
  private lastPosAt = 0; // horodatage de la dernière lecture AD/DEC complète
  /** Dernier alt/az lu (repli de mouvement quand AD/DEC est muet). */
  private lastAltDeg: number | null = null;
  private lastAzDeg: number | null = null;
  private lastAltAzAt = 0;
  private lastProbeAt = 0; // dernier diagnostic :GVP# (mode muet)
  private muteLogged = false; // message « muette » déjà journalisé ?
  /** Compteur d'échecs :ED# (repli télémétrie après 6) + flag 1er succès. */
  private lcdFail = 0;
  private lcdLogged = false;
  /** Fenêtre pendant laquelle un mouvement est attribué à L'APP (commandes
   *  :Mn…/:MS# qu'elle vient d'envoyer) — hors fenêtre, le mouvement constaté
   *  vient de la raquette physique. */
  private ownMoveUntil = 0;
  /** Flèches VIRTUELLES tenues : pendant ce temps, tout mouvement est à
   *  l'app, quelle que soit la fenêtre ownMoveUntil (fini les 30 s qui
   *  masquaient les appuis sur la raquette physique). */
  private holding = new Set<Dir>();
  /** Jusqu'à quand les commandes UTILISATEUR passent avant le polling
   *  (les ticks de poll sont sautés juste après une action utilisateur). */
  private priorityUntil = 0;
  /** Dernier cycle où la position bougeait (tolérance : beaucoup de raquettes
   *  ne répondent pas au port série pendant un moteur). */
  private lastMovedFlag = false;
  private lastExternalAt = 0;
  /** Horodatage de la position PRÉCÉDENTE (pour le taux de déplacement). */
  private prevPosAt = 0;
  /** « Slewing... » reste affiché 1,2 s après le dernier slew rapide constaté
   *  (les cycles où les axes sont muets pendant le moteur ne le font pas
   *  clignoter). */
  private slewFastUntil = 0;
  private log = (dir: 'sent' | 'recv' | 'info' | 'error', text: string) =>
    useScopeStore.getState().pushLog(dir, text);

  isConnected() {return this.transport?.isConnected() ?? false;}
  getTransportType(): TransportType | null {return this.transport?.type ?? null;}

  async connect(type: TransportType, opts: ConnectOptions, model: ScopeModelId): Promise<void> {
    await this.disconnect();
    const store = useScopeStore.getState();
    store.setConnStatus('connecting');
    let transport: Transport;
    switch (type) {
      case 'bluetooth': transport = new BluetoothTransport(); break;
      case 'usb': transport = new UsbTransport(); break;
      case 'demo': transport = new DemoTransport(model); break;
      default: transport = new TcpTransport(); break;
    }
    transport.onData((chunk) => this.onData(chunk));
    transport.onError((msg) => {
      this.log('error', msg);
    });
    transport.onClosed(() => this.handleLinkClosed());
    try {
      await transport.connect(opts);
    } catch (e) {
      store.setConnStatus('error');
      store.pushLog('error', `Connexion échouée : ${(e as Error).message}`);
      throw e;
    }
    this.transport = transport;
    if (transport.type !== 'demo') {
      // ESC ESC SYSTÉMATIQUE (sauf démo) : bascule les Autostar #49x en mode
      // PC série. Le besoin dépend du MATÉRIEL réel, pas du modèle choisi —
      // l'envoyer quel que soit le modèle garantit qu'un #497 répond même si
      // la présélection était mauvaise (les autres raquettes ignorent ces
      // octets). Sans cela, un #497 réveillé en dernier restait muet : c'est
      // le volet « liaison » du miroir qui ne démarrait jamais.
      try {await transport.write('\x1b\x1b'); await sleep(500);} catch (_) {}
      this.log('info', 'Séquence ESC ESC envoyée (mode PC série Autostar)');
    }
    useScopeStore.getState().setConnStatus('connected');
    useScopeStore.getState().setTransportType(transport.type);
    useScopeStore.getState().setModel(model);
    this.log('info', `Connecté (${transport.type}, modèle ${model})`);
    if (transport.type === 'demo') setDemoSite(0, 0); // site ajusté par les écrans
    this.startPoll();
    handboxSync.enable(); // synchro temps réel par défaut dès la connexion
    this.detectFirmware(); // mappage du clavier auto — asynchrone, non bloquant
  }

  /**
   * Détection du firmware par la liaison établie dans l'onglet Connexion :
   * lit :GVP#/:GVN# puis sélectionne automatiquement la configuration
   * optimale — le modèle détecté pilote toute l'app (profil de capacités,
   * menus, mappage du clavier, voir keymaps.ts) et remplace le choix manuel
   * de l'onglet Connexion, qui reste la configuration de secours quand le
   * firmware est muet ou méconnu. Le résultat est affiché dans l'onglet
   * Connexion (carte « Micrologiciel détecté ») et journalisé. Silencieux :
   * une raquette muette ne doit jamais empêcher l'utilisation de l'app.
   */
  async detectFirmware() {
    try {
      const {product, version} = await this.getFirmware();
      const model = matchFirmware(product, version);
      const s = useScopeStore.getState();
      s.setFirmware(product, version, model);
      if (model) {
        // Configuration optimale : le modèle détecté est appliqué à toute
        // l'app (capacités, menus, clavier) et sélectionné dans l'onglet
        // Connexion à la place du choix de secours.
        useSettingsStore.getState().setModel(model);
        s.setModel(model);
        s.pushLog('info', `Firmware détecté : ${product} ${version} → configuration ${model} appliquée`);
      } else {
        s.pushLog('info', `Firmware : ${product} ${version} — non reconnu, modèle de l'onglet Connexion conservé`);
      }
    } catch {
      useScopeStore.getState().pushLog('info', 'Firmware illisible — modèle de l\'onglet Connexion conservé');
    }
  }

  async disconnect(): Promise<void> {
    this.stopPoll();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new TransportError('Déconnecté'));
      this.pending = null;
    }
    try {await this.transport?.disconnect();} catch (_) {}
    this.transport = null;
    this.buffer = '';
    this.lastRaDeg = null;
    this.lastDecDeg = null;
    this.lastAltDeg = null;
    this.lastAzDeg = null;
    this.lastAltAzAt = 0;
    this.lastMovedFlag = false;
    this.lastExternalAt = 0;
    this.prevPosAt = 0;
    this.slewFastUntil = 0;
    this.ownMoveUntil = 0;
    this.holding.clear();
    this.priorityUntil = 0;
    this.lastPosAt = 0;
    this.lastProbeAt = 0;
    this.muteLogged = false;
    this.failCount = 0;
    this.lcdFail = 0;
    this.lcdLogged = false;
    handboxSync.reset(); // purge synchro + état physique (mêmes IDs que onClosed)
    const s = useScopeStore.getState();
    s.setConnStatus('disconnected');
    s.setTransportType(null);
    s.setFirmware(null, null, null);
    s.setHbHint('none');
  }

  /** Liaison perdue constatée EN COURS D'UTILISATION (écriture impossible,
   *  transport mort — ex. câble USB retiré sans événement usbDetached, socket
   *  TCP/BT coupé sans onClosed) : même nettoyage que la fermeture transport,
   *  l'état « connected » du store ne doit jamais rester un fantôme. (v2.0.1) */
  private handleLinkClosed() {
    if (useScopeStore.getState().connStatus === 'disconnected') return; // déjà fait
    this.stopPoll();
    const s = useScopeStore.getState();
    s.setConnStatus('disconnected');
    s.setFirmware(null, null, null);
    s.setHasPos(false);
    s.setHbMoving(false);
    s.setHbExternal(false);
    s.setHbDirs(null);
    s.setHbSlewFast(false);
    s.setHbHint('none');
    s.pushLog('error', 'Liaison perdue — reconnectez la raquette');
    handboxSync.reset();
  }

  /* ---------- couche basse ---------- */

  private onData(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-2048);
    // traite toutes les réponses complètes disponibles : après une réponse
    // périmée jetée, la vraie réponse peut déjà attendre dans le tampon
    let guard = 0;
    while (this.pending && guard++ < 32) {
      const p = this.pending;
      // gestion d'écho : la raquette peut renvoyer la commande telle quelle
      let buf = this.buffer;
      if (buf.startsWith(p.cmd)) buf = buf.slice(p.cmd.length);
      const i = buf.indexOf('#');
      if (i < 0) break;
      const reply = buf.slice(0, i);
      this.buffer = buf.slice(i + 1);
      if (p.expect && !p.expect.test(reply)) {
        // réponse hors format = réponse en retard d'une commande déjà
        // expirée : jetée, la vraie réponse pourra arriver derrière
        this.log('info', `Réponse hors attente ignorée (« ${reply} »)`);
        continue;
      }
      clearTimeout(p.timer);
      this.pending = null;
      if (reply.length) this.log('recv', reply);
      p.resolve(reply);
    }
  }

  /** Envoie une commande et attend une réponse '#'-terminée (format vérifié).
   *  Le tampon n'est PAS purgé avant l'envoi : une réponse « en retard »
   *  d'une commande expirée reste consommable par celle-ci (rejetée si hors
   *  format, acceptée si elle colle — dans le pire cas une position vieille
   *  de 1-2 s vaut mieux qu'aucune). */
  cmd(command: string, timeoutMs = 3000, expect?: RegExp): Promise<string> {
    if (!this.transport) return Promise.reject(new TransportError('Non connecté'));
    const run = () =>
      new Promise<string>((resolve, reject) => {
        if (!this.transport) return reject(new TransportError('Non connecté'));
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new TransportError(`Délai dépassé : ${command}`));
        }, timeoutMs) as unknown as number;
        this.pending = {cmd: command, expect, resolve, reject, timer};
        this.log('sent', command);
        this.transport.write(command).catch((e) => {
          clearTimeout(timer);
          if (this.pending) {this.pending = null;}
          reject(e);
        });
      });
    const chained = this.queue.then(run, run);
    this.queue = chained.catch(() => {});
    return chained;
  }

  /** Commande sans réponse attendue (mouvements, vitesse, focus…) —
   *  toujours initiée par l'utilisateur : priorité sur le polling. */
  async cmdSilent(command: string): Promise<void> {
    if (!this.transport) throw new TransportError('Non connecté');
    this.bump();
    this.log('sent', command);
    try {
      await this.transport.write(command);
    } catch (e) {
      this.log('error', String((e as Error).message));
      throw e;
    }
  }

  /* ---------- API haut niveau ---------- */

  async getRaDec(timeoutMs = 3000): Promise<RaDec> {
    // séquentiel avec échec rapide : si :Gr# ne répond pas, inutile d'attendre
    // aussi :Gd# (raquette muette sur la position = cycle 2× plus court)
    const ra = await this.cmd(':Gr#', timeoutMs, VALID.ra);
    const dec = await this.cmd(':Gd#', timeoutMs, VALID.dec);
    const raDeg = parseRa(ra);
    const decDeg = parseDec(dec);
    if (raDeg === null || decDeg === null) throw new TransportError('Réponse position illisible');
    return {raDeg, decDeg};
  }

  /**
   * Lecture AD/DEC TOLÉRANTE pour le polling : chaque axe est indépendant
   * (une raquette peut répondre à :Gr# mais tarder sur :Gd# — on garde
   * l'axe lu au lieu de tout jeter). Renvoie null par axe si muet/illisible.
   * Petite respiration (40 ms) entre les 2 commandes : le tampon UART des
   * Autostar est minuscule, deux commandes collées peuvent perdre la 2e.
   */
  async readPosition(): Promise<{raDeg: number | null; decDeg: number | null}> {
    // Timeout ADAPTATIF : si aucun axe ne répond depuis plusieurs cycles
    // (liaison muette), on raccourcit l'attente pour ne pas geler le rythme
    // du miroir ni retarder la reprise dès que la raquette se réveille.
    const mute = this.lastPosAt > 0 && Date.now() - this.lastPosAt > 6000;
    const timeout = mute ? 1800 : 3000;
    let raDeg: number | null = null;
    let decDeg: number | null = null;
    try {
      const ra = await this.cmd(':Gr#', timeout, VALID.ra);
      raDeg = parseRa(ra);
    } catch (_) { /* axe muet ce cycle */ }
    await sleep(40);
    try {
      const dec = await this.cmd(':Gd#', timeout, VALID.dec);
      decDeg = parseDec(dec);
    } catch (_) { /* axe muet ce cycle */ }
    return {raDeg, decDeg};
  }

  async getFirmware(): Promise<{product: string; version: string}> {
    const product = await this.cmd(':GVP#').catch(() => '?');
    const version = await this.cmd(':GVN#').catch(() => '?');
    return {product, version};
  }

  /**
   * Lecture du LCD RÉEL de la raquette physique (:ED#, timeout court).
   * Renvoie null si la raquette ne connaît pas :ED# (LX200 classique) ou
   * est muette ce cycle — l'appelant garde alors son écran précédent.
   */
  async getLcd(): Promise<{line1: string; line2: string} | null> {
    const reply = await this.cmd(':ED#', 900, /^[\u0080-\u00FF]/).catch(() => '');
    return parseLcdReply(reply);
  }

  /**
   * Simule un appui de touche SUR la raquette physique (:EK<ascii>#).
   * La raquette réagit exactement comme si la touche avait été pressée
   * (menus, navigation, GO TO sur son dernier objet) — et son écran,
   * relu par :ED#, se répercute sur la raquette virtuelle : c'est le
   * comportement du Hand Control Panel d'AutostarSuite.
   */
  async keyPress(code: number): Promise<void> {
    await this.cmdSilent(`:EK${code}#`);
  }

  async setSpeed(speed: Speed) {
    await this.cmdSilent(SPEED_CMDS[speed]);
  }

  async startMove(dir: Dir) {
    const map: Record<Dir, string> = {n: ':Mn#', s: ':Ms#', e: ':Me#', w: ':Mw#'};
    this.bump();
    await this.cmdSilent(map[dir]);
    this.ownMoveUntil = Date.now() + 2500; // mouvement attribué à l'app
  }

  /** Marque le mouvement en cours comme initié par l'app (GOTO…). */
  markOwnMove(holdMs = 30000) {
    this.ownMoveUntil = Math.max(this.ownMoveUntil, Date.now() + holdMs);
  }

  /** Flèche virtuelle tenue (dirStart) : le mouvement constaté est celui
   *  ordonné par l'app tant que la flèche n'est pas relâchée. */
  setVirtualHold(d: Dir, on: boolean) {
    if (on) this.holding.add(d);
    else {
      this.holding.delete(d);
      this.ownMoveUntil = Date.now() + 1500; // inertie : dernier delta à l'app
    }
  }

  /** Priorité aux commandes utilisateur : les ticks de polling sont sautés
   *  un court instant pour que l'appui soit exécuté sans attendre le cycle
   *  de lecture en cours. */
  private bump() {
    this.priorityUntil = Date.now() + 700;
  }

  async stopMove(dir: Dir) {
    const map: Record<Dir, string> = {n: ':Qn#', s: ':Qs#', e: ':Qe#', w: ':Qw#'};
    this.bump();
    await this.cmdSilent(map[dir]);
    this.ownMoveUntil = Date.now() + 1200;
  }

  async stopAll() {
    this.bump();
    await this.cmdSilent(':Q#');
    this.ownMoveUntil = Date.now() + 1200;
  }

  /** Pose la cible (:Sr OU :Sd) avec la ROBUSTESSE complète (v2.0.1) :
   *  - refus explicite ("0") → l'AUTRE précision est essayée (v1.8.1) ;
   *  - AUCUNE réponse (délai dépassé) → la raquette est muette : reset du
   *    parseur par ESC ESC (même séquence que la connexion) puis UNE
   *    retentative du même format — l'échec muet n'est pas une histoire de
   *    format, inutile d'insister sur l'autre précision ;
   *  - écriture impossible / transport mort → 'noLink' + état de connexion
   *    remis à zéro (fini le « connected » fantôme après un câble retiré).
   *  Renvoie '1' (accepté), '0' (refus EXPLICITE de la raquette),
   *  'mute' (toujours muette après reset) ou 'noLink'. */
  private async setTargetBit(prefix: string, formats: string[]): Promise<'1' | '0' | 'mute' | 'noLink'> {
    let explicitRefused = false;
    for (const f of formats) {
      const full = `${prefix}${f}#`;
      let r: string;
      try {
        r = await this.cmd(full, 2500, VALID.bit);
      } catch (_) {
        if (!this.transport?.isConnected()) {
          this.handleLinkClosed();
          return 'noLink';
        }
        // muette : reset parseur (ESC ESC) puis UNE retentative
        try {await this.transport.write('\x1b\x1b'); await sleep(350);} catch (_) {}
        try {
          r = await this.cmd(full, 2500, VALID.bit);
        } catch (_) {
          if (!this.transport?.isConnected()) {
            this.handleLinkClosed();
            return 'noLink';
          }
          return 'mute'; // raquette muette même après reset — pas un problème de format
        }
      }
      if (r === '1') return '1';
      explicitRefused = true; // « 0 » explicite : la raquette VIT et refuse → autre précision
    }
    return explicitRefused ? '0' : 'mute';
  }

  /** :MS muet — le GOTO a PEUT-ÊTRE démarré quand même (raquettes qui
   *  n'accusent pas réception avant de slewer). Sonde :D# (barre "|" pendant
   *  le moteur, vide à l'arrêt — spec Autostar) : "|" → le slew EST parti.
   *  ~4 s max, tolérante aux cycles muets pendant le moteur. */
  private async probeSlewStarted(tries = 4): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      await sleep(700);
      if (!this.isConnected()) return false;
      try {
        const d = await this.cmd(':D#', 1500);
        if (d.includes('|')) return true; // monture EN MOUVEMENT : le GOTO est parti
        if (d === '') return false; // monture À L'ARRÊT : :MS est resté sans effet
      } catch (_) { /* muette ce cycle : on retente */ }
    }
    return false;
  }

  /** GOTO vers RA/Dec. Renvoie un statut FIN (v2.0.1) :
   *  'ok'          — slew parti (ou confirmé parti par sonde :D#) ;
   *  'belowHorizon'— :MS = 1 (objet sous l'horizon) ;
   *  'noObject'    — :MS = 2 (objet introuvable/range) ;
   *  'refused'     — REFUS EXPLICITE de la raquette (:Sr/:Sd = 0 dans les
   *                  deux précisions, ou :MS code inattendu) ;
   *  'mute'        — raquette muette (aucune réponse, même après ESC ESC) —
   *                  le GOTO a peut-être malgré tout démarré (sondé par :D#) ;
   *  'noLink'      — liaison morte (écriture impossible) : état remis à zéro,
   *                  il faut se reconnecter.
   *  ROBUSTESSE (v1.8.1) : le format des coordonnées dépend du mode de
   *  précision de la raquette (haute "HH:MM:SS"/"sDD*MM:SS", basse
   *  "HH:MM.T"/"sDD*MM") — un format refusé ("0") est retenté dans
   *  l'autre précision AVANT de renoncer : un GO TO ne doit jamais échouer
   *  pour une histoire de format. La fin du slew est suivie par :D#
   *  (barre "|" pendant le moteur, chaîne vide à l'arrivée — spec Autostar). */
  async gotoRaDec(raDeg: number, decDeg: number): Promise<GotoStatus> {
    this.bump();
    const r1 = await this.setTargetBit(':Sr', [proto.raCmd(raDeg), proto.raCmdLow(raDeg)]);
    if (r1 !== '1') {
      this.log('error', `GO TO : AD refusée par la raquette (${
        r1 === '0' ? ':Sr = 0, les 2 précisions' : r1 === 'mute' ? 'aucune réponse, même après ESC ESC' : 'liaison morte'})`);
      return r1 === '0' ? 'refused' : r1;
    }
    const r2 = await this.setTargetBit(':Sd', [proto.decCmdHigh(decDeg), proto.decCmd(decDeg)]);
    if (r2 !== '1') {
      this.log('error', `GO TO : DEC refusée par la raquette (${
        r2 === '0' ? ':Sd = 0, les 2 précisions' : r2 === 'mute' ? 'aucune réponse, même après ESC ESC' : 'liaison morte'})`);
      return r2 === '0' ? 'refused' : r2;
    }
    let ms = '';
    try {
      ms = await this.cmd(':MS#', 5000, VALID.digit);
    } catch (_) {
      if (!this.transport?.isConnected()) {
        this.handleLinkClosed();
        return 'noLink';
      }
      // :MS muet — le slew a peut-être démarré : on SONDE :D# avant d'échouer
      this.log('info', 'GO TO : :MS sans réponse — sonde :D# (slew parti ?)');
      if (await this.probeSlewStarted()) {
        this.log('info', 'GO TO : monture en mouvement détectée — slew confirmé parti');
        this.ownMoveUntil = Date.now() + 45000;
        this.watchSlewEnd();
        return 'ok';
      }
      this.log('error', 'GO TO : raquette muette (:MS et :D# sans réponse) — vérifiez la liaison, appuyez MODE sur la raquette puis réessayez');
      return 'mute';
    }
    if (ms === '0') {
      this.ownMoveUntil = Date.now() + 45000; // GOTO : slew possiblement long
      this.watchSlewEnd();
      return 'ok';
    }
    if (ms === '1') return 'belowHorizon';
    if (ms === '2') return 'noObject';
    this.log('error', `GO TO : :MS réponse inattendue « ${ms} »`);
    return 'refused';
  }

  /** Suit la fin du GOTO par :D# ("|" pendant le moteur, vide à l'arrivée).
   *  Boucle tolérante : les raquettes muettes pendant un moteur ne coupent
   *  pas la surveillance ; la moindre réponse vide ou stabilisation de
   *  position clôt l'épisode. Fire-and-forget (max 3 min). */
  private watchSlewEnd(cycles = 0) {
    if (cycles > 260) return; // ~3 min à 700 ms
    setTimeout(() => {
      if (!this.isConnected()) return;
      this.cmd(':D#', 1500)
        .then((d) => {
          if (d === '') {
            const s = useScopeStore.getState();
            s.pushLog('info', 'GOTO terminé (monture arrivée)');
            this.ownMoveUntil = Date.now() + 1200;
          } else {
            this.watchSlewEnd(cycles + 1);
          }
        })
        .catch(() => this.watchSlewEnd(cycles + 1)); // muette : on réessaie
    }, 700);
  }

  async syncHere(): Promise<void> {
    await this.cmdSilent(':CM#');
  }

  /**
   * SYNC sur des coordonnées données (v1.9.0, recalage télémétrie) :
   * :Sr/:Sd posent la cible puis :CM# déclare la position physique courante
   * = ces coordonnées. Met à jour l'alignement INTERNE de l'Autostar sans
   * GOTO. Renvoie false si la raquette refuse :Sr/:Sd (explicitement ou par
   * mutisme — la même robustesse que le GOTO v2.0.1 s'applique).
   */
  async syncRaDec(raDeg: number, decDeg: number): Promise<boolean> {
    this.bump();
    const r1 = await this.setTargetBit(':Sr', [proto.raCmd(raDeg), proto.raCmdLow(raDeg)]);
    if (r1 !== '1') {
      this.log('error', `SYNC : AD refusée (${r1 === '0' ? ':Sr = 0' : r1 === 'mute' ? 'raquette muette' : 'liaison morte'})`);
      return false;
    }
    const r2 = await this.setTargetBit(':Sd', [proto.decCmdHigh(decDeg), proto.decCmd(decDeg)]);
    if (r2 !== '1') {
      this.log('error', `SYNC : DEC refusée (${r2 === '0' ? ':Sd = 0' : r2 === 'mute' ? 'raquette muette' : 'liaison morte'})`);
      return false;
    }
    await this.cmdSilent(':CM#');
    return true;
  }

  /** Lecture date/heure/site de la raquette (commande utilisateur). */
  async readScopeData(): Promise<{
    time: string; date: string; tz: string; latDeg: number | null; lonDeg: number | null;
  }> {
    this.bump();
    const [time, date, tz, lat, lon] = await Promise.all([
      this.cmd(':GL#', 3000, VALID.ra), this.cmd(':GC#', 3000, VALID.date),
      this.cmd(':GG#', 3000, VALID.tz),
      this.cmd(':Gt#', 3000, VALID.dec).catch(() => ''),
      this.cmd(':Gg#', 3000, VALID.dec).catch(() => ''),
    ]);
    return {time, date, tz, latDeg: parseDec(lat), lonDeg: parseDec(lon)};
  }

  /** Envoie date/heure/site du téléphone vers la raquette. Les commandes
   *  :SG/:SL/:SC/:St/:Sg RÉPONDENT ("1") — la réponse est consommée (et
   *  tolérée si muette) au lieu de rester dans le tampon série. */
  async pushPhoneData(latDeg: number, lonDeg: number): Promise<void> {
    this.bump();
    const now = new Date();
    const tzOffsetMin = -now.getTimezoneOffset();
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
    const ignore = () => undefined;
    await this.cmd(`:SG${tzOffsetMin >= 0 ? '+' : '-'}${tzVal}#`, 2000, VALID.bit).catch(ignore);
    await sleep(120);
    await this.cmd(`:SL${hh}:${mm}:${ss}#`, 2000, VALID.bit).catch(ignore);
    await sleep(120);
    await this.cmd(`:SC${mo}/${dd}/${yy}#`, 2500, VALID.bit).catch(ignore);
    await sleep(400);
    await this.cmd(`:St${proto.decCmd(latDeg)}#`, 2000, VALID.bit).catch(ignore);
    await sleep(120);
    const lonMeade = lonDeg < 0 ? 360 + lonDeg : lonDeg;
    await this.cmd(`:Sg${proto.decCmd(lonMeade)}#`, 2000, VALID.bit).catch(ignore);
  }

  async setTracking(mode: 'altaz' | 'polar' | 'land') {
    const map = {altaz: ':AA#', polar: ':AP#', land: ':AL#'};
    await this.cmdSilent(map[mode]);
  }

  async startAlign(kind: 'easy' | 'one' | 'two') {
    const map = {easy: ':Aa#', one: ':Ab#', two: ':Ac#'};
    await this.cmdSilent(map[kind]);
  }

  async focusStart(inward: boolean) {
    await this.cmdSilent(inward ? ':F-#' : ':F+#');
  }
  async focusStop() {
    await this.cmdSilent(':FQ#');
  }

  /** Vitesse du moteur de mise au point (panneau ASU « Focus Speed ») :
   *  commandes LX200 classiques :FS#/:FM#/:FF# — silencieuses : une raquette
   *  qui ne les connaît pas les ignore sans erreur. */
  async setFocusSpeed(s: 'slow' | 'medium' | 'fast') {
    await this.cmdSilent(s === 'fast' ? ':FF#' : s === 'medium' ? ':FM#' : ':FS#');
  }

  /** Réticule illuminé du LX200 classique : luminosité ± (:B+ / :B-). */
  async reticleAdjust(delta: 1 | -1) {
    await this.cmdSilent(delta > 0 ? ':B+#' : ':B-#');
  }

  async park() {
    await this.cmdSilent(':hP#');
  }

  /* ---------- polling position (synchro temps réel) ---------- */

  /** Cadence du polling : 500 ms (synchro live) ou 2000 ms (fond). */
  setPollInterval(ms: number) {
    this.pollIntervalMs = ms;
    if (this.pollTimer !== null) this.startPoll(); // redémarre à la nouvelle cadence
  }

  /** Active/désactive la lecture alt/az en direct (:Ga/:Gz, 1 fois sur 4). */
  setPollAltAz(on: boolean) {
    this.pollAltAzOn = on;
    this.pollTick = 0;
  }

  private startPoll() {
    this.stopPoll();
    this.pollTimer = setInterval(async () => {
      // si le cycle précédent n'est pas terminé (raquette lente/muette), on
      // saute ce tick : aucune commande ne s'empile dans la file série
      if (this.pollBusy || !this.isConnected()) return;
      // priorité aux commandes utilisateur : on laisse la main un instant
      if (Date.now() < this.priorityUntil) return;
      this.pollBusy = true;
      try {
        const s0 = useScopeStore.getState();
        const live = s0.hbSync === 'live';
        // MIROIR LCD (v1.8.1) : :ED# à chaque tick en synchro live — le
        // littéral de l'écran de la raquette physique prime sur toute
        // reconstruction. Repli : si la raquette ne connaît pas :ED#
        // (6 échecs de suite), l'écran télémétrie reprend la main.
        if (live) {
          const lcd = await this.getLcd();
          if (lcd) {
            this.lcdFail = 0;
            this.failCount = 0; // la liaison vit : pas de diagnostic « muette »
            s0.setLcdMirror(lcd.line1, lcd.line2);
            if (!this.lcdLogged) {
              this.lcdLogged = true;
              s0.pushLog('info', 'Miroir LCD actif (:ED#) — écran de la raquette physique relu en continu');
            }
          } else {
            this.lcdFail += 1;
            if (this.lcdFail === 6) {
              s0.clearLcdMirror();
              s0.pushLog('info', 'Raquette sans :ED# — miroir par télémétrie (position/alt-az)');
            }
          }
          // position 1 tick sur 2 : la ligne série reste dévolue en partie au
          // miroir LCD (2 Hz, cadence de rafraîchissement du LCD matériel)
          if (this.pollTick % 2 === 1) {
            this.pollTick += 1;
            this.applyHint(s0, Date.now());
            return;
          }
        }
        const {raDeg, decDeg} = await this.readPosition();
        const s = useScopeStore.getState();
        const now = Date.now();
        if (raDeg === null && decDeg === null) {
          // les 2 axes muets ce cycle — pendant un moteur c'est normal
          // (beaucoup de raquettes cessent de répondre au port série).
          // REPLI ALT/AZ (v1.8.0) : des raquettes répondent :Ga#/:Gz# même
          // quand :Gr#/:Gd# tardent — le miroir continue via l'horizontale
          // (mouvement physique → croix allumée, slew rapide, écran ALT/AZ).
          let altAzHandled = false;
          if (this.pollAltAzOn) {
            altAzHandled = await this.readAltAzAndDetect(s, now);
          }
          if (!altAzHandled) {
            const busy = this.lastMovedFlag || this.holding.size > 0 ||
              now - this.lastExternalAt < 3000;
            if (!busy) this.failCount += 1;
            this.applyHint(s, now);
          }
        } else {
          this.failCount = 0;
          this.lastPosAt = now;
          // RA ou DEC lu mais pas l'autre : on conserve le dernier connu
          const newRa = raDeg ?? this.lastRaDeg ?? 0;
          const newDec = decDeg ?? this.lastDecDeg ?? 0;
          // 00:00:00 / +00*00 = raquette non initialisée (alignement non
          // terminé) : JAMAIS affiché comme une position — c'est l'état de
          // repos de toutes les raquettes Meade avant alignement.
          const init = newRa === 0 && newDec === 0;
          // détection de mouvement : uniquement quand les 2 axes sont lus
          // CE cycle (sinon un axe périmé fausserait les deltas). Seuil
          // ADAPTATIF : au-dessus du suivi sidéral (15"/s × marge), donc
          // proportionnel au temps écoulé entre 2 lectures.
          let moved = false;
          if (raDeg !== null && decDeg !== null && this.lastRaDeg !== null &&
              this.lastDecDeg !== null) {
            const el = Math.min(Math.max((now - this.lastPosAt) / 1000, 0.3), 6);
            const th = Math.max(0.0028, el * 0.0076); // ~10" … 27"/s écoulés
            moved = Math.abs(newRa - (this.lastRaDeg as number)) +
              Math.abs(newDec - (this.lastDecDeg as number)) > th;
          }
          const appOwned = this.holding.size > 0 || now < this.ownMoveUntil;
          // hors de la fenêtre « l'app vient d'ordonner un mouvement », tout
          // déplacement constaté VIENT DE LA RAQUETTE PHYSIQUE → croix
          // allumée + directions déduites des deltas AD/DEC
          const external = moved && !appOwned &&
            this.lastRaDeg !== null && this.lastDecDeg !== null;
          let dirs: {n: boolean; s: boolean; e: boolean; w: boolean} | null = null;
          if (external) {
            let dRa = newRa - (this.lastRaDeg as number);
            if (dRa > 180) dRa -= 360; else if (dRa < -180) dRa += 360; // raccord 0h
            const dDec = newDec - (this.lastDecDeg as number);
            const th = 0.0014; // ~5"
            dirs = {n: dDec > th, s: dDec < -th, e: dRa > th, w: dRa < -th};
            if (!dirs.n && !dirs.s && !dirs.e && !dirs.w) dirs = null;
            this.lastExternalAt = now;
            // Slew RAPIDE (= GOTO ou flèche haute vitesse sur le matériel) :
            // taux > 1°/s — au-dessus de Center (~0,5°/s), en-dessous du Find
            // (2°/s)… le LCD du matériel affiche « Slewing... », le miroir
            // aussi. Le drapeau tient 1,2 s pour survivre aux cycles où les
            // axes deviennent muets pendant le moteur.
            const elSec = Math.min(Math.max((now - this.prevPosAt) / 1000, 0.2), 6);
            if ((Math.abs(dRa) + Math.abs(dDec)) / elSec > 1.0) {
              this.slewFastUntil = now + 1200;
            }
          }
          // « Slewing... » sur le LCD miroir (toutes les positions lues)
          s.setHbSlewFast(now < this.slewFastUntil);
          this.prevPosAt = now;
          if (init) {
            // pas de position : l'écran miroir reste en « attente », le
            // diagnostic explique l'initialisation (la LIAISON, elle, marche)
            s.setHbHint('init');
            s.setHasPos(false);
          } else {
            s.setPosition(newRa, newDec);
            s.setHbHint('none');
            if (this.muteLogged) {
              this.muteLogged = false;
              s.pushLog('info', 'Synchro : position de nouveau lue — miroir rétabli');
            }
          }
          s.setHbMoving(moved);
          s.setHbExternal(external);
          s.setHbDirs(dirs);
          this.lastMovedFlag = moved;
          this.lastRaDeg = init ? this.lastRaDeg : newRa;
          this.lastDecDeg = init ? this.lastDecDeg : newDec;
          this.pollTick += 1;
          if (this.pollAltAzOn && this.pollTick % 4 === 0) {
            this.pollAltAz().catch(() => undefined); // tolérant : modèles sans :Ga
          }
        }
      } catch {
        const s = useScopeStore.getState();
        this.applyHint(s, Date.now());
      } finally {
        this.pollBusy = false;
      }
    }, this.pollIntervalMs) as unknown as number;
  }

  /** Diagnostic continu quand la position ne vient pas : 'wait' (bref),
   *  puis 'mute' après ~6 s — la synchro RESTE LIVE, aucune retombée en
   *  erreur : la sonde :GVP# distingue raquette muette sur la position
   *  (monture non reliée/hors tension, raquette pas initialisée) et liaison
   *  morte. La moindre position valide rétablit le miroir instantanément.
   *  EXCEPTION (v1.8.0) : si l'alt/az est lu en continu, la liaison vit et
   *  le miroir est alimenté par l'horizontale — aucun diagnostic d'attente. */
  private applyHint(s: ReturnType<typeof useScopeStore.getState>, now: number) {
    // miroir LCD frais : la liaison vit et l'écran réel est affiché —
    // aucun diagnostic (la position AD/DEC absente n'a plus d'importance)
    if (this.lcdFail === 0 && s.lcdAt > 0 && now - s.lcdAt < LCD_STALE_MS) {
      s.setHbHint('none');
      return;
    }
    if (this.lastAltAzAt && now - this.lastAltAzAt < 4000) {
      s.setHbHint('none');
      return;
    }
    if (!this.lastPosAt) {
      s.setHbHint('wait'); // première position pas encore lue : bref et normal
      return;
    }
    if (now - this.lastPosAt < 6000) return; // tolérance courte, pas d'alerte
    if (s.hbHint !== 'mute') {
      s.setHbHint('mute');
      if (!this.muteLogged) {
        this.muteLogged = true;
        s.pushLog('info', 'Synchro LIVE maintenue : la raquette ne renvoie plus de position AD/DEC — sonde :GVP# en cours');
      }
    }
    // sonde de liaison toutes les 10 s max (hors mouvement)
    const busy = this.lastMovedFlag || this.holding.size > 0 ||
      now - this.lastExternalAt < 3000;
    if (!busy && now - this.lastProbeAt > 10000) {
      this.lastProbeAt = now;
      this.cmd(':GVP#', 2500)
        .then((p) => {
          if (p && p !== '?') {
            useScopeStore.getState().pushLog('info',
              'Sonde : liaison active, raquette muette sur la position (monture reliée/sous tension ? raquette initialisée ?)');
          }
        })
        .catch(() => {
          useScopeStore.getState().pushLog('info', 'Sonde : la raquette ne répond plus du tout (liaison interrompue ?)');
        });
    }
  }

  /** Lecture alt/az + détection de mouvement (repli quand AD/DEC est muet).
   *  Renvoie true si les 2 axes ont été lus ce cycle : la synchro est alors
   *  alimentée par l'horizontale (croix, slew rapide) et reste sans diagnostic.
   *  Les deltas alt/az suivent les mêmes seuils que AD/DEC (ce sont des degrés). */
  private async readAltAzAndDetect(s: ReturnType<typeof useScopeStore.getState>, now: number): Promise<boolean> {
    const aa = await this.pollAltAz();
    if (!aa) return false;
    const {altDeg, azDeg} = aa;
    this.failCount = 0;
    const havePrev = this.lastAltDeg !== null && this.lastAzDeg !== null && this.lastAltAzAt > 0;
    if (havePrev) {
      const el = Math.min(Math.max((now - this.lastAltAzAt) / 1000, 0.3), 6);
      const th = Math.max(0.0028, el * 0.0076); // ~10" … au-dessus du suivi sidéral
      let dAz = azDeg - (this.lastAzDeg as number);
      if (dAz > 180) dAz -= 360; else if (dAz < -180) dAz += 360; // raccord nord
      const dAlt = altDeg - (this.lastAltDeg as number);
      const moved = Math.abs(dAz) + Math.abs(dAlt) > th;
      const appOwned = this.holding.size > 0 || now < this.ownMoveUntil;
      const external = moved && !appOwned;
      let dirs: {n: boolean; s: boolean; e: boolean; w: boolean} | null = null;
      if (external) {
        const thD = 0.0014; // ~5"
        dirs = {n: dAlt > thD, s: dAlt < -thD, e: dAz > thD, w: dAz < -thD};
        if (!dirs.n && !dirs.s && !dirs.e && !dirs.w) dirs = null;
        this.lastExternalAt = now;
        // Slew rapide constaté par l'horizontale (= GOTO ou flèche rapide)
        if ((Math.abs(dAz) + Math.abs(dAlt)) / el > 1.0) {
          this.slewFastUntil = now + 1200;
        }
      }
      s.setHbMoving(moved);
      s.setHbExternal(external);
      s.setHbDirs(dirs);
      s.setHbSlewFast(now < this.slewFastUntil);
    }
    this.lastAltDeg = altDeg;
    this.lastAzDeg = azDeg;
    this.lastAltAzAt = now;
    s.setHbHint('none');
    return true;
  }

  private async pollAltAz(): Promise<{altDeg: number; azDeg: number} | null> {
    const [alt, az] = await Promise.all([
      this.cmd(':Ga#', 2500, VALID.dec).catch(() => ''),
      this.cmd(':Gz#', 2500, VALID.dec).catch(() => ''),
    ]);
    const altDeg = parseDec(alt.trim().match(/^[+-]/) ? alt : `+${alt}`);
    const azDeg = parseDec(az.trim().match(/^[+-]/) ? az : `+${az}`);
    if (altDeg !== null && azDeg !== null) {
      useScopeStore.getState().setAltAz(altDeg, azDeg);
      return {altDeg, azDeg};
    }
    return null;
  }

  private stopPoll() {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Instance unique partagée. */
export const autostar = new AutostarClient();

// import en fin de fichier pour éviter la dépendance circulaire
import {handboxSync} from './handboxSync';
