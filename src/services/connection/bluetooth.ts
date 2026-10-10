/** Transport Bluetooth SPP via module natif NativeBluetoothSpp (méthodes Promise). */
import {NativeEventEmitter, NativeModules} from 'react-native';
import {bytesToAscii, base64ToBytes, asciiToBytes, bytesToBase64} from './base64';
import type {ConnectOptions, Transport, TransportType} from './types';
import {TransportError} from './types';

export interface BtDeviceInfo {
  name: string;
  address: string;
  class: string;
}

/**
 * ⚠️ Toutes les méthodes natives sont basées sur Promise : côté JS on les appelle
 * SANS callbacks — `await BT.method(args)`. Passer des callbacks en plus provoquerait
 * une NativeArgumentsParseException côté natif.
 */
const BT = NativeModules.NativeBluetoothSpp as {
  isEnabled(): Promise<boolean>;
  enable(): Promise<boolean>;
  listBondedDevices(): Promise<Array<{name: string; address: string; class: string}>>;
  connect(addr: string): Promise<boolean>;
  disconnect(): Promise<boolean>;
  isConnected(): Promise<boolean>;
  writeBase64(b64: string): Promise<boolean>;
} | undefined;

/** Accès direct au module BT pour les écrans (liste des appareils appairés…). */
export const BluetoothSppNative = {
  /** Liste des appareils appairés ; rejette si permission BT absente ou BT éteint. */
  async listBondedDevices(): Promise<BtDeviceInfo[]> {
    if (!BT) return [];
    return (await BT.listBondedDevices()) ?? [];
  },
  async isEnabled(): Promise<boolean> {
    if (!BT) return false;
    try {return await BT.isEnabled();} catch (_) {return false;}
  },
};

interface BTEvents {
  addListener(event: 'btData', cb: (e: {data: string}) => void): {remove(): void};
  addListener(event: 'btDisconnected', cb: (e?: unknown) => void): {remove(): void};
  addListener(event: string, cb: (e?: unknown) => void): {remove(): void};
}

export class BluetoothTransport implements Transport {
  readonly type: TransportType = 'bluetooth';
  private emitter: BTEvents | null = null;
  private subs: Array<{remove(): void}> = [];
  private dataCb: ((chunk: string) => void) | null = null;
  private errCb: ((msg: string) => void) | null = null;
  private closedCb: (() => void) | null = null;
  private connected = false;

  onData(cb: (chunk: string) => void) {this.dataCb = cb;}
  onError(cb: (msg: string) => void) {this.errCb = cb;}
  onClosed(cb: () => void) {this.closedCb = cb;}
  isConnected() {return this.connected;}

  async connect(opts: ConnectOptions): Promise<void> {
    const b = opts.bluetooth;
    if (!b) throw new TransportError('Options Bluetooth manquantes');
    if (!BT) throw new TransportError('Module Bluetooth natif absent');
    let enabled = false;
    try {enabled = await BT.isEnabled();} catch (_) {enabled = false;}
    if (!enabled) throw new TransportError('Bluetooth désactivé — activez-le dans Android');
    try {
      await BT.connect(b.address);
    } catch (e) {
      throw new TransportError(String((e as Error)?.message ?? e));
    }
    this.emitter = new NativeEventEmitter(NativeModules.NativeBluetoothSpp) as unknown as BTEvents;
    this.subs.push(
      this.emitter.addListener('btData', (e) => {
        this.dataCb?.(bytesToAscii(base64ToBytes(e.data)));
      }),
    );
    this.subs.push(
      this.emitter.addListener('btDisconnected', () => {
        this.connected = false;
        this.errCb?.('Liaison Bluetooth interrompue');
        this.closedCb?.();
      }),
    );
    this.connected = true;
  }

  async write(data: string): Promise<void> {
    if (!BT || !this.connected) throw new TransportError('Bluetooth non connecté');
    try {
      await BT.writeBase64(bytesToBase64(asciiToBytes(data)));
    } catch (e) {
      throw new TransportError('Échec écriture BT : ' + String((e as Error)?.message ?? e));
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    const subs = this.subs;
    this.subs = [];
    subs.forEach((s) => s.remove());
    this.emitter = null;
    try {await BT?.disconnect();} catch (_) {}
  }
}
