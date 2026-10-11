/** En-tête d'état de connexion (commun aux écrans). */
import {View, Text, TouchableOpacity} from 'react-native';
import {useScopeStore} from '../store/scopeStore';
import {useSettingsStore} from '../store/settingsStore';
import {useTrackingStore} from '../store/trackingStore';
import {useT} from '../i18n';
import {usePal} from './ui';

export function StatusHeader({onTap}: {onTap?: () => void}) {
  const c = usePal();
  const t = useT();
  const connStatus = useScopeStore((s) => s.connStatus);
  const transportType = useScopeStore((s) => s.transportType);
  const model = useScopeStore((s) => s.model);
  const tracking = useTrackingStore((s) => s.tracking);
  const trackTarget = useTrackingStore((s) => s.target);
  const trackErr = useTrackingStore((s) => s.lastErrArcmin);
  const modelName = useSettingsStore((st) => st.model);
  const current = model ?? modelName;
  const color = connStatus === 'connected' ? c.green : connStatus === 'connecting' ? c.orange : connStatus === 'error' ? c.red : c.textFaint;
  const label =
    connStatus === 'connected' ? t.common.connected :
    connStatus === 'connecting' ? t.common.connecting :
    connStatus === 'error' ? t.common.error : t.common.disconnected;
  return (
    <TouchableOpacity onPress={onTap} disabled={!onTap}
      style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 14}}>
      <View style={{flexDirection: 'row', alignItems: 'center'}}>
        <View style={{width: 10, height: 10, borderRadius: 5, backgroundColor: color, marginRight: 8}} />
        <Text style={{color: c.text, fontWeight: '700', fontSize: 14}}>{label}</Text>
        {transportType ? (
          <View style={{marginLeft: 8, backgroundColor: c.bgPanel2, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: c.border}}>
            <Text style={{color: c.textDim, fontSize: 10, fontWeight: '600', textTransform: 'uppercase'}}>{transportType}</Text>
          </View>
        ) : null}
        {/* Badge suivi télémétrique (v2.0.0) — visible sur tous les écrans. */}
        {tracking ? (
          <View style={{marginLeft: 8, backgroundColor: c.bgPanel2, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: c.green}}>
            <Text style={{color: c.green, fontSize: 10, fontWeight: '700'}}>
              ◉ {trackTarget?.name ?? ''}
              {trackErr != null ? ` ${trackErr < 1 ? '<1' : trackErr.toFixed(0)}′` : ''}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={{color: c.textDim, fontSize: 12}}>{t.models[current]}</Text>
    </TouchableOpacity>
  );
}
