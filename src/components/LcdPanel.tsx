/** Afficheur LCD style Autostar II (2 lignes de 16 caractères). */
import {View, Text} from 'react-native';
import {usePal} from './ui';

export function LcdPanel({line1, line2, height = 96}: {line1: string; line2: string; height?: number}) {
  const c = usePal();
  const fix = (s: string) => (s.length > 16 ? s.slice(0, 16) : s.padEnd(16, ' '));
  return (
    <View style={{
      backgroundColor: c.lcdBg, borderRadius: 10, borderWidth: 2, borderColor: c.border,
      height, justifyContent: 'center', paddingHorizontal: 12,
    }}>
      <Text style={{color: c.lcdText, fontFamily: 'monospace', fontSize: 18, letterSpacing: 2}}>
        {fix(line1)}
      </Text>
      <Text style={{color: c.lcdText, fontFamily: 'monospace', fontSize: 18, letterSpacing: 2}}>
        {fix(line2)}
      </Text>
    </View>
  );
}
