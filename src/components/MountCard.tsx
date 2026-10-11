/**
 * Carte « Monture » (v2.2.0 — demande utilisateur : « dans l'onglet
 * alignement, je voudrais pouvoir détecter automatiquement la monture pour
 * appliquer les presets adéquats, et choisir une autre monture si elle est
 * mal détectée »).
 *
 *  - DÉTECTION : relit :GVP#/:GVN# (autostar.detectFirmware) et propose le
 *    preset déduit de la raquette (suggestPresetForModel) ;
 *  - PRESETS : butées d'élévation, taux attendus, jeu typique, mode
 *    d'alignement suggéré — utilisés par le diagnostic (garde des butées,
 *    base des ratios) et l'affichage ;
 *  - CORRECTION MANUELLE : l'utilisateur choisit la monture exacte
 *    (ETX-90/105/125, LX90, LX200, générique) si la détection se trompe.
 */
import {useState} from 'react';
import {View, Text, TouchableOpacity} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {autostar} from '../services/protocol/client';
import {
  MOUNT_PRESETS,
  resolvePreset,
  suggestPresetForModel,
  type MountPresetId,
} from '../services/astro/mounts';
import {Card, Title, usePal, s} from './ui';

const PRESET_ORDER: Array<MountPresetId | 'auto'> = [
  'auto', 'etx90', 'etx105', 'etx125', 'lx90', 'lx200', 'generic',
];

export function MountCard() {
  const t = useT();
  const c = usePal();
  const mx = t.align.mount;
  const mountPreset = useSettingsStore((st) => st.mountPreset);
  const setMountPreset = useSettingsStore((st) => st.setMountPreset);
  const connStatus = useScopeStore((st) => st.connStatus);
  const fwProduct = useScopeStore((st) => st.fwProduct);
  const fwModel = useScopeStore((st) => st.fwModel);
  const [busy, setBusy] = useState(false);

  const active = resolvePreset(mountPreset, fwModel);
  const suggested = suggestPresetForModel(fwModel);

  const detect = async () => {
    setBusy(true);
    try {
      await autostar.detectFirmware(); // met à jour fwModel + le preset suggéré
    } finally {
      setBusy(false);
    }
  };

  const applySuggested = () => {
    setMountPreset('auto');
  };

  const chip = (key: MountPresetId | 'auto', label: string) => {
    const on = mountPreset === key;
    return (
      <TouchableOpacity
        key={key}
        onPress={() => setMountPreset(key)}
        style={{
          backgroundColor: on ? c.amber : c.bgPanel2,
          borderWidth: 1, borderColor: on ? c.amber : c.border, borderRadius: 14,
          paddingHorizontal: 10, paddingVertical: 5, marginRight: 6, marginBottom: 6,
        }}>
        <Text style={{color: on ? '#111' : c.text, fontSize: 12, fontWeight: '600'}}>{label}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <Card style={{marginTop: 8}}>
      <Title text={mx.title} />
      <View style={[s.row, s.between, {marginTop: 4}]}>
        <Text style={{color: c.textDim, fontSize: 13, flex: 1, lineHeight: 19}}>{mx.intro}</Text>
        {connStatus === 'connected' ? (
          <TouchableOpacity onPress={detect} disabled={busy}>
            <Text style={{color: c.blue, fontSize: 12, fontWeight: '700', marginLeft: 8}}>
              {busy ? '…' : mx.detect}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={[s.row, {marginTop: 8, flexWrap: 'wrap'}]}>
        {PRESET_ORDER.map((k) =>
          chip(k, k === 'auto' ? `${mx.auto}${fwModel ? ` (${MOUNT_PRESETS[suggested].label})` : ''}` : MOUNT_PRESETS[k].label),
        )}
      </View>

      <View style={{backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.border, padding: 10, marginTop: 6}}>
        <Text style={{color: c.amber, fontSize: 13, fontWeight: '700'}}>
          {active.label}
          {fwProduct ? <Text style={{color: c.textFaint, fontWeight: '400', fontSize: 11}}>  ·  {fwProduct}</Text> : null}
        </Text>
        <Text style={{color: c.textDim, fontSize: 12, marginTop: 3, lineHeight: 17}}>
          {mx.limits} {active.minAltDeg}° → {active.maxAltDeg}°  ·  {mx.rates}{' '}
          {active.expectedRates.center.toFixed(2)}/{active.expectedRates.find.toFixed(1)}/{active.expectedRates.slew.toFixed(1)}°/s
          {'  ·  '}AL {active.altaz ? mx.altaz : mx.polar}
        </Text>
        {mountPreset === 'auto' ? (
          <Text style={{color: c.textFaint, fontSize: 11, marginTop: 3}}>{mx.autoDesc}</Text>
        ) : (
          <TouchableOpacity onPress={applySuggested}>
            <Text style={{color: c.blue, fontSize: 11, marginTop: 3}}>{mx.backToAuto}</Text>
          </TouchableOpacity>
        )}
      </View>
    </Card>
  );
}
