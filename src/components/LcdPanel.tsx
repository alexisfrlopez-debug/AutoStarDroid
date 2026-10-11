/** Afficheur LCD style Autostar II (2 lignes de 16 caractères).
 *  v1.8.2 : taille réglable — l'onglet Raquette en affiche DEUX côte à côte
 *  (miroir de la raquette physique + AD/DEC permanent) dans un seul cadre. */
import {View, Text} from 'react-native';
import {usePal} from './ui';

export function LcdPanel({
  line1, line2, height = 96, fontSize = 18, letterSpacing = 2,
}: {
  line1: string;
  line2: string;
  height?: number;
  fontSize?: number;
  letterSpacing?: number;
}) {
  const c = usePal();
  const fix = (s: string) => (s.length > 16 ? s.slice(0, 16) : s.padEnd(16, ' '));
  return (
    <View style={{
      backgroundColor: c.lcdBg, borderRadius: 10, borderWidth: 2, borderColor: c.border,
      height, justifyContent: 'center', paddingHorizontal: 6,
    }}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{color: c.lcdText, fontFamily: 'monospace', fontSize, letterSpacing}}>
        {fix(line1)}
      </Text>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{color: c.lcdText, fontFamily: 'monospace', fontSize, letterSpacing}}>
        {fix(line2)}
      </Text>
    </View>
  );
}
