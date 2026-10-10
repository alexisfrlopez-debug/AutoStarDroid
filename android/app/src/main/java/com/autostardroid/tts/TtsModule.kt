package com.autostardroid.tts

import android.speech.tts.TextToSpeech
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReactApplicationContext
import java.util.Locale

/**
 * Module natif synthèse vocale pour Android (React Native).
 *
 * Fonction « Speech Enable » du Hand Control Panel d'AutostarSuite :
 * tout ce qui est affiché sur la raquette virtuelle peut être énoncé par le
 * téléphone (utile de nuit — plus besoin de quitter l'oculaire des yeux).
 *
 * API JS (src/services/phone/tts.ts) :
 *  - isAvailable()                     : moteur TTS présent ?
 *  - speak(text, locale)               : énonce le texte (coupe l'énoncé en cours)
 *  - stop()                            : silence immédiat
 *
 * Le moteur TextToSpeech est créé paresseusement et partagé ; chaque appel
 * à speak() utilise QUEUE_FLUSH : l'énoncé précédent est interrompu, ce qui
 * évite l'empilement quand l'affichage change vite (menus, télémétrie).
 */
class TtsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "NativeTts"
  }

  private var tts: TextToSpeech? = null
  private var ready = false
  private var pendingLocale: String? = null

  /** Crée le moteur une seule fois ; applique la langue dès l'initialisation. */
  private fun ensureEngine(localeTag: String?) {
    if (localeTag != null) pendingLocale = localeTag
    if (tts != null) return
    synchronized(this) {
      if (tts != null) return
      tts = TextToSpeech(reactApplicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
        if (ready) {
          applyLocale(pendingLocale)
        }
      }
    }
  }

  private fun applyLocale(localeTag: String?) {
    val engine = tts ?: return
    if (!ready || localeTag == null) return
    try {
      val loc = if (localeTag.startsWith("fr")) Locale.FRENCH else Locale.US
      engine.setLanguage(loc)
    } catch (_: Exception) {
    }
  }

  override fun getName() = NAME

  override fun onCatalystInstanceDestroy() {
    try {
      tts?.stop()
      tts?.shutdown()
    } catch (_: Exception) {}
    tts = null
    ready = false
  }

  @ReactMethod
  fun isAvailable(promise: Promise) {
    try {
      ensureEngine(null)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("TTS", e)
    }
  }

  @ReactMethod
  fun speak(text: String, locale: String, promise: Promise) {
    try {
      val engine = tts
      if (engine == null || !ready) {
        ensureEngine(locale)
        // premier énoncé pendant l'init (~100 ms) : accepté puis perdu —
        // l'affichage étant relu en continu, l'énoncé suivant repartira
        promise.resolve(false)
        return
      }
      applyLocale(locale)
      val clean = text.trim()
      if (clean.isEmpty()) {
        promise.resolve(false)
        return
      }
      engine.setSpeechRate(1.0f)
      engine.speak(clean, TextToSpeech.QUEUE_FLUSH, null, "asd-" + clean.hashCode())
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("TTS", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      tts?.stop()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("TTS", e)
    }
  }
}
