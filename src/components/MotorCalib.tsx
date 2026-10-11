/**
 * Panneau « Auto-calibrage des moteurs » (v2.0.0) — le téléphone, solidaire
 * du tube, mesure au gyroscope la réponse RÉELLE des moteurs :
 *  - taux N/S/E/W à la vitesse choisie (″/s sur le ciel) ;
 *  - backlash AD et DEC (angle de jeu en ″) ;
 *  - dérive du suivi vs taux sidéral.
 * Résultats persistés et appliqués aux impulsions de la boucle de suivi.
 */
import {useState} from 'react';
import {View, Text, TouchableOpacity, Alert} from 'react-native';
import {useT} from '../i18n';
import {useScopeStore} from '../store/scopeStore';
import {useMotorCalibStore} from '../store/motorCalibStore';
import {
  measureAllDirections,
  measureBacklash,
  measureDrift,
  type CalibPhase,
} from '../services/tracking/motorcalService';
import {Btn, Card, Segmented, Title, Toggle, usePal, s} from './ui';

type CalSpeed = 'guide' | 'center' | 'find';

const PHASE_KEY: Record<CalibPhase, string> = {
  idle: 'calibPhaseIdle',
  bias: 'calibPhaseBias',
  move: 'calibPhaseMove',
  settle: 'calibPhaseSettle',
  prime: 'calibPhasePrime',
  gap: 'calibPhaseGap',
  reverse: 'calibPhaseReverse',
  drift: 'calibPhaseDrift',
  done: 'calibPhaseDone',
};

