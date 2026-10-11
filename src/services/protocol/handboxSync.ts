/**
 * handboxSync — synchronisation temps réel entre la raquette virtuelle et la
 * raquette physique (Hand Control Panel, comportement du Remote Handbox
 * d'AutostarSuite).
 *
 * Quand la synchro est ACTIVE (« live », défaut dès la connexion) :
 *  - MIROIR LCD (v1.8.1) : l'écran 2×16 LITTÉRAL de la raquette physique est
 *    relu en continu par :ED# (2 Hz) et affiché tel quel — le protocole Meade
 *    le PERMET (extension raquette Autostar, prouvée matériellement par le
 *    log astropad du repo LX200emulator : une Autostar réelle répond
 *    0x97 + « Select Item:      Object         » + '#') ;
 *  - les touches VIRTUELLES simulent les touches PHYSIQUES (:EK<ascii>#) :
 *    la raquette réagit comme si on avait appuyé sur elle, et son écran
 *    (relu par :ED#) se répercute ici — miroir bidirectionnel ;
 *  - la position AD/DEC reste relue (1 tick sur 2) pour le reste de l'app,
 *    alt/az toutes les 2 s (:Ga/:Gz) ;
 *  - le mouvement de la raquette (slew physique) est détecté et signalé
 *    (croix allumée + pastille ● PHYSIQUE).
 *
 * REPLI : si la raquette ne connaît pas :ED# (LX200 classique), l'écran
 * télémétrie (AD/DEC, alt/az) reprend la main — aucun blocage.
 *
 * Synchro contrôlable (demande v1.5.0) :
 *  - appui court sur la pastille LIVE : DÉSACTIVER la synchro ;
 *  - appui long sur la pastille LIVE : RELANCER (flush + reprise).
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
    s.setHbSlewFast(false);
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
    s.setHbSlewFast(false);
    s.setHasPos(false);
    s.setAltAz(null, null);
    s.clearLcdMirror();
  },
};
