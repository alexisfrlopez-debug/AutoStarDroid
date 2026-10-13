/**
 * ScopeClient (nom historique : AutostarClient) — moteur de protocole.
 * File d'attente sérielle, gestion d'écho, délais, API haut niveau.
 * v2.6.0 : le CODE protocole est délégué à un TelescopeDriver (Meade,
 * Celestron NexStar, Sky-Watcher SynScan, iOptron) — le client reste
 * propriétaire de la liaison, du polling, de la reconnexion et du relais.
 */
import type {ConnectOptions, Transport, TransportType} from '../connection/types';
import {TransportError} from '../connection/types';
import {TcpTransport} from '../connection/tcp';
import {BluetoothTransport} from '../connection/bluetooth';
import {UsbTransport, UsbSerialNative} from '../connection/usb';
import {DemoTransport, setDemoSite} from '../connection/demo';
import {
  DRIVERS, getDriver,
  type DriverClient, type DriverId, type DriverPref, type TelescopeDriver,
} from './driver';
import './drivers'; // enregistre les 4 protocoles (import à effet de bord)
import type {ScopeModelId} from '../../store/settingsStore';
import {useSettingsStore} from '../../store/settingsStore';
import {useScopeStore} from '../../store/scopeStore';
import {useMotorCalibStore} from '../../store/motorCalibStore';
import {useTelemetryStore} from '../../store/telemetryStore';
import {
  raDeltaDeg, relayDecision, relaySignWasWrong, relayAltBlocked, relayLearnRate,
  RELAY_ALT_MARGIN_DEG,
  type RelayRates, type RelaySigns, type RelaySpeed,
} from '../astro/gotorelay';
import {DEFAULT_SKY_RATES} from '../astro/tracking';
import {raDecToAltAz, altAzToRaDec} from '../astro/coords';
import {homeGeometry} from '../astro/telemetry';
import {activePreset} from '../mounts/catalog';
import {sleep} from '../util';

/* API publique déplacée dans driver.ts (alias ré-exportés pour compat) : */
export {gotoErrorText} from './driver';
export {parseLcdReply} from './drivers/meade';
export type Dir = import('./driver').Dir;
export type Speed = import('./driver').Speed;
export type RaDec = import('./driver').RaDec;
export type GotoStatus = import('./driver').GotoStatus;
export type GotoErrorTexts = import('./driver').GotoErrorTexts;

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

// Longitudes Meade et parsing du format → déplacés dans driver.ts
// (parseMeadeRa / parseMeadeDec / VALID — partagés Meade + iOptron).

export class AutostarClient implements DriverClient {
  private transport: Transport | null = null;
  /** Driver de protocole actif (résolu à la connexion — Meade par défaut
   *  hors connexion : l'UI peut lire drv.caps pour adapter les écrans). */
  drv: TelescopeDriver = DRIVERS.meade ?? getDriver('meade');
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
  /** Phase de COMMANDES CRITIQUES en cours (séquence :Sr/:Sd/:MS d'un GOTO,
   *  SYNC…) : le polling est suspendu pendant ce temps pour laisser la
   *  ligne série À LA SÉQUENCE — les raquettes #49x ont un tampon UART
   *  minuscule et beaucoup deviennent muettes pendant un moteur : chaque
   *  :ED#/:Gr# intercalé ajoute des délais d'expiration qui font échouer le
   *  GOTO lancé depuis l'app (alors qu'un GOTO déclenché sur la raquette
   *  physique, sans trafic concurrent, passe). (v2.1.1) */
  private cmdPhase = false;
  /** Dernière connexion USB réussie — pour la RECONNEXION AUTOMATIQUE quand
   *  l'adaptateur est détaché puis re-énuméré (glitch de bus pendant un
   *  slew GOTO : appel de courant moteur). (v2.1.1) */
  private lastUsb: {
    opts: ConnectOptions; model: ScopeModelId;
    vid: number | null; pid: number | null;
  } | null = null;
  private usbReconnectTimer: number | null = null;
  private usbReconnectTries = 0;
  /** Dernière connexion Bluetooth réussie — reconnexion automatique (v2.1.2).
   *  L'adresse BT est IMMUTABLE : le module côté télescope (HC-05, cordon
   *  Meade BT) qui brown-out pendant un slew retrouve la liaison sans
   *  ré-appairage — il suffit de réouvrir le socket. */
  private lastBt: {opts: ConnectOptions; model: ScopeModelId} | null = null;
  private btReconnectTimer: number | null = null;
  private btReconnectTries = 0;
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
  /** Journal partagé (public : partie du contrat DriverClient — les drivers
   *  journalisent leurs refus/diagnostics dans la console de l'app). */
  log = (dir: 'sent' | 'recv' | 'info' | 'error', text: string) =>
    useScopeStore.getState().pushLog(dir, text);
  /** Avertissement utilisateur — chemin INDÉPENDANT de log() (les tests
   *  silencient le trafic série sans perdre les avertissements). */
  warn = (text: string) => useScopeStore.getState().pushLog('warn', text);

  isConnected() {return this.transport?.isConnected() ?? false;}
  getTransportType(): TransportType | null {return this.transport?.type ?? null;}

  /* ---------- implémentation DriverClient (callbacks des drivers) ---------- */

  transportAlive(): boolean {return this.transport?.isConnected() ?? false;}
  /** Reset du parseur côté raquette (ESC ESC — utile aux raquettes Meade). */
  async resetParser(): Promise<void> {
    try {await this.transport?.write('\x1b\x1b'); await sleep(350);} catch (_) {}
  }

  async connect(type: TransportType, opts: ConnectOptions, model: ScopeModelId, prefDriver: DriverPref = 'auto'): Promise<void> {
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
    this.directGotoDead = false; // nouvelle liaison : le chemin natif reprend son droit
    if (type === 'usb') {
      // Mémorise l'identité du périphérique (VID/PID) pour la reconnexion
      // automatique : un glitch de bus re-énumère l'adaptateur SOUS UN AUTRE
      // deviceName — seule l'identité VID/PID permet de le retrouver.
      const want = opts.usb;
      const devs = await UsbSerialNative.listDevices().catch(() => []);
      const info = want
        ? devs.find((d) => d.deviceName === want.deviceName) ??
          // reconnexion v2.1.2 : opts peut porter l'identité matérielle
          // trouvée lors de la précédente re-énumération
          (want.vendorId != null && want.productId != null
            ? devs.find((d) => d.vendorId === want.vendorId && d.productId === want.productId)
            : undefined)
        : undefined;
      this.lastUsb = {opts, model, vid: info?.vendorId ?? null, pid: info?.productId ?? null};
      this.lastBt = null;
    } else if (type === 'bluetooth') {
      this.lastBt = {opts, model};
      this.lastUsb = null;
    } else {
      this.lastUsb = null;
      this.lastBt = null;
    }
    if (transport.type !== 'demo') {
      // ESC ESC SYSTÉMATIQUE (sauf démo) : bascule les Autostar #49x en mode
      // PC série. Le besoin dépend du MATÉRIEL réel, pas du modèle choisi —
      // l'envoyer quel que soit le modèle garantit qu'un #497 répond même si
      // la présélection était mauvaise (les autres protocoles ignorent ces
      // octets). Sans cela, un #497 réveillé en dernier restait muet : c'est
      // le volet « liaison » du miroir qui ne démarrait jamais.
      try {await transport.write('\x1b\x1b'); await sleep(500);} catch (_) {}
      this.log('info', 'Séquence d\'éveil ESC ESC envoyée (mode PC série Autostar)');
    }
    // RÉSOLUTION DU PROTOCOLE (v2.6.0) : préférence explicite = immédiat,
    // 'auto' = sondes de détection (Meade, NexStar, iOptron). La démo est
    // un Autostar II simulé : driver Meade imposé.
    this.drv = transport.type === 'demo' ? getDriver('meade') : await this.resolveDriver(prefDriver);
    useScopeStore.getState().setDriverId(this.drv.id);
    this.log('info', `Protocole : ${this.drv.label} (${this.drv.id})`);
    useScopeStore.getState().setConnStatus('connected');
    useScopeStore.getState().setTransportType(transport.type);
    useScopeStore.getState().setModel(model);
    this.log('info', `Connecté (${transport.type}, modèle ${model})`);
    if (transport.type === 'demo') setDemoSite(0, 0); // site ajusté par les écrans
    this.startPoll();
    if (this.drv.caps.lcdMirror) handboxSync.enable(); // synchro LCD (Meade seulement)
    else handboxSync.reset();
    this.detectFirmware(); // identification matérielle — asynchrone, non bloquant
    this.autoSyncScopeData(); // date/heure/site du téléphone → raquette (v2.1.2)
  }

