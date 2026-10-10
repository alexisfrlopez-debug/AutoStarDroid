/** Navigation racine : onglets bas + écrans empilés (Connexion, Raquette, Console). */
import {NavigationContainer, DefaultTheme} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {Text} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {theme} from '../theme/colors';
import {MainScreen} from '../screens/MainScreen';
import {SlewScreen} from '../screens/SlewScreen';
import {ObjectScreen} from '../screens/ObjectScreen';
import {AlignScreen} from '../screens/AlignScreen';
import {SetupScreen} from '../screens/SetupScreen';
import {ConnectScreen} from '../screens/ConnectScreen';
import {HandboxScreen} from '../screens/HandboxScreen';
import {ConsoleScreen} from '../screens/ConsoleScreen';

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

const TabIcon = ({glyph, focused, color}: {glyph: string; focused: boolean; color: string}) => (
  <Text style={{fontSize: 18, color, opacity: focused ? 1 : 0.55, marginTop: 2}}>{glyph}</Text>
);

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
      <Tabs.Screen name="Main" component={MainScreen}
        options={{tabBarLabel: t.tabs.main, tabBarIcon: ({color, focused}) => <TabIcon glyph="◈" focused={focused} color={color} />}} />
      <Tabs.Screen name="Slew" component={SlewScreen}
        options={{tabBarLabel: t.tabs.slew, tabBarIcon: ({color, focused}) => <TabIcon glyph="✥" focused={focused} color={color} />}} />
      <Tabs.Screen name="Objects" component={ObjectScreen}
        options={{tabBarLabel: t.tabs.objects, tabBarIcon: ({color, focused}) => <TabIcon glyph="✦" focused={focused} color={color} />}} />
      <Tabs.Screen name="Align" component={AlignScreen}
        options={{tabBarLabel: t.tabs.align, tabBarIcon: ({color, focused}) => <TabIcon glyph="◎" focused={focused} color={color} />}} />
      <Tabs.Screen name="Handbox" component={HandboxScreen}
        options={{tabBarLabel: t.tabs.handbox, tabBarIcon: ({color, focused}) => <TabIcon glyph="▤" focused={focused} color={color} />}} />
      <Tabs.Screen name="Setup" component={SetupScreen}
        options={{tabBarLabel: t.tabs.setup, tabBarIcon: ({color, focused}) => <TabIcon glyph="⚙" focused={focused} color={color} />}} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const nv = useSettingsStore((s) => s.nightVision);
  const c = theme(nv);
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
        <Stack.Screen name="Connect" component={ConnectScreen} />
        <Stack.Screen name="Console" component={ConsoleScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
