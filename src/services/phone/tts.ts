/**
 * tts — synthèse vocale du Hand Control Panel (fonction « Speech Enable »
 * d'AutostarSuite : « everything displayed on your Autostar Handbox will be
 * spoken »). Pont vers le module natif Android NativeTts (TextToSpeech).
 *
 * Usage : quand l'option Voix est active, VirtualHandbox énonce le contenu
 * du LCD à chaque changement stabilisé (délai anti-répétition côté appelant).
 * speak() interrompt l'énoncé en cours (QUEUE_FLUSH) — pas d'empilement.
 */
import {NativeModules} from 'react-native';

const Tts = NativeModules.NativeTts as
  | {isAvailable: (p: (v: boolean) => void) => void; speak: (text: string, locale: string, p: (v: boolean) => void) => void; stop: (p: (v: boolean) => void) => void}
  | undefined;

export const tts = {
  async isAvailable(): Promise<boolean> {
    if (!Tts) return false;
    return new Promise<boolean>((resolve) => {
      try {Tts.isAvailable((v) => resolve(!!v));} catch (_) {resolve(false);}
    });
  },

  /** Énonce le texte ( coupe l'énoncé précédent ). Ne lève jamais. */
  async speak(text: string, lang: 'fr' | 'en'): Promise<void> {
    if (!Tts) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    try {await new Promise<void>((res) => Tts.speak(clean.slice(0, 200), lang === 'fr' ? 'fr-FR' : 'en-US', () => res()));} catch (_) {}
  },

  /** Silence immédiat (option coupée, écran quitté). */
  async stop(): Promise<void> {
    if (!Tts) return;
    try {await new Promise<void>((res) => Tts.stop(() => res()));} catch (_) {}
  },
};
