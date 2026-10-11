/** Types de la couche de transport (Wi-Fi / BT / USB / Démo). */
export type TransportType = 'wifi' | 'bluetooth' | 'usb' | 'demo';

export interface WifiOptions {host: string; port: number}
export interface BluetoothOptions {address: string}
/** Identité USB : deviceName COURANT + identité matérielle (VID/PID).
 *  VID/PID servent à retrouver l'adaptateur après une re-énumération
 *  (glitch de bus pendant un slew GOTO) — le deviceName change alors. */
export interface UsbOptions {deviceName: string; baud: number; vendorId?: number; productId?: number}

export interface ConnectOptions {
  wifi?: WifiOptions;
  bluetooth?: BluetoothOptions;
  usb?: UsbOptions;
}

export interface Transport {
  readonly type: TransportType;
  connect(opts: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  /** Écrit une chaîne ASCII vers le télescope. */
  write(data: string): Promise<void>;
  /** Données brutes entrantes (morceaux ASCII). */
  onData(cb: (chunk: string) => void): void;
  onError(cb: (msg: string) => void): void;
  onClosed(cb: () => void): void;
  isConnected(): boolean;
}

export class TransportError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TransportError';
  }
}
