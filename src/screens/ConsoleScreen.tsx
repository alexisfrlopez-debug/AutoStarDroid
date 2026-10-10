/** Console protocole : trafic série envoyé/reçu en direct. */
import {useMemo} from 'react';
import {FlatList, Text, View} from 'react-native';
import {useT} from '../i18n';
import {useScopeStore} from '../store/scopeStore';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, usePal} from '../components/ui';

export function ConsoleScreen() {
  const t = useT();
  const c = usePal();
  const log = useScopeStore((s) => s.log);
  const clearLog = useScopeStore((s) => s.clearLog);
  // Le log du store est chronologique ; on l'affiche du plus récent au plus ancien.
  const rows = useMemo(() => [...log].reverse(), [log]);

  const colorOf = (dir: string) =>
    dir === 'sent' ? c.blue : dir === 'recv' ? c.green : dir === 'error' ? c.red : c.textDim;

  return (
    <View style={{flex: 1, backgroundColor: c.bg}}>
      <StatusHeader />
      <View style={{flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center'}}>
        <Text style={{color: c.text, fontWeight: '700', flex: 1}}>{t.console.title}</Text>
        <Btn label={t.console.clear} variant="ghost" onPress={clearLog} style={{paddingVertical: 6, paddingHorizontal: 12}} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(item, i) => `${item.ts}_${item.dir}_${item.text}_${i}`}
        style={{flex: 1}}
        contentContainerStyle={{padding: 12}}
        ListEmptyComponent={<Text style={{color: c.textFaint, textAlign: 'center', marginTop: 30}}>{t.console.empty}</Text>}
        renderItem={({item}) => (
          <View style={{flexDirection: 'row', marginBottom: 3}}>
            <Text style={{color: c.textFaint, fontFamily: 'monospace', fontSize: 11, width: 74}}>
              {new Date(item.ts).toLocaleTimeString()}
            </Text>
            <Text style={{color: colorOf(item.dir), fontFamily: 'monospace', fontSize: 12, width: 42, fontWeight: '700'}}>
              {item.dir === 'sent' ? '>>>' : item.dir === 'recv' ? '<<<' : item.dir === 'error' ? 'ERR' : 'INF'}
            </Text>
            <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 12, flex: 1}}>{item.text}</Text>
          </View>
        )}
      />
    </View>
  );
}
