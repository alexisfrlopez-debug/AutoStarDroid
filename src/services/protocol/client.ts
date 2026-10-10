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
import {PROFILES, SPEED_CMDS} from './profiles';
import {proto} from '../astro/time';
import type {ScopeModelId} from '../../store/settingsStore';
import {useScopeStore} from '../../store/scopeStore';

export type Dir = 'n' | 's' | 'e' | 'w';
export type Speed = keyof typeof SPEED_CMDS;

export interface RaDec {raDeg: number; decDeg: number}

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
const DEC_RE = /^([+-])(\d{1,3})\D(\d{1,2})/;

function parseDec(s: string): number | null {
  const m = s.match(DEC_RE);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (+m[2] + +m[3] / 60);
}

function parseRa(s: string): number | null {
  const m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return (+m[1] + +m[2] / 60 + +m[3] / 3600) * 15;
}

export class AutostarClient {
  private transport: Transport | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private buffer = '';
  private pending: {cmd: string; resolve: (s: string) => void; reject: (e: Error) => void; timer: number} | null = null;
  private pollTimer: number | null = null;
  private pollIntervalMs = 1200;
  private pollAltAzOn = false;
  private pollTick = 0;
  private pollBusy = false;
  private failCount = 0;
  private lastRaDeg: number | null = null;
  private lastDecDeg: number | null = null;
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
    transport.onClosed(() => {
      this.stopPoll();
      const s = useScopeStore.getState();
      s.setConnStatus('disconnected');
      s.setFirmware(null, null, null);
      s.pushLog('info', 'Liaison fermée');
      handboxSync.reset();
    });
    try {
      await transport.connect(opts);
    } catch (e) {
      store.setConnStatus('error');
      store.pushLog('error', `Connexion échouée : ${(e as Error).message}`);
      throw e;
    }
    this.transport = transport;
    const profile = PROFILES[model];
    if (profile.wake && transport.type !== 'demo') {
      // ESC ESC : bascule les Autostar #49x en mode PC série
      try {await transport.write('\x1b\x1b'); await sleep(300);} catch (_) {}
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
   * Lit :GVP#/:GVN# puis sélectionne le mappage de clavier adapté au
   * firmware détecté (voir keymaps.ts). Silencieux : une raquette muette
   * ne doit jamais empêcher l'utilisation de l'app.
   */
  private async detectFirmware() {
    try {
      const {product, version} = await this.getFirmware();
      const model = matchFirmware(product, version);
      const s = useScopeStore.getState();
      s.setFirmware(product, version, model);
      s.pushLog('info', model
        ? `Firmware détecté : ${product} ${version} → clavier ${model} auto`
        : `Firmware : ${product} ${version} — non reconnu, modèle Réglages conservé`);
    } catch {
      useScopeStore.getState().pushLog('info', 'Firmware illisible — modèle Réglages conservé');
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
    const s = useScopeStore.getState();
    s.setConnStatus('disconnected');
    s.setTransportType(null);
    s.setFirmware(null, null, null);
  }

  /* ---------- couche basse ---------- */

  private onData(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-2048);
    const p = this.pending;
    if (p) {
      // gestion d'écho : la raquette peut renvoyer la commande telle quelle
      let buf = this.buffer;
      if (buf.startsWith(p.cmd)) buf = buf.slice(p.cmd.length);
      const i = buf.indexOf('#');
      if (i >= 0) {
        const reply = buf.slice(0, i);
        this.buffer = buf.slice(i + 1);
        clearTimeout(p.timer);
        this.pending = null;
        if (reply.length) this.log('recv', reply);
        p.resolve(reply);
      }
    }
  }

  /** Envoie une commande et attend une réponse '#'-terminée. */
  cmd(command: string, timeoutMs = 3000): Promise<string> {
    if (!this.transport) return Promise.reject(new TransportError('Non connecté'));
    const run = () =>
      new Promise<string>((resolve, reject) => {
        if (!this.transport) return reject(new TransportError('Non connecté'));
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new TransportError(`Délai dépassé : ${command}`));
        }, timeoutMs) as unknown as number;
        this.pending = {cmd: command, resolve, reject, timer};
        this.buffer = '';
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

  /** Commande sans réponse attendue (mouvements…). */
  async cmdSilent(command: string): Promise<void> {
    if (!this.transport) throw new TransportError('Non connecté');
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
    const [ra, dec] = await Promise.all([this.cmd(':Gr#', timeoutMs), this.cmd(':Gd#', timeoutMs)]);
    const raDeg = parseRa(ra);
    const decDeg = parseDec(dec);
    if (raDeg === null || decDeg === null) throw new TransportError('Réponse position illisible');
    return {raDeg, decDeg};
  }

  async getFirmware(): Promise<{product: string; version: string}> {
    const product = await this.cmd(':GVP#').catch(() => '?');
    const version = await this.cmd(':GVN#').catch(() => '?');
    return {product, version};
  }

  async setSpeed(speed: Speed) {
    await this.cmdSilent(SPEED_CMDS[speed]);
  }

  async startMove(dir: Dir) {
    const map: Record<Dir, string> = {n: ':Mn#', s: ':Ms#', e: ':Me#', w: ':Mw#'};
    await this.cmdSilent(map[dir]);
  }

  async stopMove(dir: Dir) {
    const map: Record<Dir, string> = {n: ':Qn#', s: ':Qs#', e: ':Qe#', w: ':Qw#'};
    await this.cmdSilent(map[dir]);
  }

  async stopAll() {
    await this.cmdSilent(':Q#');
  }

  /** GOTO vers RA/Dec. Renvoie 'ok' ou un message d'erreur localisé. */
  async gotoRaDec(raDeg: number, decDeg: number): Promise<'ok' | 'belowHorizon' | 'noObject' | 'refused'> {
    const r1 = await this.cmd(`:Sr${proto.raCmd(raDeg)}#`);
    const r2 = await this.cmd(`:Sd${proto.decCmd(decDeg)}#`);
    if (r1 !== '1' || r2 !== '1') return 'refused';
    const ms = await this.cmd(':MS#', 5000);
    if (ms === '0') return 'ok';
    if (ms === '1') return 'belowHorizon';
    return 'noObject';
  }

  async syncHere(): Promise<void> {
    await this.cmdSilent(':CM#');
  }

  /** Lecture date/heure/site de la raquette. */
  async readScopeData(): Promise<{
    time: string; date: string; tz: string; latDeg: number | null; lonDeg: number | null;
  }> {
    const [time, date, tz, lat, lon] = await Promise.all([
      this.cmd(':GL#'), this.cmd(':GC#'), this.cmd(':GG#'),
      this.cmd(':Gt#').catch(() => ''), this.cmd(':Gg#').catch(() => ''),
    ]);
    return {time, date, tz, latDeg: parseDec(lat), lonDeg: parseDec(lon)};
  }

  /** Envoie date/heure/site du téléphone vers la raquette. */
  async pushPhoneData(latDeg: number, lonDeg: number): Promise<void> {
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
    await this.cmdSilent(`:SG${tzOffsetMin >= 0 ? '+' : '-'}${tzVal}#`);
    await sleep(120);
    await this.cmdSilent(`:SL${hh}:${mm}:${ss}#`);
    await sleep(120);
    await this.cmdSilent(`:SC${mo}/${dd}/${yy}#`);
    await sleep(400);
    await this.cmdSilent(`:St${proto.decCmd(latDeg)}#`);
    await sleep(120);
    const lonMeade = lonDeg < 0 ? 360 + lonDeg : lonDeg;
    await this.cmdSilent(`:Sg${proto.decCmd(lonMeade)}#`);
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
      this.pollBusy = true;
      try {
        const {raDeg, decDeg} = await this.getRaDec(1200);
        this.failCount = 0;
        const s = useScopeStore.getState();
        // détection de mouvement : la position physique a bougé depuis le
        // dernier cycle (seuil ~10" entre 2 lectures)
        const moved = this.lastRaDeg !== null && this.lastDecDeg !== null &&
          (Math.abs(raDeg - this.lastRaDeg) + Math.abs(decDeg - this.lastDecDeg)) > 0.0028;
        s.setPosition(raDeg, decDeg);
        s.setHbMoving(moved);
        this.lastRaDeg = raDeg;
        this.lastDecDeg = decDeg;
        this.pollTick += 1;
        if (this.pollAltAzOn && this.pollTick % 4 === 0) {
          this.pollAltAz().catch(() => undefined); // tolérant : modèles sans :Ga
        }
      } catch (e) {
        this.failCount += 1;
        if (this.failCount >= 3) {
          this.failCount = 0;
          const s = useScopeStore.getState();
          if (s.hbSync === 'live') {
            // la raquette ne répond plus : synchro en erreur, retour au fond lent
            s.setHbSync('error');
            s.setHbError((e as Error).message);
            s.setHbMoving(false);
            this.setPollInterval(2000);
            this.setPollAltAz(false);
            s.pushLog('error', `Synchro temps réel interrompue : ${(e as Error).message}`);
          }
        }
      } finally {
        this.pollBusy = false;
      }
    }, this.pollIntervalMs) as unknown as number;
  }

  private async pollAltAz() {
    const [alt, az] = await Promise.all([
      this.cmd(':Ga#', 1500).catch(() => ''),
      this.cmd(':Gz#', 1500).catch(() => ''),
    ]);
    const altDeg = parseDec(alt.trim().match(/^[+-]/) ? alt : `+${alt}`);
    const azDeg = parseDec(az.trim().match(/^[+-]/) ? az : `+${az}`);
    if (altDeg !== null && azDeg !== null) {
      useScopeStore.getState().setAltAz(altDeg, azDeg);
    }
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
