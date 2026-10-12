/**
 * Driver SKY-WATCHER SynScan (v2.6.0) — AZ-GTi, Star Discovery, HEQ5-Pro,
 * EQ6-R, EQM-35… Les raquettes SynScan (v4/v5) acceptent le JEU NEXSTAR :
 * position 'e'/'E', GOTO 'r'/'R', sync 's'/'S', stop 'M', fin de GOTO 'L',
 * flèches passthrough AUX 0x50, tracking 't'/'T'.
 *
 * Hérite intégralement du driver Celestron (mêmes octets, mêmes ACK) avec
 * l'identité de marque et une détection dédiée : la raquette SynScan répond
 * aussi à 'V', la distinction se fait sur le modèle ('m' → chiffre SynScan)
 * et sur le choix explicite de l'utilisateur dans l'onglet Connexion.
 * Équatorial par défaut (les SynScan sont majoritairement sur montures EQ) : le
 * mode d'axes est re-déduit du tracking réel à la première lecture ('t').
 */
import {
  registerDriver,
  type TelescopeDriver,
} from '../driver';
import {NexStarDriver} from './nexstar';

export class SynScanDriver extends NexStarDriver {
  constructor() {
    super(
      'skywatcher',
      'Sky-Watcher SynScan',
      'Sky-Watcher (AZ-GTi, Star Discovery, HEQ5-Pro, EQ6-R…)',
    );
    // Montures SynScan majoritairement équatoriales : axes N/S = DEC tant
    // que le tracking réel n'a pas dit le contraire (refreshAxisMode).
    (this as unknown as {axisMode: 'altaz' | 'eq'}).axisMode = 'eq';
  }
}

export const SYNSCAN_DRIVER: TelescopeDriver = new SynScanDriver();
registerDriver(SYNSCAN_DRIVER);
