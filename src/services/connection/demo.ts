/**
 * Transport Démo : boucle locale vers un télescope simulé dont le firmware
 * (:GVP#/:GVN#) reflète le modèle choisi à la connexion — la détection et
 * le mappage automatique du clavier s'exercent donc aussi en démo.
 */
import type {ConnectOptions, Transport, TransportType} from './types';
import type {ScopeModelId} from '../../store/settingsStore';
import {DemoScopeBrain} from '../protocol/demoScope';

/** Cerveau partagé (une seule démo à la fois, usage interne du module). */
let demoBrain: DemoScopeBrain | null = null;

export function setDemoSite(latDeg: number, lonDeg: number) {
  demoBrain?.setSiteForDemo({latDeg, lonDeg});
}

export class DemoTransport implements Transport {
  readonly type: TransportType = 'demo';
  private dataCb: ((chunk: string) => void) | null = null;
  private closedCb: (() => void) | null = null;
  private connected = false;
  /** Réponses simulées en attente, annulées à la déconnexion. */
  private timers = new Set<number>();

  constructor(private model: ScopeModelId = 'autostar2') {}

  onData(cb: (chunk: string) => void) {this.dataCb = cb;}
  onError(_cb: (msg: string) => void) {/* aucune erreur asynchrone en démo */}
  onClosed(cb: () => void) {this.closedCb = cb;}
  isConnected() {return this.connected;}

  connect(_opts: ConnectOptions): Promise<void> {
    demoBrain = new DemoScopeBrain();
    demoBrain.setFirmwareForDemo(this.model);
    this.connected = true;
    return Promise.resolve();
  }

  async write(data: string): Promise<void> {
    if (!this.connected || !demoBrain) return;
    // Petit délai pour simuler la latence série
    const id = setTimeout(() => {
      this.timers.delete(id);
      const reply = demoBrain?.handle(data);
      if (reply) this.dataCb?.(reply);
    }, 12 + Math.random() * 18) as unknown as number;
    this.timers.add(id);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.timers.forEach((id) => clearTimeout(id));
    this.timers.clear();
    demoBrain = null;
    this.closedCb?.();
  }
}
