import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

/**
 * Filet de sécurité JS : enregistre toute erreur non interceptée (best-effort)
 * puis laisse le handler par défaut s'exécuter (crash capturé côté natif par
 * CrashReporter, qui produit le rapport partageable).
 */
try {
  const eu = globalThis.ErrorUtils;
  if (eu && eu.setGlobalHandler && eu.getGlobalHandler) {
    const previous = eu.getGlobalHandler();
    eu.setGlobalHandler((error, isFatal) => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage')
          .default;
        const err = error || {};
        const msg =
          '[' + new Date().toISOString() + '] ' +
          (isFatal ? 'FATAL ' : 'NON-FATAL ') +
          (err.message || String(error)) + '\n' + (err.stack || '');
        AsyncStorage.setItem('autostardroid.lastJsError', msg).catch(() => {});
      } catch (_e) {
        // silence : on ne doit jamais planter le handler d'erreurs
      }
      if (previous) {
        previous(error, isFatal);
      }
    });
  }
} catch (_e) {
  // silence
}

AppRegistry.registerComponent(appName, () => App);