  /**
   * Résolution du protocole (v2.6.0). Préférence explicite → driver immédiat
   * (chemin rapide, aucune sonde). 'auto' → sondes de détection dans l'ordre
   * Meade (:GVP#), NexStar ('V'), iOptron (:MountInfo#) : chaque sonde teste
   * le CONTENU de la réponse (un '?' Meade ou un chiffre isolé ne suffit
   * pas) — la première classification gagne, à défaut Meade/LX200 est
   * supposé (compatibilité la plus large, toutes commandes utiles).
   */
  async resolveDriver(pref: DriverPref): Promise<TelescopeDriver> {
    if (pref !== 'auto' && DRIVERS[pref]) return DRIVERS[pref];
    for (const id of ['meade', 'celestron', 'ioptron'] as DriverId[]) {
      const drv = DRIVERS[id];
      const p = drv.probe;
      if (!p) continue;
      try {
        const reply = await this.cmd(p.cmd, p.timeoutMs, p.expect);
        if (p.classify(reply)) {
          this.log('info', `Protocole détecté (${p.cmd} → « ${reply.trim().slice(0, 24)} »)`);
          return drv;
        }
      } catch (_) { /* muet sur cette sonde : sonde suivante */ }
    }
    this.log('info', 'Protocole non identifié — Meade/LX200 supposé (choisir la marque dans l\'onglet Connexion si besoin)');
    return getDriver('meade');
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
      const {product, version} = await this.drv.firmware(this);
      // matchFirmware ne s'applique qu'aux noms d'usine Meade
      const model = this.drv.id === 'meade' ? matchFirmware(product, version) : null;
      const s = useScopeStore.getState();
      s.setFirmware(product, version, model);
      if (this.drv.id === 'celestron' || this.drv.id === 'skywatcher') {
        // mode d'axes des flèches déduit du tracking réel ('t')
        const drv = this.drv as import('./drivers/nexstar').NexStarDriver;
        await drv.refreshAxisMode(this).catch(() => undefined);
      }
      if (model) {
        // Configuration optimale : le modèle détecté est appliqué à toute
        // l'app (capacités, menus, clavier) et sélectionné dans l'onglet
        // Connexion à la place du choix de secours.
        useSettingsStore.getState().setModel(model);
        s.setModel(model);
        s.pushLog('info', `Firmware détecté : ${product} ${version} → configuration ${model} appliquée`);
      } else {
        s.pushLog('info', `Firmware : ${product} ${version} — ${this.drv.id === 'meade' ? "non reconnu, modèle de l'onglet Connexion conservé" : `protocole ${this.drv.label}`}`);
      }
    } catch {
      useScopeStore.getState().pushLog('info', 'Firmware illisible — modèle de l\'onglet Connexion conservé');
    }
  }

  async disconnect(): Promise<void> {
    this.cancelUsbReconnect(); // déconnexion manuelle : pas de reconnexion auto
    this.cancelBtReconnect();
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
    this.drv = getDriver('meade'); // driver par défaut hors connexion
    const s = useScopeStore.getState();
    s.setConnStatus('disconnected');
    s.setTransportType(null);
    s.setDriverId(null);
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
    // USB ou BT déjà mémorisés → la reconnexion est AUTOMATIQUE : le message
    // ne doit pas demander à l'utilisateur ce que l'app va faire toute seule.
    if (this.lastUsb) {
      s.pushLog('error', 'Liaison perdue — reconnexion automatique USB en cours…');
    } else if (this.lastBt) {
      s.pushLog('error', 'Liaison Bluetooth perdue — reconnexion automatique en cours…');
    } else {
      s.pushLog('error', 'Liaison perdue — reconnectez la raquette');
    }
    handboxSync.reset();
    // USB : le câble peut avoir « sauté » pour un glitch de bus (slew GOTO)
    // et être déjà re-énuméré — on tente de le retrouver tout seul. (v2.1.1)
    // BT : le module du télescope peut avoir brown-outé — même mécanique. (v2.1.2)
    this.scheduleReconnect();
  }

  /* ---------- reconnexion USB / Bluetooth automatique (v2.1.1 / v2.1.2) ---------- */

  /** Programme un essai de reconnexion (premier essai après 2,5 s — laisse
   *  le temps à une re-énumération USB ou à un redémarrage de module BT). */
  private scheduleReconnect() {
    if (this.lastUsb) this.scheduleUsbReconnect();
    else if (this.lastBt) this.scheduleBtReconnect();
  }

  private scheduleUsbReconnect() {
    if (!this.lastUsb) return; // jamais connecté en USB : rien à retenter
    if (this.usbReconnectTimer !== null) return; // déjà programmé
    this.usbReconnectTimer = setTimeout(() => {
      this.usbReconnectTimer = null;
      this.tryUsbReconnect().catch(() => undefined);
    }, 2500) as unknown as number;
  }

  /** Programme un essai de reconnexion Bluetooth (4 essais espacés de 3 s —
   *  un module HC-05 qui brown-out met 2 à 5 s à re-redémarrer). */
  private scheduleBtReconnect() {
    if (!this.lastBt) return;
    if (this.btReconnectTimer !== null) return; // déjà programmé
    this.btReconnectTimer = setTimeout(() => {
      this.btReconnectTimer = null;
      this.tryBtReconnect().catch(() => undefined);
    }, 3000) as unknown as number;
  }

  private cancelUsbReconnect() {
    if (this.usbReconnectTimer !== null) {
      clearTimeout(this.usbReconnectTimer);
      this.usbReconnectTimer = null;
    }
    this.usbReconnectTries = 0;
  }

  private cancelBtReconnect() {
    if (this.btReconnectTimer !== null) {
      clearTimeout(this.btReconnectTimer);
      this.btReconnectTimer = null;
    }
    this.btReconnectTries = 0;
  }

  /** Tente de retrouver l'adaptateur USB (par VID/PID d'abord — le
   *  deviceName change après une re-énumération — puis par nom) et
   *  rétablit la liaison sans action utilisateur. 4 essais espacés.
   *  CORRECTIF v2.1.2 (cause racine « GOTO → connexion perdue ») : la
   *  reconnexion réouvrait l'ANCIEN deviceName alors que la re-énumération
   *  en a généré un NOUVEAU (le numéro de périphérique USB change) —
   *  l'ouverture échouait systématiquement (« Périphérique non trouvé »)
   *  et la connexion semblait définitivement perdue. Désormais l'identité
   *  matérielle retrouvée (VID/PID) fournit le deviceName COURANT, passé
   *  à connect() dans des options clonées. */
  private async tryUsbReconnect(): Promise<void> {
    const last = this.lastUsb;
    if (!last) return;
    const s = useScopeStore.getState();
    if (s.connStatus === 'connected' || s.connStatus === 'connecting') return; // déjà rétabli (manuel ?)
    if (this.usbReconnectTries >= 4) {
      s.pushLog('info', 'USB : reconnexion automatique abandonnée — reconnectez dans l\'onglet Connexion');
      return;
    }
    this.usbReconnectTries += 1;
    const devs = await UsbSerialNative.listDevices().catch(() => []);
    const dev = devs.find((d) => last.vid !== null && last.pid !== null &&
        d.vendorId === last.vid && d.productId === last.pid) ??
      devs.find((d) => d.deviceName === last.opts.usb?.deviceName);
    if (!dev) {
      s.pushLog('info', `USB : adaptateur introuvable (essai ${this.usbReconnectTries}/4) — nouvelle tentative…`);
      this.scheduleUsbReconnect();
      return;
    }
    s.pushLog('info', 'USB : adaptateur retrouvé — reconnexion automatique…');
    // permission : sans effet (et sans boîte de dialogue) si déjà accordée
    await UsbSerialNative.requestPermission(dev.deviceName).catch(() => false);
    // options clonées : deviceName COURANT de l'adaptateur retrouvé + son
    // identité matérielle (conservée pour une future re-énumération)
    const opts: ConnectOptions = last.opts.usb
      ? {...last.opts, usb: {...last.opts.usb, deviceName: dev.deviceName, vendorId: dev.vendorId, productId: dev.productId}}
      : last.opts;
    const tries = this.usbReconnectTries; // disconnect() (dans connect) remet le compteur à zéro
    try {
      await this.connect('usb', opts, last.model);
      this.usbReconnectTries = 0;
      s.pushLog('info', 'USB : liaison rétablie automatiquement — synchro relancée');
    } catch (e) {
      this.usbReconnectTries = tries; // restaure le compteur : les échecs ne bouclent pas à l'infini
      s.pushLog('error', `USB : reconnexion automatique échouée (${(e as Error).message})`);
      this.scheduleUsbReconnect();
    }
  }

  /** Rétablit la liaison Bluetooth (adresse immuable) sans action
   *  utilisateur. 4 essais espacés — couvre le brown-out du module BT côté
   *  télescope pendant un slew (chute de tension moteur). */
  private async tryBtReconnect(): Promise<void> {
    const last = this.lastBt;
    if (!last) return;
    const s = useScopeStore.getState();
    if (s.connStatus === 'connected' || s.connStatus === 'connecting') return;
    if (this.btReconnectTries >= 4) {
      s.pushLog('info', 'Bluetooth : reconnexion automatique abandonnée — reconnectez dans l\'onglet Connexion');
      return;
    }
    this.btReconnectTries += 1;
    const tries = this.btReconnectTries;
    try {
      await this.connect('bluetooth', last.opts, last.model);
      this.btReconnectTries = 0;
      s.pushLog('info', 'Bluetooth : liaison rétablie automatiquement — synchro relancée');
    } catch (e) {
      this.btReconnectTries = tries;
      s.pushLog('error', `Bluetooth : reconnexion automatique échouée (${(e as Error).message})`);
      this.scheduleBtReconnect();
    }
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

  /* ---------- API haut niveau (ROUTÉE vers le driver actif) ---------- */

  async getRaDec(timeoutMs = 3000): Promise<RaDec> {
    if (!this.drv.caps.position) throw new TransportError('Position non disponible sur ce protocole');
    return this.drv.getRaDec
      ? this.drv.getRaDec(this, timeoutMs)
      : (await this.drv.readPosition(this, timeoutMs)) as RaDec;
  }

  /**
   * Lecture AD/DEC TOLÉRANTE pour le polling : chaque axe est indépendant
   * (une raquette peut répondre à :Gr# mais tarder sur :Gd# — on garde
   * l'axe lu au lieu de tout jeter). Renvoie null par axe si muet/illisible.
   * Petite respiration (40 ms) entre les 2 commandes : le tampon UART des
   * Autostar est minuscule, deux commandes collées peuvent perdre la 2e.
   */
  async readPosition(): Promise<{raDeg: number | null; decDeg: number | null}> {
    if (!this.drv.caps.position) return {raDeg: null, decDeg: null};
    // Timeout ADAPTATIF : si aucun axe ne répond depuis plusieurs cycles
    // (liaison muette), on raccourcit l'attente pour ne pas geler le rythme
    // du miroir ni retarder la reprise dès que la raquette se réveille.
    const mute = this.lastPosAt > 0 && Date.now() - this.lastPosAt > 6000;
    return this.drv.readPosition(this, mute ? 1800 : 3000);
  }

  async getFirmware(): Promise<{product: string; version: string}> {
    return this.drv.firmware(this);
  }

  /**
   * Lecture du LCD RÉEL de la raquette physique (:ED#, timeout court).
   * Renvoie null si la raquette ne connaît pas :ED# (LX200 classique) ou
   * est muette ce cycle — l'appelant garde alors son écran précédent.
   */
  async getLcd(): Promise<{line1: string; line2: string} | null> {
    if (!this.drv.caps.lcdMirror || !this.drv.lcd) return null;
    return this.drv.lcd(this);
  }

  /** Réponse BRUTE du LCD de la raquette physique (flèche de SÉLECTION,
   *  handboxPush) — null hors Meade ou raquette muette. */
  async getLcdRaw(): Promise<string | null> {
    if (!this.drv.caps.lcdMirror || !this.drv.lcdRaw) return null;
    return this.drv.lcdRaw(this);
  }

  /**
   * Simule un appui de touche SUR la raquette physique (:EK<ascii>#).
   * Meade uniquement — no-op silencieux (journalisé) pour les autres.
   */
  async keyPress(code: number): Promise<void> {
    if (!this.drv.caps.keyPress || !this.drv.keyPress) return;
    await this.drv.keyPress(this, code);
  }

  async setSpeed(speed: Speed) {
    if (!this.drv.caps.relay) return;
    await this.drv.setSpeed(this, speed);
    this.ownMoveUntil = Math.max(this.ownMoveUntil, Date.now() + 1200);
  }

  async startMove(dir: Dir) {
    this.bump();
    await this.drv.startMove(this, dir);
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
   *  de lecture en cours. (public : partie du contrat DriverClient) */
  bump() {
    this.priorityUntil = Date.now() + 700;
  }

  /** La liaison est-elle « occupée » par un mouvement (app ou matériel) ?
   *  Pendant un slew — GOTO lancé par l'app (ownMoveUntil) ou flèches — la
   *  plupart des raquettes ne répondent plus au port série : ce n'est PAS
   *  une panne. Toute la logique de diagnostic (compteurs d'échec, sondes,
   *  hint « muette ») s'appuie sur ce prédicat. (v2.1.2 : ownMoveUntil inclus,
   *  un GOTO lancé depuis l'app ne doit JAMAIS déclencher les diagnostics
   *  « raquette muette » qui donnaient l'impression d'une connexion perdue.) */
  private isBusyNow(): boolean {
    const now = Date.now();
    return this.lastMovedFlag || this.holding.size > 0 ||
      now - this.lastExternalAt < 3000 || now < this.ownMoveUntil;
  }

  async stopMove(dir: Dir) {
    this.bump();
    await this.drv.stopMove(this, dir);
    this.ownMoveUntil = Date.now() + 1200;
  }

  async stopAll() {
    this.bump();
    await this.drv.stopAll(this);
    this.ownMoveUntil = Date.now() + 1200;
  }

  /* ---------- ARRÊT GOTO (v2.9.2 — « j'ai aucun moyen de l'arrêter ») ---- */

  /** Génération du relais courant — un nouveau GOTO (ou le bouton ARRÊTER)
   *  incrémente ce compteur : l'ancien relais le voit à son prochain point
   *  d'annulation (≤ 250 ms) et s'arrête net. AVANT v2.9.2, deux GOTO
   *  successifs laissaient deux boucles piloter les moteurs en même temps
   *  (la monture finissait en butée). */
  private relayGen = 0;

  /** v2.9.4 — « le goto est toujours lent quand il se lance » (2e retour) :
   *  le CHEMIN DIRECT (:Sr/:Sd/:MS) échoue en mutisme sur certaines raquettes
   *  (#49x sur série lente) — chaque GOTO repayait alors 15-25 s de sondes
   *  muettes (ESC ESC + 2 précisions :Sr + :Sd + :MS 3 s + sonde :D#) AVANT
   *  que le relais ne bouge la monture : le pointage « démarre » en réalité
   *  très tard. Dès qu'un chemin direct échoue (muet OU refus des 2
   *  précisions), les GOTO suivants de la session partent DIRECTEMENT en
   *  relais. Réinitialisé à chaque connexion/reconnexion : un changement
   *  d'état de la raquette (appui MODE, redémarrage, autre câble) redonne
   *  sa chance au chemin natif — plus rapide quand il est accepté. */
  private directGotoDead = false;

  /** ARRÊT IMMÉDIAT du GOTO en cours (relais boucle fermée OU slew direct)
   *  — bouton ARRÊTER global. Coupe les moteurs tout de suite (:Q#), tue le
   *  relais (génération) et libère l'interface. */
  async abortGoto() {
    this.relayGen += 1; // le relais en cours sortira en 'aborted' (≤ 250 ms)
    this.bump();
    useScopeStore.getState().setGotoRunning(false);
    useScopeStore.getState().pushLog('info', 'GOTO arrêté (commande utilisateur)');
    await this.stopAll().catch(() => undefined);
  }

  /** Sommeil morcelé qui surveille la génération du relais : renvoie false
   *  si le relais a été annulé (nouveau GOTO ou bouton ARRÊTER) — l'arrêt
   *  est donc vu en ≤ 250 ms au lieu d'attendre la fin de l'impulsion
   *  (jusqu'à 10 s). */
  private async sleepCancellable(ms: number, gen: number): Promise<boolean> {
    let left = ms;
    while (left > 0) {
      if (gen !== this.relayGen) return false;
      const step = Math.min(250, left);
      await sleep(step);
      left -= step;
    }
    return gen === this.relayGen;
  }

  /** Sortie d'annulation du relais : moteurs coupés, statut 'aborted'. */
  private async relayAbortExit(): Promise<GotoStatus> {
    await this.stopAll().catch(() => undefined);
    this.ownMoveUntil = Date.now() + 1200;
    return 'aborted';
  }

  // setTargetBit / probeSlewStarted : logique Meade déplacée dans
  // drivers/meade.ts (setTargetBit, probeSlewStarted) — le client route.

  /** GOTO vers RA/Dec. Renvoie un statut FIN (v2.0.1, relais v2.5.0,
   *  multi-protocoles v2.6.0) :
   *  'ok'          — slew parti (confirmé par le protocole ou sa sonde) ;
   *  'belowHorizon'— refus honnête du protocole (objet sous l'horizon) ;
   *  'noObject'    — objet introuvable/hors limites du protocole ;
   *  'refused'     — REFUS EXPLICITE de la monture (cible rejetée) ;
   *  'mute'        — aucune réponse — le GOTO a peut-être démarré (sonde) ;
   *  'noLink'      — liaison morte : état remis à zéro, reconnexion auto.
   *  En cas d'échec de LIAISON (mute/refus muet/noLink), le RELAIS (v2.5.0)
   *  prend le relais en boucle fermée avec les primitives de jog du driver
   *  — multi-marques depuis v2.6.0 (Meade, NexStar, SynScan, iOptron). */
  async gotoRaDec(raDeg: number, decDeg: number, horizonNow?: Date): Promise<GotoStatus> {
    this.bump();
    // v2.9.2 : SINGLE-FLIGHT — incrémenter la génération tue tout relais
    // encore en cours (changement de cible pendant un GOTO) ; la boucle
    // ancienne sort en ≤ 250 ms sans commander le moindre moteur de plus.
    const gen = ++this.relayGen;
    useScopeStore.getState().setGotoRunning(true); // bouton ARRÊTER global
    // PHASE CRITIQUE (v2.1.1) : le polling (:ED#/:Gr#/:Gd#) est suspendu
    // pendant toute la séquence — un GOTO lancé depuis l'app doit avoir la
    // ligne série pour lui seul, sinon les expirations des commandes de poll
    // intercalées le font échouer (un GOTO déclenché SUR la raquette
    // physique, sans trafic concurrent, passait toujours).
    this.cmdPhase = true;
    try {
      // v2.9.4 — chemin direct déjà mort dans cette session : relais
      // IMMÉDIAT (le premier mouvement moteur part en ~1 s au lieu de
      // 15-25 s de sondage d'une séquence connue muette).
      if (this.directGotoDead && this.drv.caps.relay) {
        this.log('info', 'GO TO : chemin natif déjà muet/refusé dans cette session — RELAIS immédiat');
        return await this.gotoRaDecRelay(raDeg, decDeg, 'mute', horizonNow, gen);
      }
      const r = await this.gotoRaDecInner(raDeg, decDeg);
      if (r === 'mute' || r === 'refused') {
        // un seul échec suffit : la sonde du prochain GOTO ne repayera pas
        this.directGotoDead = true;
      }
      if (r === 'ok') {
        // GOTO parti : fenêtre « mouvement app » + suivi de fin + notifications
        this.ownMoveUntil = Math.max(this.ownMoveUntil, Date.now() + 45000);
        this.notifyGotoStart(); // v2.3.0 : moniteur contrôle croisé armé
        this.watchSlewEnd();
      }
      // RELAIS (v2.5.0 — cause racine « GOTO lancé depuis l'app = raquette
      // déconnectée ») : sur certaines raquettes (DS/Autostar série lente),
      // la séquence directe échoue ALORS QUE lectures de position et moteurs
      // fonctionnent (socle éprouvé des flèches/suivi/réglage fin). Les
      // réponses honnêtes du protocole (objet sous l'horizon, introuvable)
      // ne déclenchent PAS de relais ; les échecs de LIAISON (mute, refus
      // muet, liaison tombée) oui — après rétablissement automatique.
      if (r === 'ok' || r === 'belowHorizon' || r === 'noObject') return r;
      if (!this.drv.caps.relay) {
        this.log('error', 'RELAIS indisponible sur ce protocole — GOTO abandonné');
        return r;
      }
      return await this.gotoRaDecRelay(raDeg, decDeg, r, horizonNow, gen);
    } finally {
      this.cmdPhase = false;
      useScopeStore.getState().setGotoRunning(false);
    }
  }

  /** Attend le rétablissement automatique de la liaison (USB/BT v2.1.1+
   *  v2.1.2) — un brown-out pendant :MS ne doit plus tuer le GOTO : la
   *  reconnexion automatique tourne déjà, le relais la laisse finir puis
   *  pointe lui-même. Renvoie true si la liaison revient. */
  private async waitForLink(maxS: number): Promise<boolean> {
    for (let i = 0; i < maxS; i++) {
      if (this.isConnected()) return true;
      await sleep(1000);
    }
    return this.isConnected();
  }

  /** Taux du relais : taux MESURÉS au calibrage si disponibles pour la
   *  vitesse demandée, sinon taux du PRESET de monture (v2.9.2 — le
   *  calibrage ne mesure qu'au taux center : le slew partait du défaut
   *  générique 2°/s au lieu des 4-5°/s réels d'une DS/ETX, d'où un GOTO
   *  « en vitesse très lente »), sinon taux théoriques du ciel.
   *  NB : ces taux ne calent que la DURÉE des impulsions — la vitesse
   *  PHYSIQUE vient de la commande de vitesse (setSpeed) ; l'apprentissage
   *  relayLearned (v2.9.3) corrige en cours de GOTO une hypothèse fausse. */
  private relayRates(): RelayRates {
    const mc = useMotorCalibStore.getState();
    const st = useSettingsStore.getState();
    const preset = activePreset(
      st.mountBrandId, st.mountModelId, st.customMount,
      useScopeStore.getState().model, st.mountPreset);
    const rateFor = (s: 'slew' | 'find' | 'center'): number => {
      if (mc.apply && mc.rates && mc.rates.speed === s) {
        const raMeas = mc.rates.e ?? mc.rates.w;
        const decMeas = mc.rates.n ?? mc.rates.s;
        const m = Math.min(raMeas ?? Infinity, decMeas ?? Infinity);
        if (Number.isFinite(m) && m > 1e-4) return m;
      }
      return preset.expectedRates[s] ?? DEFAULT_SKY_RATES[s];
    };
    return {slew: rateFor('slew'), find: rateFor('find'), center: rateFor('center')};
  }

  /** Taux réels APPRIS pendant le relais (v2.9.3) — EMA par vitesse et par
   *  axe (arc parcouru ÷ durée commandée). Vide à chaque nouveau relais. */
  private relayLearned: Partial<Record<RelaySpeed, {ra: number | null; dec: number | null}>> = {};
  /** Taux déjà journalisés pour ce relais (une seule ligne par vitesse). */
  private relayLearnLogged = new Set<RelaySpeed>();

  /** Alimente l'apprentissage d'un axe (v2.9.3). */
  private relayLearn(speed: RelaySpeed, axis: 'ra' | 'dec', movedDeg: number, pulseS: number, assumed: number) {
    const cur = this.relayLearned[speed] ?? {ra: null, dec: null};
    const v = relayLearnRate(axis === 'ra' ? cur.ra : cur.dec, movedDeg, pulseS, assumed);
    if (axis === 'ra') cur.ra = v; else cur.dec = v;
    this.relayLearned[speed] = cur;
    const cands = [cur.ra, cur.dec].filter((x): x is number => x != null);
    const m = Math.min(...cands);
    if (!this.relayLearnLogged.has(speed) && cands.length > 0 &&
        (m < assumed * 0.6 || m > assumed * 1.6)) {
      this.relayLearnLogged.add(speed);
      useScopeStore.getState().pushLog('info',
        `RELAIS : taux réel ${speed === 'slew' ? 'slew' : speed} ≈ ${m.toFixed(2)}°/s ` +
        `(hypothèse ${assumed.toFixed(2)}°/s) — impulsions recalées`);
    }
  }

  /** Taux pour la décision : valeur APPRISE de l'axe si disponible,
   *  sinon hypothèse (preset/calibrage). Les axes appris diffèrent d'un
   *  axe à l'autre (jeu mécanique) — le MIN est le plus prudent : il
   *  allonge l'impulsion de l'axe lent plutôt que de dépasser. */
  private relayRatesOf(base: RelayRates): RelayRates {
    const mix = (s: RelaySpeed): number => {
      const l = this.relayLearned[s];
      const cands = [base[s]];
      if (l?.ra != null) cands.push(l.ra);
      if (l?.dec != null) cands.push(l.dec);
      return Math.min(...cands);
    };
    return {slew: mix('slew'), find: mix('find'), center: mix('center')};
  }

  /** Signes du relais : apprentissage persisté du calibrage si actif. */
  private relaySigns(): RelaySigns {
    const mc = useMotorCalibStore.getState();
    return mc.apply ? {ra: mc.signs.ra, dec: mc.signs.dec} : {ra: 1, dec: 1};
  }

  /**
   * GOTO RELAIS en boucle fermée (v2.5.0) — pilote les moteurs LUI-MÊME avec
   * les commandes éprouvées (vitesses :RS#/:RC#, mouvements :Me#:Mw#:Mn#:Ms#,
   * lectures :Gr#/:Gd#) jusqu'à amener la monture sur la cible. Ne suppose
   * AUCUNE commande de GOTO côté raquette : c'est le contournement des
   * raquettes qui restent muettes sur :Sr/:Sd/:MS.
   *
   * Garde-fous : horizon (alt < 0 → refus honnête), impulsion plafonnée,
   * inversion de sens automatique si l'erreur d'un axe augmente, détection
   * de stalle (butée / moteur sans effet), garde de durée globale,
   * stopAll systématique en sortie. Notifie onGotoStart/onGotoArrival pour
   * le contrôle croisé télémétrie/moteurs et le réglage fin (v2.3.0/v2.2.0).
   */
  private async gotoRaDecRelay(
    raDeg: number, decDeg: number, cause: GotoStatus,
    horizonNow?: Date, gen = this.relayGen,
    opts?: {park?: boolean},
  ): Promise<GotoStatus> {
    const park = opts?.park === true;
    const log = (m: string) => useScopeStore.getState().pushLog('info', m);
    const logErr = (m: string) => useScopeStore.getState().pushLog('error', m);
    if (park) {
      log('PARC : retour à la position Home enregistrée (onglet Alignement) — pilotage moteur en boucle fermée');
    } else {
      const causeTxt = cause === 'noLink' ? 'liaison perdue' : cause === 'refused' ? 'cible refusée' : 'raquette muette';
      logErr(`GO TO direct impossible (${causeTxt}) — RELAIS : pilotage moteur en boucle fermée`);
    }

    // 1. liaison : un noLink laisse la reconnexion automatique finir (25 s)
    if (cause === 'noLink' && !(await this.waitForLink(25))) {
      logErr('RELAIS abandonné : liaison non rétablie');
      return 'noLink';
    }

    // 2. butées de la monture (v2.9.2) — le relais n'a pas le garde-fou :MS :
    //    le calcul d'altitude du téléphone le remplace, désormais pour les
    //    DEUX butées du preset (avant : horizon seul — « le télescope monte
    //    jusqu'à la butée et cherche à continuer de monter »).
    //    MODE PARC (v2.9.5) : la Home alt-az est TUBE HORIZONTAL (alt 0°) —
    //    refusée par la garde normale (marge 2°) comme par :MS (« sous
    //    l'horizon ») ; en parc on ne refuse PAS la cible, la garde basse de
    //    la boucle devient le mécanisme d'arrêt (position Home atteinte).
    const st = useSettingsStore.getState();
    const site = st.site;
    const preset = activePreset(
      st.mountBrandId, st.mountModelId, st.customMount,
      useScopeStore.getState().model, st.mountPreset);
    const alt = raDecToAltAz(raDeg, decDeg, site.latDeg, site.lonDeg, horizonNow ?? new Date()).altDeg;
    if (!park) {
      if (alt < 0) {
        log(`RELAIS : cible sous l'horizon (alt ${alt.toFixed(0)}°) — refus`);
        return 'belowHorizon';
      }
      const tgtBlock = relayAltBlocked(alt, preset.minAltDeg, preset.maxAltDeg);
      if (tgtBlock) {
        log(`RELAIS : cible hors butées de la monture ${preset.label} ` +
            `(alt ${alt.toFixed(0)}° — ${tgtBlock === 'high' ? `butée haute ${preset.maxAltDeg}` : `butée basse ${preset.minAltDeg}`}°) — refus`);
        return 'noObject';
      }
    } else if (alt < -5) {
      log(`PARC : cible nettement sous l'horizon (alt ${alt.toFixed(0)}°) — refus`);
      return 'belowHorizon';
    }

    // 3. position initiale — sans position lisible, rien n'est possible
    let cur: {raDeg: number | null; decDeg: number | null} | null = null;
    for (let i = 0; i < 3 && !cur; i++) {
      cur = await this.readPosition().catch(() => null);
      if (cur && cur.raDeg === null && cur.decDeg === null) cur = null;
    }
    if (!cur || cur.raDeg == null || cur.decDeg == null) {
      // un seul axe lisible suffit : l'autre partira du dernier connu
      const raKnown = cur?.raDeg != null;
      const decKnown = cur?.decDeg != null;
      if (!raKnown && !decKnown) {
        logErr('RELAIS abandonné : position de la monture illisible (:Gr#/:Gd# muets)');
        return 'mute';
      }
    }
    const pos = {
      raDeg: cur?.raDeg ?? this.lastRaDeg ?? raDeg,
      decDeg: cur?.decDeg ?? this.lastDecDeg ?? decDeg,
    };

    // 4. boucle fermée
    this.ownMoveUntil = Date.now() + 300000; // tout le mouvement = l'app
    this.notifyGotoStart(); // contrôle croisé armé (v2.3.0)
    const signs = this.relaySigns();
    const ratesBase = this.relayRates();
    this.relayLearned = {}; // apprentissage reparti à zéro à chaque relais
    this.relayLearnLogged.clear();
    log(`RELAIS : taux présumés slew ${ratesBase.slew.toFixed(2)}°/s · find ${
      ratesBase.find.toFixed(2)}°/s · center ${ratesBase.center.toFixed(2)}°/s ` +
      `(monture ${preset.label} — recalés en cours de pointage)`);
    const startedAt = Date.now();
    const MAX_MS = 210000;
    // reste d'arc d'un axe après impulsion (raccord 0 h pour l'AD)
    const remainRaOf = (ra: number) => raDeltaDeg(ra, raDeg);
    const remainDecOf = (dec: number) => dec - decDeg;
    const stalledStreak = {ra: 0, dec: 0};
    let iterations = 0;
    try {
      while (Date.now() - startedAt < MAX_MS && this.isConnected() && iterations < 150) {
        // v2.9.2 : annulation (bouton ARRÊTER ou nouveau GOTO) — vérifiée à
        // CHAQUE itération, avant toute commande moteur
        if (gen !== this.relayGen) return await this.relayAbortExit();
        iterations += 1;
        const rates = this.relayRatesOf(ratesBase);
        const d = relayDecision({
          raDeg: pos.raDeg, decDeg: pos.decDeg,
          targetRaDeg: raDeg, targetDecDeg: decDeg,
          signs, rates, maxPulseS: 10,
        });
        if (d.done) {
          await this.stopAll().catch(() => undefined);
          log(`RELAIS : cible atteinte en ${(Date.now() - startedAt) / 1000 | 0} s (${iterations} pas) — contrôle croisé en cours`);
          this.ownMoveUntil = Date.now() + 1200;
          this.watchSlewEnd(); // suivi de fin + notif d'arrivée (v2.2.0)
          return 'ok';
        }
        // v2.9.3 : vitesse DEMANDÉE À CHAQUE itération — la commande est
        // idempotente et courte ; une seule perdue (tampon UART minuscule
        // des #49x, retentative avalée) laissait la monture au taux
        // PRÉCÉDENT (center/guide du suivi ou du réglage fin) et toute la
        // séquence rampant (« le goto se lance mais en vitesse très lente »)
        await this.setSpeed(d.speed).catch(() => undefined);
        const before = {ra: d.remainRaDeg, dec: d.remainDecDeg};
        const raMs = Math.round(d.raS * 1000);
        const decMs = Math.round(d.decS * 1000);
        const commandedArc = Math.max(d.raS, d.decS) * rates[d.speed];
        const startedDirs: Dir[] = [];
        if (d.dirs.raDir) {
          await this.startMove(d.dirs.raDir).catch(() => undefined);
          startedDirs.push(d.dirs.raDir);
        }
        if (d.dirs.decDir) {
          await this.startMove(d.dirs.decDir).catch(() => undefined);
          startedDirs.push(d.dirs.decDir);
        }
        // arrêt INDIVIDUEL : chaque axe s'arrête à SA durée (mouvement
        // parallèle à vitesse commune de la monture) — sommeils morcelés
        // ANNULABLES (≤ 250 ms) : le bouton ARRÊTER ne doit jamais attendre
        // la fin d'une impulsion
        if (raMs <= decMs) {
          if (raMs > 0 && !(await this.sleepCancellable(raMs, gen))) {
            return await this.relayAbortExit();
          }
          if (d.dirs.raDir) await this.stopMove(d.dirs.raDir).catch(() => undefined);
          if (decMs - Math.max(raMs, 0) > 0 &&
              !(await this.sleepCancellable(decMs - Math.max(raMs, 0), gen))) {
            return await this.relayAbortExit();
          }
          if (d.dirs.decDir) await this.stopMove(d.dirs.decDir).catch(() => undefined);
        } else {
          if (decMs > 0 && !(await this.sleepCancellable(decMs, gen))) {
            return await this.relayAbortExit();
          }
          if (d.dirs.decDir) await this.stopMove(d.dirs.decDir).catch(() => undefined);
          if (raMs - Math.max(decMs, 0) > 0 &&
              !(await this.sleepCancellable(raMs - Math.max(decMs, 0), gen))) {
            return await this.relayAbortExit();
          }
          if (d.dirs.raDir) await this.stopMove(d.dirs.raDir).catch(() => undefined);
        }
        if (!(await this.sleepCancellable(350, gen))) {
          return await this.relayAbortExit(); // inertie mécanique avant relecture
        }
        const next = await this.readPosition().catch(() => null);
        if (next) {
          const newRa = next.raDeg ?? pos.raDeg;
          const newDec = next.decDeg ?? pos.decDeg;
          // inversion automatique : l'erreur a grandi après une impulsion franche
          if (d.dirs.raDir && next.raDeg != null &&
              relaySignWasWrong(before.ra, remainRaOf(newRa), commandedArc)) {
            signs.ra = (signs.ra * -1) as 1 | -1;
            log(`RELAIS : sens AD inversé (${signs.ra > 0 ? 'Est = AD+' : 'Ouest = AD−'}) — convention du matériel apprise`);
            stalledStreak.ra = 0;
          }
          if (d.dirs.decDir && next.decDeg != null &&
              relaySignWasWrong(before.dec, remainDecOf(newDec), commandedArc)) {
            signs.dec = (signs.dec * -1) as 1 | -1;
            log(`RELAIS : sens DEC inversé (${signs.dec > 0 ? 'Nord = DEC+' : 'Sud = DEC−'}) — convention du matériel apprise`);
            stalledStreak.dec = 0;
          }
          // stalle : UN axe COMMANDÉ figé suffit (v2.9.2) — butée atteinte
          // ou moteur sans effet. AVANT : il fallait que TOUS les axes
          // commandés soient figés — l'axe en butée continuait donc d'être
          // piloté tant que l'autre axe bougeait (« cherche à continuer de
          // monter sans respecter la butée »).
          if (d.dirs.raDir) {
            stalledStreak.ra = next.raDeg != null && Math.abs(newRa - pos.raDeg) < 0.02
              ? stalledStreak.ra + 1 : 0;
          }
          if (d.dirs.decDir) {
            stalledStreak.dec = next.decDeg != null && Math.abs(newDec - pos.decDeg) < 0.02
              ? stalledStreak.dec + 1 : 0;
          }
          if ((d.dirs.raDir && stalledStreak.ra >= 3) ||
              (d.dirs.decDir && stalledStreak.dec >= 3)) {
            await this.stopAll().catch(() => undefined);
            // MODE PARC (v2.9.5) : la monture qui REPOSE sur sa butée (tube
            // horizontal, plus bas impossible) EST à la position Home — un
            // reste < 1° clos le parc en succès au lieu d'une erreur.
            if (park) {
              const remain = Math.max(Math.abs(d.remainRaDeg), Math.abs(d.remainDecDeg));
              if (remain < 1) {
                log(`PARC : position Home atteinte (la monture repose sur sa butée — reste ${(remain * 60).toFixed(0)}′)`);
                this.ownMoveUntil = Date.now() + 1200;
                this.watchSlewEnd();
                return 'ok';
              }
            }
            const stuckAxis = (d.dirs.raDir && stalledStreak.ra >= 3) ? 'AD' : 'DEC';
            logErr(`RELAIS interrompu : axe ${stuckAxis} figé malgré les impulsions (butée atteinte ou moteur sans effet)`);
            this.ownMoveUntil = Date.now() + 1200;
            return 'relayPartial';
          }
          // v2.9.3 : apprentissage du taux RÉEL par axe — l'hypothèse
          // (preset/calibrage) ne cale que les durées ; un écart ×10 se
          // voit ici et recalcule les impulsions suivantes (arc mesuré
          // AVANT la mise à jour de la position !)
          if (d.dirs.raDir && d.raS >= 0.12 && next.raDeg != null) {
            this.relayLearn(d.speed, 'ra', Math.abs(newRa - pos.raDeg), d.raS, ratesBase[d.speed]);
          }
          if (d.dirs.decDir && d.decS >= 0.12 && next.decDeg != null) {
            this.relayLearn(d.speed, 'dec', Math.abs(newDec - pos.decDeg), d.decS, ratesBase[d.speed]);
          }
          pos.raDeg = newRa;
          pos.decDeg = newDec;
          // garde butées CONTINUE (v2.9.2) : la position s'évalue en altitude
          // à chaque itération — un pointage erroné ne doit JAMAIS pousser la
          // monture dans sa course mécanique. MODE PARC (v2.9.5) : la marge
          // basse est ANNULÉE (la Home alt-az EST l'horizontale) et l'arrêt
          // bas est un SUCCÈS — la position Home est atteinte.
          const altCur = raDecToAltAz(
            pos.raDeg, pos.decDeg, site.latDeg, site.lonDeg, new Date()).altDeg;
          const minGuard = park ? preset.minAltDeg - RELAY_ALT_MARGIN_DEG : preset.minAltDeg;
          const blk = relayAltBlocked(altCur, minGuard, preset.maxAltDeg);
          if (blk === 'low' && park) {
            await this.stopAll().catch(() => undefined);
            log(`PARC : position Home atteinte (alt ${altCur.toFixed(1)}° — tube à l'horizontale)`);
            this.ownMoveUntil = Date.now() + 1200;
            this.watchSlewEnd(); // notif d'arrivée (réglage fin/contrôle croisé)
            return 'ok';
          }
          if (blk) {
            await this.stopAll().catch(() => undefined);
            logErr(`RELAIS interrompu : butée ${blk === 'high' ? 'haute' : 'basse'} ` +
                `de la monture ${preset.label} (${altCur.toFixed(0)}° — ` +
                `course ${preset.minAltDeg}…${preset.maxAltDeg}°)`);
            this.ownMoveUntil = Date.now() + 1200;
            return 'relayPartial';
          }
          useScopeStore.getState().setPosition(pos.raDeg, pos.decDeg); // carte du ciel suit le relais en live
        }
      }
      await this.stopAll().catch(() => undefined);
      this.ownMoveUntil = Date.now() + 1200;
      const fin = relayDecision({
        raDeg: pos.raDeg, decDeg: pos.decDeg, targetRaDeg: raDeg, targetDecDeg: decDeg,
        signs, rates: this.relayRatesOf(ratesBase), maxPulseS: 6,
      });
      const remainArc = Math.max(Math.abs(fin.remainRaDeg), Math.abs(fin.remainDecDeg));
      logErr(`RELAIS : cible approchée à ${(remainArc * 60).toFixed(0)}' mais hors tolérance (${
        Date.now() - startedAt > MAX_MS ? 'garde de durée' : 'liaison interrompue'})`);
      return 'relayPartial';
    } finally {
      // rien ne doit rester en mouvement, quel que soit le chemin de sortie
      await this.stopAll().catch(() => undefined);
    }
  }

  /** Chemin DIRECT du GOTO (délégué au driver actif — Meade robuste v2.0.1,
   *  NexStar 'r', iOptron :MS#) — séparé pour les tests et le relais. */
  private async gotoRaDecInner(raDeg: number, decDeg: number): Promise<GotoStatus> {
    this.bump();
    const r = await this.drv.goto(this, raDeg, decDeg);
    if (r === 'noLink') this.handleLinkClosed(); // état « connected » fantôme interdit
    return r;
  }

  /** Suit la fin du GOTO par :D# ("|" pendant le moteur, vide à l'arrivée).
   *  Boucle tolérante : les raquettes muettes pendant un moteur ne coupent
   *  pas la surveillance ; la moindre réponse vide ou stabilisation de
   *  position clôt l'épisode. Fire-and-forget (max 3 min).
   *  À l'ARRIVÉE, les auditeurs v2.2.0 sont notifiés (réglage fin
   *  télémétrique automatique — cf. fineTune.ts). */
  private watchSlewEnd(cycles = 0) {
    if (cycles > 260) return; // ~3 min à 700 ms
    setTimeout(() => {
      if (!this.isConnected()) return;
      this.isMoving()
        .then((moving) => {
          if (moving === false) {
            const s = useScopeStore.getState();
            s.pushLog('info', 'GOTO terminé (monture arrivée)');
            this.ownMoveUntil = Date.now() + 1200;
            this.notifyGotoArrival();
          } else {
            this.watchSlewEnd(cycles + 1);
          }
        })
        .catch(() => this.watchSlewEnd(cycles + 1)); // muette : on réessaie
    }, 700);
  }

  /* ---------- auditeurs d'arrivée GOTO (v2.2.0) ---------- */

  /** Auditeurs notifiés quand un GOTO (app OU raquette physique, via la
   *  surveillance :D#) est terminé. JS pur — jamais transmis au natif. */
  private gotoArrivalCbs = new Set<(raDeg: number | null, decDeg: number | null) => void>();

  /** Auditeurs notifiés au DÉPART d'un GOTO app (v2.3.0) — le moniteur de
   *  contrôle croisé télémétrie/moteurs s'arme à cet instant. JS pur. */
  private gotoStartCbs = new Set<() => void>();

  /** Enregistre un auditeur d'arrivée GOTO ; renvoie la fonction de retrait. */
  onGotoArrival(cb: (raDeg: number | null, decDeg: number | null) => void): () => void {
    this.gotoArrivalCbs.add(cb);
    return () => {this.gotoArrivalCbs.delete(cb);};
  }

  /** Enregistre un auditeur de départ GOTO app (v2.3.0) ; renvoie le retrait. */
  onGotoStart(cb: () => void): () => void {
    this.gotoStartCbs.add(cb);
    return () => {this.gotoStartCbs.delete(cb);};
  }

  private notifyGotoStart() {
    for (const cb of [...this.gotoStartCbs]) {
      try {cb();} catch (_) { /* un auditeur fautif ne bloque pas les autres */ }
    }
  }

  private notifyGotoArrival() {
    const ra = this.lastRaDeg;
    const dec = this.lastDecDeg;
    for (const cb of [...this.gotoArrivalCbs]) {
      try {cb(ra, dec);} catch (_) { /* un auditeur fautif ne bloque pas les autres */ }
    }
  }

  /** Dernière position AD/DEC lue de la raquette (null si jamais lue). */
  get scopeRaDec(): {raDeg: number; decDeg: number} | null {
    if (this.lastRaDeg == null || this.lastDecDeg == null) return null;
    return {raDeg: this.lastRaDeg, decDeg: this.lastDecDeg};
  }

  /** Le moteur est-il en marche ? (Meade :D# — "|" en mouvement, vide à
   *  l'arrêt ; NexStar 'L' — '1'/'0'.) null = indéterminé (muette/protocole
   *  sans sonde) — les appelants basculent alors sur la stabilisation. */
  async isMoving(): Promise<boolean | null> {
    if (!this.drv.caps.isMoving) return null;
    try {
      return await this.drv.isMoving(this);
    } catch (_) {
      return null;
    }
  }

  async syncHere(): Promise<void> {
    if (!this.drv.caps.syncHere) {
      throw new TransportError('SYNC ici non disponible sur ce protocole');
    }
    await this.drv.syncHere(this);
  }

  /**
   * SYNC sur des coordonnées données (v1.9.0, recalage télémétrie) :
   * pose la cible puis déclare la position physique courante = ces
   * coordonnées (Meade :Sr/:Sd/:CM# · NexStar 's' · iOptron :Sr/:Sd/:CM#).
   * Met à jour l'alignement INTERNE de la monture sans GOTO. Renvoie false
   * si la monture refuse (explicitement ou par mutisme).
   */
  async syncRaDec(raDeg: number, decDeg: number): Promise<boolean> {
    this.bump();
    if (!this.drv.caps.sync) {
      this.log('error', 'SYNC non disponible sur ce protocole');
      return false;
    }
    this.cmdPhase = true; // même réservation de la ligne série que le GOTO
    try {
      return await this.drv.syncRaDec(this, raDeg, decDeg);
    } finally {
      this.cmdPhase = false;
    }
  }

  /** Lecture date/heure/site de la monture (commande utilisateur). */
  async readScopeData(): Promise<{
    time: string; date: string; tz: string; latDeg: number | null; lonDeg: number | null;
  }> {
    this.bump();
    if (!this.drv.caps.readSite || !this.drv.readSite) {
      throw new TransportError('Lecture date/site non disponible sur ce protocole');
    }
    return this.drv.readSite(this);
  }

  /** Envoie date/heure/site du téléphone vers la monture (Meade :
   *  :SG/:SL/:SC/:St/:Sg avec conventions Est-négatif/UTC−local v2.2.1).
   *  Renvoie l'heure/date LOCALES envoyées ('HH:MM:SS' / 'MM/JJ/AA').
   *  Lève TransportError sur les protocoles sans push (NexStar v1 — les
   *  commandes H/W binaires sont volontairement évitées). */
  async pushPhoneData(latDeg: number, lonDeg: number): Promise<{time: string; date: string}> {
    this.bump();
    if (!this.drv.caps.pushSite || !this.drv.pushSite) {
      throw new TransportError('Envoi date/site non disponible sur ce protocole');
    }
    return this.drv.pushSite(this, latDeg, lonDeg);
  }

  /**
   * MISE À JOUR AUTOMATIQUE DE LA RAQUETTE À LA CONNEXION (v2.1.2 — demande
   * utilisateur : « une mise à jour automatique de la raquette physique
   * (date, heure, site etc....) dès la connexion »). Dès la liaison établie :
   *  - l'horloge du téléphone (heure locale + fuseau + date) part vers la
   *    raquette (:SG/:SL/:SC) — plus de date d'usine faussant le suivi et
   *    les éphémérides ;
   *  - le SITE mémorisé dans Réglages part vers la raquette (:St/:Sg) —
   *    les GOTO et l'alignement partent d'un site cohérent.
   *  Réglable (défaut ACTIVÉ) dans Réglages → « Mise à jour auto ». Non
   *  bloquant, silencieux en cas de raquette muette (les réponses sont
   *  tolérées), journalisé. En démo, le site du démonstrateur est aligné.
   */
  private async autoSyncScopeData(): Promise<void> {
    try {
      const st = useSettingsStore.getState();
      if (!st.autoSyncScope) return;
      const {latDeg, lonDeg, name} = st.site;
      const tp = this.transport;
      if (!tp) return;
      if (tp.type === 'demo') {
        setDemoSite(latDeg, lonDeg);
        return;
      }
      if (!this.drv.caps.pushSite) return; // protocole sans push : silencieux
      // petit délai : laisse la détection firmware (:GVP#/:GVN#) passer d'abord
      await sleep(600);
      if (!this.transport) return; // déconnecté entre-temps
      const sent = await this.pushPhoneData(latDeg, lonDeg);
      const s = useScopeStore.getState();
      s.setScopeTime(sent.time);
      s.setScopeDate(sent.date);
      s.pushLog('info', `Raquette mise à jour automatiquement — date, heure et site « ${name} » envoyés`);
    } catch (e) {
      // tolérant : une raquette muette à la mise sous tension ne doit jamais
      // faire échouer la connexion — l'envoi manuel reste disponible
      useScopeStore.getState().pushLog('info',
        `Mise à jour auto de la raquette non confirmée (${(e as Error).message}) — envoi manuel possible dans Réglages`);
    }
  }

  /** Modes de suivi (altaz/polaire/terrestre) — driver + latitude du site
   *  (NexStar : 'T2' éq nord / 'T3' éq sud selon l'hémisphère). */
  async setTracking(mode: 'altaz' | 'polar' | 'land') {
    if (!this.drv.caps.trackingModes || !this.drv.setTracking) return;
    const lat = useSettingsStore.getState().site.latDeg;
    await this.drv.setTracking(this, mode, lat);
  }

  /** Assistant d'alignement du protocole (Meade :Aa# easy) — les autres
   *  protocoles n'en ont pas : l'app fournit son propre flux 1-2 étoiles. */
  async startAlign(kind: 'easy' | 'one' | 'two') {
    if (!this.drv.caps.alignWizards || !this.drv.startAlign) {
      throw new TransportError('Assistant d\'alignement non disponible sur ce protocole');
    }
    await this.drv.startAlign(this, kind);
  }

  async focusStart(inward: boolean) {
    if (!this.drv.caps.focus || !this.drv.focusStart) return;
    await this.drv.focusStart(this, inward);
  }
  async focusStop() {
    if (!this.drv.caps.focus || !this.drv.focusStop) return;
    await this.drv.focusStop(this);
  }

  /** Vitesse du moteur de mise au point (Meade :FS#/:FM#/:FF#). */
  async setFocusSpeed(s: 'slow' | 'medium' | 'fast') {
    if (!this.drv.caps.focus || !this.drv.setFocusSpeed) return;
    await this.drv.setFocusSpeed(this, s);
  }

  /** Réticule illuminé du LX200 classique : luminosité ± (:B+ / :B-). */
  async reticleAdjust(delta: 1 | -1) {
    if (!this.drv.caps.reticle || !this.drv.reticleAdjust) return;
    await this.drv.reticleAdjust(this, delta);
  }

  /** Parc RAQUETTE (:hP# — position mémorisée dans le menu Park de la
   *  raquette elle-même) ; pour revenir à la « Position Home » enregistrée
   *  dans l'onglet Alignement, utiliser parkToHome() (v2.9.5). */
  async park() {
    if (!this.drv.caps.park || !this.drv.park) {
      throw new TransportError('Parc non disponible sur ce protocole');
    }
    await this.drv.park(this);
  }

  /** PARC VERS LA POSITION HOME (v2.9.5) — « quand je clique sur parc, le
   *  télescope ne revient pas sur la position home que j'ai enregistré dans
   *  l'onglet alignement ». L'ancien parc (:hP#) vise la position mémorisée
   *  DANS LA RAQUETTE (menu Park, rarement réglée) — jamais le point ⌂ de
   *  l'app.
   *
   *  Avec un point Home enregistré : la géométrie Home (alt/az selon le
   *  mode d'alignement et la latitude) est RECONVERTIE en AD/Dec À L'INSTANT
   *  PRÉSENT (la AD/Dec stockée à l'enregistrement ne vaut que pour cet
   *  instant — l'horizontale tourne avec le ciel), puis GOTO via le RELAIS
   *  en MODE PARC : la cible à l'horizon (Home alt-az = tube horizontal)
   *  serait refusée par le chemin direct :Sr/:Sd/:MS ET par la garde basse
   *  normale du relais (marge 2°). Sans point Home : repli :hP# (Meade).
   *  Renvoie le vecteur utilisé + le statut GOTO (UI = gotoErrorText). */
  async parkToHome(): Promise<{via: 'home' | 'handbox'; status: GotoStatus}> {
    const home = useTelemetryStore.getState().points.find((p) => p.home) ?? null;
    if (!home || !this.drv.caps.relay) {
      // Sans point Home (ou protocole sans relais) : parc raquette historique
      if (!this.drv.caps.park || !this.drv.park) {
        throw new TransportError('Parc non disponible sur ce protocole');
      }
      await this.drv.park(this);
      return {via: 'handbox', status: 'ok'};
    }
    const st = useSettingsStore.getState();
    const geo = homeGeometry(useScopeStore.getState().alignMode, st.site.latDeg);
    const rd = altAzToRaDec(geo.altDeg, geo.azDeg, st.site.latDeg, st.site.lonDeg, new Date());
    this.log('info', `PARC : position Home (${geo.polar ? 'polaire' : 'tube horizontal'} alt ${geo.altDeg.toFixed(1)}° az ${geo.azDeg.toFixed(0)}°) — GOTO en cours`);
    const gen = ++this.relayGen; // single-flight : tue tout GOTO/relais en cours
    useScopeStore.getState().setGotoRunning(true);
    this.cmdPhase = true;
    try {
      const status = await this.gotoRaDecRelay(
        rd.raDeg, rd.decDeg, 'mute', new Date(), gen, {park: true});
      return {via: 'home', status};
    } finally {
      this.cmdPhase = false;
      useScopeStore.getState().setGotoRunning(false);
    }
  }

  /** ALIGNEMENT FORCÉ SUR HOME (v2.9.6) — préambule de la série de tests
   *  (« il faudrait qu'elle impose un alignement sur home avant de se
   *  lancer et qu'elle prenne cette position en compte pour les butées de
   *  test ») :
   *   1. GOTO de la position Home ⌂ par le RELAIS EN MODE PARC (identique
   *      à parkToHome — la cible est à l'horizon, seule une cible < −5°
   *      est refusée) ;
   *   2. À L'ARRIVÉE, les coordonnées de la position Home sont RECALCULÉES
   *      (l'horizontale tourne avec le ciel — celles du départ sont
   *      périmées de la durée du trajet) et posées dans la raquette par
   *      :Sr/:Sd/:CM# (syncRaDec) : la raquette croit désormais sincèrement
   *      que le tube est à la position Home physique → :Ga# redevient
   *      FIABLE pour les tests de butée (course restante, gardes) et le
   *      pointage repart d'une base réelle.
   *  Renvoie 'ok' | 'none' (pas de point Home / pas de relais) | 'nogoto'
   *  (arrivée Home échouée — pas de SYNC) | 'nosync' (GOTO ok, SYNC refusé
   *  ou muet). */
  async alignToHome(): Promise<'ok' | 'none' | 'nogoto' | 'nosync'> {
    const home = useTelemetryStore.getState().points.find((p) => p.home) ?? null;
    if (!home || !this.drv.caps.relay) return 'none';
    const st = useSettingsStore.getState();
    const geo = homeGeometry(useScopeStore.getState().alignMode, st.site.latDeg);
    const rd0 = altAzToRaDec(geo.altDeg, geo.azDeg, st.site.latDeg, st.site.lonDeg, new Date());
    this.log('info', `ALIGN. HOME : retour à la position Home enregistrée puis SYNC — ${
      geo.polar ? 'polaire' : 'tube horizontal'} alt ${geo.altDeg.toFixed(1)}° az ${geo.azDeg.toFixed(0)}°`);
    const gen = ++this.relayGen; // single-flight : tue tout GOTO/relais en cours
    useScopeStore.getState().setGotoRunning(true);
    this.cmdPhase = true;
    try {
      const status = await this.gotoRaDecRelay(
        rd0.raDeg, rd0.decDeg, 'mute', new Date(), gen, {park: true});
      if (status !== 'ok') return 'nogoto';
      // Coordonnées de la position Home RECALCULÉES À L'ARRIVÉE (le ciel a
      // tourné pendant le trajet — le SYNC doit décrire OÙ LE TUBE EST).
      const rd1 = altAzToRaDec(geo.altDeg, geo.azDeg, st.site.latDeg, st.site.lonDeg, new Date());
      const ok = await this.syncRaDec(rd1.raDeg, rd1.decDeg);
      if (ok) {
        this.log('info', 'ALIGN. HOME : raquette synchronisée sur la position Home — altitude (:Ga#) fiable pour les butées');
      } else {
        this.log('error', 'ALIGN. HOME : SYNC refusé ou muet — les butées garderont la course théorique du preset');
      }
      return ok ? 'ok' : 'nosync';
    } finally {
      this.cmdPhase = false;
      useScopeStore.getState().setGotoRunning(false);
    }
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
      // PHASE DE COMMANDES CRITIQUES (GOTO/SYNC, v2.1.1) : la ligne série
      // est réservée à la séquence :Sr/:Sd/:MS — aucun :ED#/:Gr# intercalé
      if (this.cmdPhase) return;
      // priorité aux commandes utilisateur : on laisse la main un instant
      if (Date.now() < this.priorityUntil) return;
      this.pollBusy = true;
      try {
        const s0 = useScopeStore.getState();
        const live = s0.hbSync === 'live' && this.drv.caps.lcdMirror;
        // MIROIR LCD (v1.8.1, Meade uniquement) : :ED# à chaque tick en
        // synchro live — le littéral de l'écran de la raquette physique
        // prime sur toute reconstruction. Repli : si la raquette ne connaît
        // pas :ED# (6 échecs de suite), l'écran télémétrie reprend la main.
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
            // v2.1.2 : les échecs :ED# PENDANT un moteur (raquette muette sur
            // la ligne série pendant un slew — y compris un GOTO lancé par
            // l'app) ne comptent PAS dans le compteur « raquette sans :ED# » :
            // 6 échecs en 3 s de slew effaçaient le miroir et journalisaient
            // « miroir par télémétrie » — de quoi croire la connexion perdue.
            if (!this.isBusyNow()) this.lcdFail += 1;
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
            if (!this.isBusyNow()) this.failCount += 1;
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
    // MOUVEMENT INITIÉ PAR L'APP (GOTO lancé depuis Objets/Alignement,
    // impulsions du suivi télémétrique…) : le mutisme de la raquette est
    // NORMAL et EXPLIQUÉ — aucun diagnostic « muette » ni sonde :GVP#
    // pendant toute la fenêtre ownMoveUntil. (v2.1.2)
    if (now < this.ownMoveUntil) {
      s.setHbHint('none');
      return;
    }
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
    if (!this.isBusyNow() && now - this.lastProbeAt > 10000) {
      this.lastProbeAt = now;
      this.cmd(this.drv.probe?.cmd ?? ':GVP#', 2500)
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

  /**
   * Lecture alt/az PONCTUELLE (:Ga#/:Gz#) pour les diagnostics — indépendante
   * du polling. Renvoie null si la raquette ne répond pas à ces commandes.
   */
  readAltAz(): Promise<{altDeg: number; azDeg: number} | null> {
    return this.pollAltAz();
  }

  private async pollAltAz(): Promise<{altDeg: number; azDeg: number} | null> {
    if (!this.drv.caps.altAz || !this.drv.readAltAz) return null;
    const aa = await this.drv.readAltAz(this).catch(() => null);
    if (aa) useScopeStore.getState().setAltAz(aa.altDeg, aa.azDeg);
    return aa;
  }

  private stopPoll() {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}


/** Instance unique partagée. */
export const autostar = new AutostarClient();

// import en fin de fichier pour éviter la dépendance circulaire
import {handboxSync} from './handboxSync';
