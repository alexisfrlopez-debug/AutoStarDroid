/** Transport USB-série via module natif NativeUsbSerial (drivers FTDI/PL2303/CP210x/CH340). */
import {NativeEventEmitter, NativeModules} from 'react-native';
import {bytesToAscii, base64ToBytes, asciiToBytes, bytesToBase64} from './base64';
import type {ConnectOptions, Transport, TransportType} from './types';
import {TransportError} from './types';

export interface UsbDeviceInfo {
  deviceName: string;
  vendorId: number;
  productId: number;
  vendorHex: string;
  productHex: string;
  driver: string;
  brand: string;
}

/**
 * ⚠️ Toutes les méthodes natives sont basées sur Promise : côté JS on les appelle
 * SANS callbacks — `await USB.method(args)`. Passer des callbacks en plus provoquerait
 * une NativeArgumentsParseException côté natif.
 */
const USB = NativeModules.NativeUsbSerial as {
  listDevices(): Promise<UsbDeviceInfo[]>;
  requestPermission(deviceName: string): Promise<boolean>;
  open(deviceName: string, baud: number): Promise<boolean>;
  close(): Promise<boolean>;
  writeBase64(b64: string): Promise<boolean>;
  isConnected(): Promise<boolean>;
} | undefined;

interface UsbEvents {
  addListener(event: string, cb: (e?: {data?: string; message?: string; granted?: boolean}) => void): {remove(): void};
}

export const UsbSerialNative = {
  /** Liste des périphériques USB-série détectés ([] si module absent). */
  async listDevices(): Promise<UsbDeviceInfo[]> {
    if (!USB) return [];
    try {return (await USB.listDevices()) ?? [];} catch (_) {return [];}
  },
  /**
   * Demande la permission USB. Renvoie true si accordée (immédiatement ou via
   * l'événement usbPermission), false en cas de refus ou de délai dépassé.
   */
  async requestPermission(deviceName: string): Promise<boolean> {
    if (!USB) throw new TransportError('Module USB natif absent');
    let grantedNow = false;
    try {grantedNow = await USB.requestPermission(deviceName);} catch (_) {grantedNow = false;}
    if (grantedNow) return true;
    const emitter = new NativeEventEmitter(NativeModules.NativeUsbSerial) as unknown as UsbEvents;
    return new Promise<boolean>((resolve) => {
      const sub = emitter.addListener('usbPermission', (e) => {
        sub.remove();
        resolve(e?.granted === true);
      });
      setTimeout(() => {sub.remove(); resolve(false);}, 15000);
    });
  },
};

export class UsbTransport implements Transport {
  readonly type: TransportType = 'usb';
  private emitter: UsbEvents | null = null;
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
    const u = opts.usb;
    if (!u) throw new TransportError('Options USB manquantes');
    if (!USB) throw new TransportError('Module USB natif absent');
    try {
      await USB.open(u.deviceName, u.baud);
    } catch (e) {
      throw new TransportError(String((e as Error)?.message ?? e));
    }
    this.emitter = new NativeEventEmitter(NativeModules.NativeUsbSerial) as unknown as UsbEvents;
    this.subs.push(
      this.emitter.addListener('usbData', (e) => {
        if (e?.data) this.dataCb?.(bytesToAscii(base64ToBytes(e.data)));
      }),
    );
    this.subs.push(
      this.emitter.addListener('usbError', (e) => {
        this.errCb?.(e?.message ?? 'Erreur USB');
      }),
    );
    this.subs.push(
      this.emitter.addListener('usbDetached', () => {
        this.connected = false;
        this.closedCb?.();
      }),
    );
    this.connected = true;
  }

  async write(data: string): Promise<void> {
    if (!USB || !this.connected) throw new TransportError('USB non connecté');
    try {
      await USB.writeBase64(bytesToBase64(asciiToBytes(data)));
    } catch (e) {
      throw new TransportError('Échec écriture USB : ' + String((e as Error)?.message ?? e));
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    const subs = this.subs;
    this.subs = [];
    subs.forEach((s) => s.remove());
    this.emitter = null;
    try {await USB?.close();} catch (_) {}
  }
}
