/** Transport Wi-Fi TCP (pont Wi-Fi du télescope) via react-native-tcp-socket. */
import TcpSocket from 'react-native-tcp-socket';
type TcpSocketT = ReturnType<typeof TcpSocket.createConnection>;
import type {ConnectOptions, Transport, TransportType} from './types';
import {TransportError} from './types';

export class TcpTransport implements Transport {
  readonly type: TransportType = 'wifi';
  private socket: TcpSocketT | null = null;
  private dataCb: ((chunk: string) => void) | null = null;
  private errCb: ((msg: string) => void) | null = null;
  private closedCb: (() => void) | null = null;
  private connected = false;

  onData(cb: (chunk: string) => void) {this.dataCb = cb;}
  onError(cb: (msg: string) => void) {this.errCb = cb;}
  onClosed(cb: () => void) {this.closedCb = cb;}
  isConnected() {return this.connected;}

  connect(opts: ConnectOptions): Promise<void> {
    const w = opts.wifi;
    if (!w) return Promise.reject(new TransportError('Options Wi-Fi manquantes'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = TcpSocket.createConnection({host: w.host, port: w.port}, () => {
        if (settled) return;
        settled = true;
        this.connected = true;
        resolve();
      });
      this.socket = socket;
      socket.on('error', (e: Error) => {
        if (!settled) {
          settled = true;
          this.connected = false;
          reject(new TransportError(e.message || 'Connexion TCP impossible'));
        }
        this.errCb?.(e.message);
      });
      socket.on('data', (data: string | Uint8Array) => {
        const s = typeof data === 'string' ? data : this.u8ToAscii(data);
        this.dataCb?.(s);
      });
      socket.on('close', () => {
        this.connected = false;
        this.closedCb?.();
      });
    });
  }

  async write(data: string): Promise<void> {
    if (!this.socket || !this.connected) throw new TransportError('Socket fermé');
    this.socket.write(data);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {this.socket?.destroy();} catch (_) {}
    this.socket = null;
  }

  private u8ToAscii(b: Uint8Array): string {
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
}
