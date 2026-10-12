/**
 * Carte « Monture » de l'onglet Alignement (v2.7.0) — la SÉLECTION se fait
 * désormais dans l'onglet dédié « Montures » (catalogue marque → modèle +
 * saisie manuelle) : plus de puces redondantes ici. Cette carte garde ce
 * qui est contextuel à l'alignement : le rappel du preset mécanique actif
 * (butées, taux, jeu — utilisés par le diagnostic) et la détection de la
 * raquette (:GVP#/:GVN# — hypothèse seulement, Meade n'expose pas la
 * monture choisie dans ses menus en série).
 */
import {useState} from 'react';
import {View, Text, TouchableOpacity} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {autostar} from '../services/protocol/client';
import {activePreset} from '../services/mounts/catalog';
import {Card, Title, usePal, s} from './ui';

export function MountCard() {
  const t = useT();
  const c = usePal();
  const mx = t.align.mount;
  const brandId = useSettingsStore((st) => st.mountBrandId);
  const modelId = useSettingsStore((st) => st.mountModelId);
  const customMount = useSettingsStore((st) => st.customMount);
  const mountPreset = useSettingsStore((st) => st.mountPreset);
  const connStatus = useScopeStore((st) => st.connStatus);
  const fwProduct = useScopeStore((st) => st.fwProduct);
  const fwModel = useScopeStore((st) => st.fwModel);
  const driverId = useScopeStore((st) => st.driverId);
  const [busy, setBusy] = useState(false);
  const isMeade = (driverId ?? 'meade') === 'meade';

  const active = activePreset(brandId, modelId, customMount, fwModel, mountPreset);

  const detect = async () => {
    setBusy(true);
    try {
      await autostar.detectFirmware(); // met à jour fwModel + le preset déduit
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{marginTop: 8}}>
      <Title text={mx.title} />
      <View style={[s.row, s.between, {marginTop: 4}]}>
        <Text style={{color: c.textDim, fontSize: 13, flex: 1, lineHeight: 19}}>{mx.intro}</Text>
        {connStatus === 'connected' && isMeade ? (
          <TouchableOpacity onPress={detect} disabled={busy}>
            <Text style={{color: c.blue, fontSize: 12, fontWeight: '700', marginLeft: 8}}>
              {busy ? '…' : mx.detect}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {connStatus === 'connected' && !isMeade ? (
        <Text style={{color: c.blue, fontSize: 11, marginTop: 5, fontWeight: '700'}}>
          {autostar.drv.label} — {autostar.drv.brands}
        </Text>
      ) : (
        <Text style={{color: c.textFaint, fontSize: 11, marginTop: 5, lineHeight: 16}}>{mx.notExposed}</Text>
      )}

      <View style={{backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.border, padding: 10, marginTop: 8}}>
        <Text style={{color: c.amber, fontSize: 13, fontWeight: '700'}}>
          {active.label}
          {fwProduct ? <Text style={{color: c.textFaint, fontWeight: '400', fontSize: 11}}>  ·  {fwProduct}</Text> : null}
        </Text>
        <Text style={{color: c.textDim, fontSize: 12, marginTop: 3, lineHeight: 17}}>
          {mx.limits} {active.minAltDeg}° → {active.maxAltDeg}°  ·  {mx.rates}{' '}
          {active.expectedRates.center.toFixed(2)}/{active.expectedRates.find.toFixed(1)}/{active.expectedRates.slew.toFixed(1)}°/s
          {'  ·  '}AL {active.altaz ? mx.altaz : mx.polar}
        </Text>
        <Text style={{color: c.textFaint, fontSize: 11, marginTop: 4}}>
          {t.connect.mountHint} — {t.tabs.mounts}
        </Text>
      </View>
    </Card>
  );
}
