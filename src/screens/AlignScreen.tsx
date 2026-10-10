/** Écran Alignement : modes + parcours guidé une/deux étoiles avec SYNC. */
import {useMemo, useState} from 'react';
import {ScrollView, Text, TouchableOpacity, Alert} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {autostar} from '../services/protocol/client';
import {withAlt, DisplayObject} from '../services/catalog';
import {BRIGHT_STARS} from '../services/catalog/stars';
import {Btn, Card, Segmented, Title, usePal} from '../components/ui';
import {StatusHeader} from '../components/StatusHeader';

type FlowStep = 'idle' | 'goto1' | 'center1' | 'sync1' | 'goto2' | 'center2' | 'sync2';

export function AlignScreen() {
  const t = useT();
  const c = usePal();
  const site = useSettingsStore((s) => s.site);
  const connStatus = useScopeStore((s) => s.connStatus);
  const alignMode = useScopeStore((s) => s.alignMode);
  const setAlignMode = useScopeStore((s) => s.setAlignMode);
  const [mode, setMode] = useState<'easy' | 'one' | 'two'>('easy');
  const [step, setStep] = useState<FlowStep>('idle');
  const [star1, setStar1] = useState<DisplayObject | null>(null);
  const [star2, setStar2] = useState<DisplayObject | null>(null);
  const [busy, setBusy] = useState(false);

  const stars = useMemo(
    () => withAlt(BRIGHT_STARS, site.latDeg, site.lonDeg, new Date())
      .filter((o) => o.altDeg > 20 && o.mag < 3)
      .sort((a, b) => a.mag - b.mag)
      .slice(0, 20),
    [site.latDeg, site.lonDeg],
  );

  const applyMode = async (m: 'altaz' | 'polar' | 'land') => {
    setAlignMode(m);
    if (connStatus === 'connected') await autostar.setTracking(m).catch(() => {});
  };

  const startFlow = async () => {
    if (!stars.length) {
      Alert.alert(t.common.error, t.objects.empty);
      return;
    }
    if (mode === 'easy') {
      setBusy(true);
      try {
        await autostar.startAlign('easy');
      } finally {
        setBusy(false);
      }
      return;
    }
    setStep('goto1');
  };

  const gotoStar = async (s: DisplayObject) => {
    setBusy(true);
    try {
      const r = await autostar.gotoRaDec(s.raDeg, s.decDeg);
      if (r !== 'ok') {
        Alert.alert(t.common.error, r === 'belowHorizon' ? t.objects.belowHorizon : t.errors.refused);
        return;
      }
      if (step === 'goto1') setStep('center1');
      if (step === 'goto2') setStep('center2');
    } finally {
      setBusy(false);
    }
  };

  const confirmSync = async () => {
    setBusy(true);
    try {
      await autostar.syncHere();
      if (step === 'center1') {
        if (mode === 'one') {
          Alert.alert(t.common.success, t.align.flow.done.replace('{star}', star1?.name ?? ''));
          setStep('idle');
        } else {
          setStep('goto2');
        }
      } else if (step === 'center2') {
        Alert.alert(t.common.success, t.align.flow.done.replace('{star}', star2?.name ?? ''));
        setStep('idle');
      }
    } finally {
      setBusy(false);
    }
  };

  const connected = connStatus === 'connected';

  return (
    <ScrollView style={{flex: 1, backgroundColor: c.bg}} contentContainerStyle={{padding: 12, paddingBottom: 40}}>
      <StatusHeader />
      <Card style={{marginTop: 8}}>
        <Title text={t.align.mode} />
        <Segmented<'altaz' | 'polar' | 'land'>
          value={alignMode === 'unknown' ? 'altaz' : alignMode}
          onChange={applyMode}
          options={[
            {key: 'altaz', label: t.align.altaz},
            {key: 'polar', label: t.align.polar},
            {key: 'land', label: t.align.land},
          ]}
        />
      </Card>

      <Card style={{marginTop: 12}}>
        <Title text={t.align.title} />
        <Segmented<'easy' | 'one' | 'two'>
          value={mode}
          onChange={setMode}
          options={[
            {key: 'easy', label: t.align.easy},
            {key: 'one', label: t.align.one},
            {key: 'two', label: t.align.two},
          ]}
        />
        <Btn label={busy ? t.common.loading : mode === 'easy' ? t.align.easy : t.align.flow.pick}
          onPress={startFlow} disabled={!connected || busy || step !== 'idle'}
          variant="primary" style={{marginTop: 12}} />
        {step !== 'idle' ? (
          <Text style={{color: c.orange, marginTop: 8, fontSize: 13}}>
            {step === 'goto1' ? `1/ ${t.align.flow.goto.replace('{star}', star1?.name ?? '')}` : ''}
          </Text>
        ) : null}
      </Card>

      {step === 'goto1' || step === 'goto2' ? (
        <Card style={{marginTop: 12}}>
          <Title text={t.align.flow.pick} />
          {stars.map((s) => (
            <TouchableOpacity key={s.id}
              onPress={() => (step === 'goto1' ? setStar1(s) : setStar2(s))}
              style={{
                flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9,
                borderBottomWidth: 1, borderBottomColor: c.border,
              }}>
              <Text style={{color: c.text, fontWeight: '600'}}>{s.name}</Text>
              <Text style={{color: c.textDim, fontSize: 12}}>
                {s.altDeg.toFixed(0)}° — mag {s.mag.toFixed(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </Card>
      ) : null}

      {(step === 'goto1' && star1) || (step === 'goto2' && star2) ? (
        <Btn
          label={`GOTO ${step === 'goto1' ? star1?.name : star2?.name}`}
          variant="primary"
          disabled={busy}
          onPress={() => gotoStar((step === 'goto1' ? star1 : star2)!)}
          style={{marginTop: 12}}
        />
      ) : null}

      {step === 'center1' || step === 'center2' ? (
        <Card style={{marginTop: 12}}>
          <Text style={{color: c.text, fontSize: 14}}>
            {t.align.flow.goto.replace('{star}', (step === 'center1' ? star1?.name : star2?.name) ?? '')}
          </Text>
          <Btn label={t.align.flow.confirm} variant="primary" disabled={busy} onPress={confirmSync}
            style={{marginTop: 10}} />
        </Card>
      ) : null}
    </ScrollView>
  );
}
