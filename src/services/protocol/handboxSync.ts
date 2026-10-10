/**
 * handboxSync — synchronisation temps réel entre la raquette virtuelle et la
 * raquette physique.
 *
 * Quand la synchro est ACTIVE (« live », défaut dès la connexion) :
 *  - la position AD/DEC est relue en continu (500 ms) et le LCD de la
 *    raquette virtuelle affiche en permanence la même information que
 *    l'écran d'observation de la raquette physique ;
 *  - l'altitude/azimut est lue toutes les 2 s (:Ga/:Gz) ;
 *  - le mouvement de la raquette (slew physique ou suivi) est détecté et
 *    signalé (croix allumée + pastille ● PHYSIQUE).
 *
 * FIABILITÉ (v1.5.0) : la synchro NE TOMBE PLUS EN ERREUR quand la position
 * ne vient pas. Tant qu'aucune position n'arrive, le LCD affiche
 * « SYNCHRO LIVE / Attente position… » et le diagnostic (hbHint) explique
 * quoi vérifier ; la moindre position valide rétablit le miroir
 * instantanément — sans appui sur RELANCER, qui reste disponible :
 *  - appui court sur la pastille LIVE : DÉSACTIVER la synchro ;
 *  - appui long sur la pastille LIVE : RELANCER (flush + reprise).
 *
 * Note matériel : le protocole série Meade (#49x/LX200) ne permet pas de
 * lire le contenu littéral du LCD de la raquette physique ni ses touches —
 * la synchro reconstruit fidèlement son écran d'observation (RA/DEC, alt/az,
 * mouvements) à partir des télémétries du protocole, en temps réel.
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
    s.setHbHint('none');
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
    s.setHbHint('none');
    s.setHbMoving(false);
    s.setHbExternal(false);
    s.setHbDirs(null);
    autostar.setPollInterval(SYNC_SLOW_MS);
    autostar.setPollAltAz(false);
    s.pushLog('info', 'Synchro raquette temps réel désactivée');
  },

  /** Bascule ON/OFF selon l'état courant. */
  toggle() {
    if (useScopeStore.getState().hbSync === 'live') this.disable();
    else this.enable();
  },

  /** Relance la synchro : purge le diagnostic et repart en cadence rapide —
   *  utile après une raquette (re)branchée ou mise sous tension. */
  restart() {
    this.disable();
    this.enable();
  },

  /** Liaison tombée : remise à zéro silencieuse. */
  reset() {
    const s = useScopeStore.getState();
    s.setHbSync('off');
    s.setHbHint('none');
    s.setHbMoving(false);
    s.setHbExternal(false);
    s.setHbDirs(null);
    s.setHasPos(false);
    s.setAltAz(null, null);
  },
};
