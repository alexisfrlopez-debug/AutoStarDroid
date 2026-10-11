import {useEffect} from 'react';
import {Alert, StatusBar} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {RootNavigator} from './src/navigation/RootNavigator';
import {useSettingsStore} from './src/store/settingsStore';
import {ErrorBoundary} from './src/ErrorBoundary';

/** Affiche (une fois) la dernière erreur JS non interceptée consignée par le
 *  filet global de index.js — diagnostic sans adb : l'utilisateur peut faire
 *  une capture d'écran de l'alerte. */
async function offerLastJsError() {
  try {
    const AsyncStorageMod = await import('@react-native-async-storage/async-storage');
    const v = await AsyncStorageMod.default.getItem('autostardroid.lastJsError');
    if (!v) return;
    await AsyncStorageMod.default.removeItem('autostardroid.lastJsError');
    Alert.alert(
      'AutoStar Droid',
      'Une erreur interne a été consignée au dernier lancement.\n\n'
        + 'An internal error was recorded at the previous launch.\n\n'
        + v.slice(0, 700)
        + '\n\n— une capture d\u2019écran de ce message aide au diagnostic / a screenshot helps debugging',
      [{text: 'Fermer / Close'}],
      {cancelable: true},
    );
  } catch (_) {
    // jamais bloquant
  }
}

export default function App() {
  const nv = useSettingsStore((s) => s.nightVision);

  useEffect(() => {
    offerLastJsError();
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={nv ? '#000000' : '#05070D'} />
        <RootNavigator />
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