export function MotorCalib() {
  const t = useT();
  const c = usePal();
  const connStatus = useScopeStore((st) => st.connStatus);
  const rates = useMotorCalibStore((st) => st.rates);
  const backlash = useMotorCalibStore((st) => st.backlash);
  const drift = useMotorCalibStore((st) => st.drift);
  const signs = useMotorCalibStore((st) => st.signs);
  const apply = useMotorCalibStore((st) => st.apply);
  const setApply = useMotorCalibStore((st) => st.setApply);
  const resetAll = useMotorCalibStore((st) => st.resetAll);

  const [speed, setSpeed] = useState<CalSpeed>('center');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<CalibPhase | null>(null);
  const [phaseDir, setPhaseDir] = useState<string>('');

  const needConn = () => {
    if (connStatus !== 'connected') {
      Alert.alert(t.common.error, t.align.calib.needConnect);
      return true;
    }
    return false;
  };

  const runDirs = async () => {
    if (needConn()) return;
    setBusy(true);
    try {
      const r = await measureAllDirections(speed, (p, dir) => {
        setPhase(p);
        setPhaseDir(dir ? ` ${dir.toUpperCase()}` : '');
      });
      if (!r) Alert.alert(t.common.error, t.align.calib.measureFail);
      else Alert.alert(t.common.success, t.align.calib.measureOk);
    } finally {
      setBusy(false);
      setPhase(null);
      setPhaseDir('');
    }
  };

  const runBacklash = async (axis: 'ra' | 'dec') => {
    if (needConn()) return;
    setBusy(true);
    try {
      const r = await measureBacklash(axis, setPhase);
      if (r.arcsec == null) {
        Alert.alert(t.common.error, t.align.calib.backlashFail);
      } else {
        Alert.alert(
          t.common.success,
          t.align.calib.backlashOk.replace('{v}', r.arcsec < 10 ? r.arcsec.toFixed(1) : r.arcsec.toFixed(0)),
        );
      }
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  const runDrift = async () => {
    setBusy(true);
    try {
      const r = await measureDrift(setPhase);
      if (r.degPerSec != null && r.vsSidereal != null) {
        Alert.alert(
          t.common.success,
          t.align.calib.driftOk
            .replace('{v}', (r.degPerSec * 3600).toFixed(1))
            .replace('{d}', (r.vsSidereal >= 0 ? '+' : '') + r.vsSidereal.toFixed(2)),
        );
      }
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  const fmt = (v: number | null | undefined): string =>
    v == null ? '—' : `${(v * 3600).toFixed(v * 3600 < 100 ? 1 : 0)}″/s`;

  return (
    <Card style={{marginTop: 12}}>
      <Title text={t.align.calib.title} />
      <Text style={{color: c.textDim, fontSize: 13, lineHeight: 19}}>{t.align.calib.intro}</Text>

      <Text style={{color: c.textDim, fontSize: 12, marginTop: 10, marginBottom: 4}}>{t.align.calib.speed}</Text>
      <Segmented<CalSpeed>
        value={speed}
        onChange={setSpeed}
        options={[
          {key: 'guide', label: t.slew.guide},
          {key: 'center', label: t.slew.center},
          {key: 'find', label: t.slew.find},
        ]}
      />

      <Btn label={t.align.calib.measureDirs} onPress={() => void runDirs()} variant="primary"
        disabled={busy || connStatus !== 'connected'} style={{marginTop: 10}} />
      <View style={[s.row, {marginTop: 8}]}>
        <Btn label={t.align.calib.backlashRa} onPress={() => void runBacklash('ra')}
          disabled={busy || connStatus !== 'connected'} style={{flex: 1, marginRight: 5}} />
        <Btn label={t.align.calib.backlashDec} onPress={() => void runBacklash('dec')}
          disabled={busy || connStatus !== 'connected'} style={{flex: 1, marginLeft: 5}} />
      </View>
      <Btn label={t.align.calib.measureDrift} onPress={() => void runDrift()}
        disabled={busy} variant="ghost" style={{marginTop: 6}} />

      {phase != null ? (
        <Text style={{color: c.orange, fontSize: 13, marginTop: 8, fontWeight: '700'}}>
          {(t.align.calib as Record<string, string>)[PHASE_KEY[phase]]}
          {phaseDir}
          {busy ? ' …' : ''}
        </Text>
      ) : null}

      {/* Résultats */}
      <View style={[s.row, s.between, {marginTop: 14}]}>
        <Text style={{color: c.text, fontWeight: '700', fontSize: 13}}>{t.align.calib.results}</Text>
        <TouchableOpacity onPress={resetAll}>
          <Text style={{color: c.red, fontSize: 12}}>{t.align.calib.reset}</Text>
        </TouchableOpacity>
      </View>

      <View style={{backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.border, padding: 10, marginTop: 6}}>
        <Text style={{color: c.textDim, fontSize: 11, letterSpacing: 1}}>{t.align.calib.rates}</Text>
        <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 13, marginTop: 4}}>
          N {fmt(rates?.n)}   S {fmt(rates?.s)}   E {fmt(rates?.e)}   W {fmt(rates?.w)}
        </Text>
        <Text style={{color: c.textFaint, fontSize: 11, marginTop: 2}}>
          {rates
            ? `${t.slew[rates.speed]} · ${t.align.calib.noise} ${(rates.noise * 3600).toFixed(1)}″ · ${new Date(
                rates.measuredAt,
              ).toLocaleString()}`
            : t.align.calib.ratesNone}
        </Text>
        <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 13, marginTop: 8}}>
          {t.align.calib.backlashVal} AD{' '}
          {backlash?.raArcsec != null ? `${backlash.raArcsec < 10 ? backlash.raArcsec.toFixed(1) : backlash.raArcsec.toFixed(0)}″` : '—'}
          {'  '}DEC{' '}
          {backlash?.decArcsec != null ? `${backlash.decArcsec < 10 ? backlash.decArcsec.toFixed(1) : backlash.decArcsec.toFixed(0)}″` : '—'}
        </Text>
        <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 13, marginTop: 4}}>
          {t.align.calib.driftVal}{' '}
          {drift ? `${(drift.degPerSec * 3600).toFixed(1)}″/s (${drift.vsSiderealArcsecPerSec >= 0 ? '+' : ''}${drift.vsSiderealArcsecPerSec.toFixed(2)})` : '—'}
        </Text>
        <Text style={{color: c.textFaint, fontSize: 11, marginTop: 2}}>
          {t.align.calib.signs} : DEC {signs.dec > 0 ? 'N↑' : 'N↓'} · AD {signs.ra > 0 ? 'E→' : 'E←'}
        </Text>
      </View>

      <Toggle value={apply} onChange={setApply} label={t.align.calib.applyToggle} />
      <Text style={{color: c.textFaint, fontSize: 12, lineHeight: 18, marginTop: 6}}>{t.align.calib.tips}</Text>
    </Card>
  );
}
