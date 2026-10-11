/**
 * tts — synthèse vocale du Hand Control Panel (fonction « Speech Enable »
 * d'AutostarSuite : « everything displayed on your Autostar Handbox will be
 * spoken »). Pont vers le module natif Android NativeTts (TextToSpeech).
 *
 * Usage : quand l'option Voix est active, VirtualHandbox énonce le contenu
 * du LCD à chaque changement stabilisé (délai anti-répétition côté appelant).
 * speak() interrompt l'énoncé en cours (QUEUE_FLUSH) — pas d'empilement.
 *
 * ⚠️ RÈGLE DE SURVIE (crash v1.7.0/v1.7.1 — « JS Functions are not convertible
 * to dynamic ») : les méthodes natives sont PROMISE-BASED. Il ne faut JAMAIS
 * passer une fonction JS (callback) en argument d'un appel natif : dans le
 * bridge Hermes, TOUT le tableau d'arguments est sérialisé côté C++
 * (JSIDynamic.cpp) AVANT le filtrage Java — une fonction, même à une position
 * ignorée, tue l'application (exception non rattrapable par try/catch JS).
 * Résultat de la méthode : via la Promise retournée (`await Tts.methode(...)`).
 */
import {NativeModules} from 'react-native';

const Tts = NativeModules.NativeTts as
  | {
      isAvailable(): Promise<boolean>;
      speak(text: string, locale: string): Promise<boolean>;
      stop(): Promise<boolean>;
    }
  | undefined;

export const tts = {
  /** Moteur TTS présent ? (false si module natif absent — vieux build, iOS…) */
  async isAvailable(): Promise<boolean> {
    if (!Tts) return false;
    try {return !!(await Tts.isAvailable());} catch (_) {return false;}
  },

  /** Énonce le texte (coupe l'énoncé précédent). Ne lève jamais. */
  async speak(text: string, lang: 'fr' | 'en'): Promise<void> {
    if (!Tts) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    try {await Tts.speak(clean.slice(0, 200), lang === 'fr' ? 'fr-FR' : 'en-US');} catch (_) {}
  },

  /** Silence immédiat (option coupée, écran quitté). Ne lève jamais. */
  async stop(): Promise<void> {
    if (!Tts) return;
    try {await Tts.stop();} catch (_) {}
  },
};
