/**
 * Bouton ARRÊTER LE GOTO (v2.9.2 — « j'ai aucun moyen de l'arrêter »).
 *
 * Visible UNIQUEMENT pendant un GOTO (direct ou relais boucle fermée —
 * `scopeStore.gotoRunning`) : coupe les moteurs immédiatement (:Q#) et tue
 * le relais en ≤ 250 ms via `autostar.abortGoto()`. Intégré au StatusHeader
 * (tous les écrans) — on peut arrêter un pointage lancé depuis n'importe
 * quel onglet, même en changeant d'écran pendant le déplacement.
 */
import {TouchableOpacity, Text} from 'react-native';
import {useScopeStore} from '../store/scopeStore';
import {autostar} from '../services/protocol/client';
import {useT} from '../i18n';
import {usePal} from './ui';

export function GotoAbortButton() {
  const gotoRunning = useScopeStore((s) => s.gotoRunning);
  const t = useT();
  const c = usePal();
  if (!gotoRunning) return null;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={() => { autostar.abortGoto().catch(() => undefined); }}
      style={{
        backgroundColor: c.red, borderRadius: 10, borderWidth: 1, borderColor: c.red,
        paddingHorizontal: 12, paddingVertical: 6, marginRight: 8,
      }}>
      <Text style={{color: '#FFFFFF', fontWeight: '800', fontSize: 12}}>
        ■ {t.common.stop} GOTO
      </Text>
    </TouchableOpacity>
  );
}
