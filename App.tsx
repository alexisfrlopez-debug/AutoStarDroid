import {StatusBar} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {RootNavigator} from './src/navigation/RootNavigator';
import {useSettingsStore} from './src/store/settingsStore';
import {ErrorBoundary} from './src/ErrorBoundary';

export default function App() {
  const nv = useSettingsStore((s) => s.nightVision);
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={nv ? '#000000' : '#05070D'} />
        <RootNavigator />
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
