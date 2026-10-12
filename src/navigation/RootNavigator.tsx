/** Navigation racine : onglets bas (Raquette = interface unique du matériel). */
import React, {useEffect} from 'react';
import {NavigationContainer, DefaultTheme} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {Text} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {theme} from '../theme/colors';
import {ErrorBoundary} from '../ErrorBoundary';
import {MainScreen} from '../screens/MainScreen';
import {ObjectScreen} from '../screens/ObjectScreen';
import {SkyScreen} from '../screens/SkyScreen';
import {CameraScreen} from '../screens/CameraScreen';
import {AlignScreen} from '../screens/AlignScreen';
import {MountsScreen} from '../screens/MountsScreen';
import {ServicesScreen} from '../screens/ServicesScreen';
import {SetupScreen} from '../screens/SetupScreen';
import {ConnectScreen} from '../screens/ConnectScreen';
import {HandboxScreen} from '../screens/HandboxScreen';
import {ConsoleScreen} from '../screens/ConsoleScreen';
import {initFineTune} from '../services/tracking/fineTune';
import {initGotoMonitor} from '../services/tracking/gotoMonitor';

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

const TabIcon = ({glyph, focused, color}: {glyph: string; focused: boolean; color: string}) => (
  <Text style={{fontSize: 18, color, opacity: focused ? 1 : 0.55, marginTop: 2}}>{glyph}</Text>
);

/** Chaque écran est sous son propre filet : une erreur n'efface que l'écran.
 *  Les props (navigation…) sont intégralement transmis à l'écran enveloppé. */
const guarded = <P extends object>(zone: string, Component: React.ComponentType<P>) => {
  const Wrapped = (props: P) => (
    <ErrorBoundary zone={zone}>
      <Component {...props} />
    </ErrorBoundary>
  );
  Wrapped.displayName = `Guarded(${zone})`;
  return Wrapped;
};

function MainTabs() {
  const t = useT();
  const nv = useSettingsStore((s) => s.nightVision);
  const c = theme(nv);
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {backgroundColor: c.bgPanel, borderTopColor: c.border, height: 56, paddingBottom: 6, paddingTop: 2},
        tabBarActiveTintColor: c.amber,
        tabBarInactiveTintColor: c.textDim,
        tabBarLabelStyle: {fontSize: 10, fontWeight: '600'},
      }}>
      <Tabs.Screen name="Main" component={guarded('Main', MainScreen)}
        options={{tabBarLabel: t.tabs.main, tabBarIcon: ({color, focused}) => <TabIcon glyph="◈" focused={focused} color={color} />}} />
      <Tabs.Screen name="Objects" component={guarded('Objets', ObjectScreen)}
        options={{tabBarLabel: t.tabs.objects, tabBarIcon: ({color, focused}) => <TabIcon glyph="✦" focused={focused} color={color} />}} />
      <Tabs.Screen name="Sky" component={guarded('Ciel', SkyScreen)}
        options={{tabBarLabel: t.tabs.sky, tabBarIcon: ({color, focused}) => <TabIcon glyph="☾" focused={focused} color={color} />}} />
      <Tabs.Screen name="Camera" component={guarded('Caméra', CameraScreen)}
        options={{tabBarLabel: t.tabs.camera, tabBarIcon: ({color, focused}) => <TabIcon glyph="▣" focused={focused} color={color} />}} />
      <Tabs.Screen name="Align" component={guarded('Alignement', AlignScreen)}
        options={{tabBarLabel: t.tabs.align, tabBarIcon: ({color, focused}) => <TabIcon glyph="◎" focused={focused} color={color} />}} />
      <Tabs.Screen name="Mounts" component={guarded('Montures', MountsScreen)}
        options={{tabBarLabel: t.tabs.mounts, tabBarIcon: ({color, focused}) => <TabIcon glyph="⌾" focused={focused} color={color} />}} />
      <Tabs.Screen name="Services" component={guarded('Services', ServicesScreen)}
        options={{tabBarLabel: t.tabs.services, tabBarIcon: ({color, focused}) => <TabIcon glyph="⌖" focused={focused} color={color} />}} />
      <Tabs.Screen name="Handbox" component={guarded('Raquette', HandboxScreen)}
        options={{tabBarLabel: t.tabs.handbox, tabBarIcon: ({color, focused}) => <TabIcon glyph="▤" focused={focused} color={color} />}} />
      <Tabs.Screen name="Setup" component={guarded('Réglages', SetupScreen)}
        options={{tabBarLabel: t.tabs.setup, tabBarIcon: ({color, focused}) => <TabIcon glyph="⚙" focused={focused} color={color} />}} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const nv = useSettingsStore((s) => s.nightVision);
  const c = theme(nv);
  // Réglage fin télémétrique après GOTO (v2.2.0) + moniteur de contrôle
  // croisé télémétrie/moteurs (v2.3.0) : abonnés UNE fois pour toute la
  // session, quel que soit l'onglet d'où part le pointage.
  useEffect(() => {
    initFineTune();
    initGotoMonitor();
  }, []);
  const navTheme = {
    ...DefaultTheme,
    dark: true,
    colors: {
      ...DefaultTheme.colors,
      background: c.bg,
      card: c.bgPanel,
      border: c.border,
      text: c.text,
      primary: c.amber,
      notification: c.orange,
    },
  };
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={{headerShown: false, animation: 'slide_from_right'}}>
        <Stack.Screen name="Home" component={MainTabs} />
        <Stack.Screen name="Connect" component={guarded('Connexion', ConnectScreen)} />
        <Stack.Screen name="Console" component={guarded('Console', ConsoleScreen)} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
