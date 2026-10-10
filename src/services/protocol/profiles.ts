/** Profils de raquettes Meade — compatibilité multi-générations. */
import type {ScopeModelId} from '../../store/settingsStore';

export interface ScopeProfile {
  id: ScopeModelId;
  productReply: string;   // réponse à :GVP#
  wake: boolean;          // séquence ESC ESC au démarrage (mode PC série)
  supports: {
    serial: boolean;       // port série natif (#494 : absent)
    setDateTime: boolean;  // :SC/:SL/:SG
    setSite: boolean;      // :Sg/:St
    alignCmds: boolean;    // :Aa..:Ae
    focus: boolean;        // :F+/:F-
    pec: boolean;          // correction périodique d'erreur
    home: boolean;         // capteurs home (LX200GPS)
    gps: boolean;          // GPS interne (LX200GPS/RMS)
  };
  hints: string;           // note d'usage (i18n clé libre)
}

export const PROFILES: Record<ScopeModelId, ScopeProfile> = {
  autostar2: {
    id: 'autostar2',
    productReply: 'Autostar II',
    wake: false,
    supports: {
      serial: true, setDateTime: true, setSite: true, alignCmds: true,
      focus: true, pec: true, home: true, gps: true,
    },
    hints: 'LX200GPS/RMS : liaison Wi-Fi ou USB 9600 bauds, pas de séquence ESC.',
  },
  autostar497: {
    id: 'autostar497',
    productReply: 'Autostar',
    wake: true,
    supports: {
      serial: true, setDateTime: true, setSite: true, alignCmds: false,
      focus: true, pec: true, home: false, gps: false,
    },
    hints: 'ETX/LX90 : envoyer ESC ESC à la mise sous tension pour le mode PC série.',
  },
  autostar495: {
    id: 'autostar495',
    productReply: 'Autostar',
    wake: true,
    supports: {
      serial: true, setDateTime: true, setSite: true, alignCmds: false,
      focus: true, pec: false, home: false, gps: false,
    },
    hints: 'Identique au #497 mais sans guidage PEC.',
  },
  autostar494: {
    id: 'autostar494',
    productReply: 'Autostar',
    wake: true,
    supports: {
      serial: false, setDateTime: true, setSite: true, alignCmds: false,
      focus: false, pec: false, home: false, gps: false,
    },
    hints: 'Le #494 d’origine n’a pas de port série : utilisez le mode Démo ou un câble AUX modifié.',
  },
  lx200: {
    id: 'lx200',
    productReply: 'Meade LX200',
    wake: false,
    supports: {
      serial: true, setDateTime: true, setSite: true, alignCmds: false,
      focus: true, pec: true, home: false, gps: false,
    },
    hints: 'LX200 classique : 9600 ou 1200 bauds selon la révision.',
  },
};

export const SPEED_CMDS = {
  guide: ':RG#',
  center: ':RC#',
  find: ':RM#',
  slew: ':RS#',
} as const;
