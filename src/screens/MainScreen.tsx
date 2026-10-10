/** Écran Principal : position temps réel, actions rapides. */
import {useEffect, useState} from 'react';
import {ScrollView, View, Text, Alert} from 'react-native';
import {useT} from '../i18n';
import {useScopeStore} from '../store/scopeStore';
import {useSettingsStore} from '../store/settingsStore';
import {autostar} from '../services/protocol/client';
import {raDecToAltAz} from '../services/astro/coords';
import {raDegToHMS, decDegToDMS, lstDeg} from '../services/astro/time';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, Card, Readout, Title, usePal} from '../components/ui';

export function MainScreen({navigation}: {navigation: {navigate: (s: string) => void}}) {
  const t = useT();
  const c = usePal();
  const connStatus = useScopeStore((s) => s.connStatus);
  const raDeg = useScopeStore((s) => s.raDeg);
  const decDeg = useScopeStore((s) => s.decDeg);
  const targetName = useScopeStore((s) => s.targetName);
  const targetRaDeg = useScopeStore((s) => s.targetRaDeg);
  const targetDecDeg = useScopeStore((s) => s.targetDecDeg);
  const site = useSettingsStore((s) => s.site);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const aa = raDecToAltAz(raDeg, decDeg, site.latDeg, site.lonDeg, now);

  const gotoTarget = async () => {
    if (targetRaDeg === null || targetDecDeg === null) return;
    try {
      const r = await autostar.gotoRaDec(targetRaDeg, targetDecDeg);
      if (r !== 'ok') {
        Alert.alert(t.common.error,
          r === 'belowHorizon' ? t.objects.belowHorizon : r === 'noObject' ? t.objects.empty : t.errors.refused);
      }
    } catch (e) {
      Alert.alert(t.common.error, (e as Error).message);
    }
  };

  const syncPhone = async () => {
    try {
      await autostar.pushPhoneData(site.latDeg, site.lonDeg);
      Alert.alert(t.common.success, t.setup.synced);
    } catch (e) {
      Alert.alert(t.common.error, (e as Error).message);
    }
  };

  const connected = connStatus === 'connected';

  return (
    <ScrollView style={{flex: 1, backgroundColor: c.bg}} contentContainerStyle={{padding: 12, paddingBottom: 40}}>
      <StatusHeader onTap={() => navigation.navigate('Connect')} />
      {!connected ? (
        <Card style={{marginTop: 8}}>
          <Text style={{color: c.textDim, textAlign: 'center'}}>{t.main.notConnected}</Text>
        </Card>
      ) : null}

      <Card style={{marginTop: 8}}>
        <Title text={t.main.position} />
        <View style={{flexDirection: 'row', marginBottom: 10}}>
          <Readout label={t.main.ra} value={raDegToHMS(raDeg)} />
          <Readout label={t.main.dec} value={decDegToDMS(decDeg)} />
        </View>
        <View style={{flexDirection: 'row'}}>
          <Readout label={t.main.alt} value={aa.altDeg.toFixed(1)} unit="°" />
          <Readout label={t.main.az} value={aa.azDeg.toFixed(1)} unit="°" />
        </View>
      </Card>

      <Card style={{marginTop: 12}}>
        <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
          <View>
            <Text style={{color: c.textDim, fontSize: 11, letterSpacing: 1}}>{t.main.lst}</Text>
            <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 15}}>
              {raDegToHMS(lstDeg(now, site.lonDeg))}
            </Text>
          </View>
          <View style={{alignItems: 'flex-end'}}>
            <Text style={{color: c.textDim, fontSize: 11, letterSpacing: 1}}>{t.main.target}</Text>
            <Text style={{color: targetName ? c.amber : c.textFaint, fontSize: 15, fontWeight: '700'}}>
              {targetName || t.main.none}
            </Text>
          </View>
        </View>
      </Card>

      <View style={{flexDirection: 'row', marginTop: 12}}>
        <Btn label={t.main.gotoTarget} onPress={gotoTarget} disabled={!connected || targetRaDeg === null}
          variant="primary" style={{flex: 1, marginRight: 6}} />
        <Btn label={t.main.syncPhone} onPress={syncPhone} disabled={!connected} style={{flex: 1, marginLeft: 6}} />
      </View>
      <Btn label={t.main.park} onPress={() => autostar.park().catch(() => {})} disabled={!connected}
        variant="ghost" style={{marginTop: 10}} />
      <View style={{flexDirection: 'row', marginTop: 10}}>
        <Btn label={t.tabs.handbox} onPress={() => navigation.navigate('Handbox')} style={{flex: 1, marginRight: 6}} />
        <Btn label={t.tabs.console} onPress={() => navigation.navigate('Console')} style={{flex: 1, marginLeft: 6}} />
      </View>
      <Text style={{color: c.textFaint, textAlign: 'center', marginTop: 14, fontSize: 12}}>
        {t.main.quickHelp}
      </Text>
    </ScrollView>
  );
}
