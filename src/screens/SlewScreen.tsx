/** Écran Visserie : pad directionnel + vitesses + mise au point. */
import {ScrollView, View, Text} from 'react-native';
import {useT} from '../i18n';
import {autostar} from '../services/protocol/client';
import {DirectionPad} from '../components/DirectionPad';
import {SpeedSelector} from '../components/SpeedSelector';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, Card, Title, usePal} from '../components/ui';

export function SlewScreen() {
  const t = useT();
  const c = usePal();

  return (
    <ScrollView style={{flex: 1, backgroundColor: c.bg}} contentContainerStyle={{padding: 12, paddingBottom: 40}}>
      <StatusHeader />
      <Card style={{marginTop: 8}}>
        <Title text={t.slew.speed} />
        <SpeedSelector />
        <Text style={{color: c.textFaint, fontSize: 12, textAlign: 'center', marginTop: 10}}>
          {t.slew.holdHint}
        </Text>
      </Card>

      <Card style={{marginTop: 12, alignItems: 'center'}}>
        <DirectionPad
          onStart={(d) => autostar.startMove(d).catch(() => {})}
          onStop={(d) => autostar.stopMove(d).catch(() => {})}
        />
      </Card>

      <Btn label={t.slew.stopAll} variant="danger" onPress={() => autostar.stopAll().catch(() => {})}
        style={{marginTop: 12}} />

      <Card style={{marginTop: 12}}>
        <Title text={t.slew.focus} />
        <View style={{flexDirection: 'row'}}>
          <Btn label={`− ${t.slew.focusIn}`} onPress={() => autostar.focusStart(true)} style={{flex: 1, marginRight: 6}} />
          <Btn label={`+ ${t.slew.focusOut}`} onPress={() => autostar.focusStart(false)} style={{flex: 1, marginLeft: 6}} />
        </View>
        <Btn label={t.slew.focusStop} variant="ghost" onPress={() => autostar.focusStop().catch(() => {})}
          style={{marginTop: 8}} />
      </Card>
    </ScrollView>
  );
}
