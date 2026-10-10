/**
 * handboxSync — synchronisation temps réel entre la raquette virtuelle et la
 * raquette physique.
 *
 * Quand la synchro est ACTIVE (« live ») :
 *  - la position AD/DEC est relue sur la raquette toutes les 500 ms et le LCD
 *    de la raquette virtuelle affiche en continu la même information que
 *    l'écran d'observation de la raquette physique ;
 *  - l'altitude/azimut est lue toutes les 2 s (:Ga/:Gz) ;
 *  - le mouvement de la raquette (slew physique ou suivi) est détecté et
 *    signalé (hbMoving).
 *
 * Quand elle est DÉSACTIVÉE (« off »), le LCD reprend son menu local et le
 * polling repasse en mode fond (2 s) pour nourrir le reste de l'application.
 *
 * Si la raquette cesse de répondre (3 échecs consécutifs), la synchro passe
 * en « error » : l'utilisateur peut la relancer d'un appui sur le bouton
 * SYNCHRO de la raquette virtuelle.
 *
 * Note matériel : le protocole série Meade (#49x/LX200) ne permet pas de lire
 * le contenu littéral du LCD de la raquette physique — la synchro reconstitue
 * donc fidèlement son écran d'observation (RA/DEC) à partir des télémétries
 * du protocole, mises à jour en temps réel.
 */
import {autostar} from './client';
import {useScopeStore} from '../../store/scopeStore';

/** Cadence temps réel (synchro active). */
export const SYNC_FAST_MS = 500;
/** Cadence de fond (synchro désactivée) — nourrit le reste de l'app. */
export const SYNC_SLOW_MS = 2000;

export const handboxSync = {
  /** Active la synchro temps réel (nécessite une connexion établie). */
  enable(): boolean {
    const s = useScopeStore.getState();
    if (s.connStatus !== 'connected') return false;
    s.setHbError(null);
    s.setHbSync('live');
    autostar.setPollInterval(SYNC_FAST_MS);
    autostar.setPollAltAz(true);
    s.pushLog('info', 'Synchro raquette temps réel activée');
    return true;
  },

  /** Désactive la synchro temps réel (le LCD reprend le menu local). */
  disable() {
    const s = useScopeStore.getState();
    s.setHbSync('off');
    s.setHbMoving(false);
    autostar.setPollInterval(SYNC_SLOW_MS);
    autostar.setPollAltAz(false);
    s.pushLog('info', 'Synchro raquette temps réel désactivée');
  },

  /** Bascule ON/OFF selon l'état courant. */
  toggle() {
    if (useScopeStore.getState().hbSync === 'live') this.disable();
    else this.enable();
  },

  /** Relance la synchro (après une erreur, ou pour rafraîchir la liaison). */
  restart() {
    this.disable();
    this.enable();
  },

  /** Liaison tombée : remise à zéro silencieuse. */
  reset() {
    const s = useScopeStore.getState();
    s.setHbSync('off');
    s.setHbError(null);
    s.setHbMoving(false);
    s.setHbExternal(false);
    s.setHbDirs(null);
    s.setAltAz(null, null);
  },
};
