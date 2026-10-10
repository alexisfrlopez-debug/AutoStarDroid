/**
 * Écran Raquette : raquette virtuelle fidèle au matériel + mise en station
 * assistée par les capteurs du téléphone (GPS, boussole, accéléromètre).
 */
import {useState} from 'react';
import {ScrollView, View} from 'react-native';
import {useT} from '../i18n';
import {StatusHeader} from '../components/StatusHeader';
import {Card, Title, Segmented, usePal} from '../components/ui';
import {VirtualHandbox} from '../components/VirtualHandbox';
import {MiseEnStation} from '../components/MiseEnStation';

type ViewId = 'keypad' | 'station';

export function HandboxScreen() {
  const t = useT();
  const c = usePal();
  const [view, setView] = useState<ViewId>('keypad');
  return (
    <ScrollView style={{flex: 1, backgroundColor: c.bg}} contentContainerStyle={{padding: 12, paddingBottom: 40}}>
      <StatusHeader />
      <Card style={{marginTop: 8}}>
        <Title text={t.hb.title} />
        <Segmented<ViewId>
          options={[
            {key: 'keypad', label: t.hb.tabKeypad},
            {key: 'station', label: t.hb.tabStation},
          ]}
          value={view}
          onChange={setView}
        />
        <View style={{marginTop: 12}}>
          {view === 'keypad' ? <VirtualHandbox /> : <MiseEnStation />}
        </View>
      </Card>
    </ScrollView>
  );
}
