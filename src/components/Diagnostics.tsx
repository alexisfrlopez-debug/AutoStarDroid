/**
 * Panneau « Diagnostic moteur complet » (v2.1.0) — UN bouton qui lance
 * de manière autonome une série complète de tests télémétriques de la
 * monture (téléphone solidaire du tube, gyroscope brut) :
 * pré-contrôles, calibration moteur, ratio par axe, backlash, précision
 * moteur, train d'engrenages, min/max élévation, dérive du suivi.
 *
 * Progression en direct (test courant + barre), bouton ABORT, résultats
 * persistés avec statut par test (OK / attention / échec) et alimentation
 * du calibrage moteurs (raquette mise à jour : taux, backlash, dérive).
 */
import {useState} from 'react';
import {View, Text, TouchableOpacity, Alert} from 'react-native';
import {useT} from '../i18n';
import {useScopeStore} from '../store/scopeStore';
import {useDiagStore} from '../store/diagStore';
import {
  diagRunner,
  DIAG_TEST_DURATIONS_S,
  type DiagEvent,
  type DiagTestId,
  type DiagStatus,
  type DiagTestResult,
} from '../services/tracking/diagService';
import {Btn, Card, Title, usePal, s} from './ui';

const STATUS_COLOR: Record<DiagStatus, string> = {
  ok: '#4CAF50',
  warn: '#FF9800',
  fail: '#F44336',
  skipped: '#777D88',
};

/** Formatage d'une valeur selon sa clé (déjà renommée en clé i18n v*). */
function fmtValue(key: string, v: number | null): string {
  if (v == null) return '—';
  // Pourcentages : ratios, linéarité, oscillation/RMS, répétabilité
  const pct = key === 'vPctN' || key === 'vPctS' || key === 'vPctE' || key === 'vPctW'
    || key === 'vLinearity' || key === 'vRel'
    || key === 'vP2PE' || key === 'vP2PN' || key === 'vRmsE' || key === 'vRmsN';
  if (pct) return `${v.toFixed(v < 10 ? 1 : 0)} %`;
  // Angles de jeu en secondes d'arc
  if (key === 'vRa' || key === 'vDec') return `${v < 10 ? v.toFixed(1) : v.toFixed(0)}″`;
  // Angles en degrés
  const deg = key === 'vMean' || key === 'vStd' || key === 'vSpread'
    || key === 'vAltStart' || key === 'vMaxAlt' || key === 'vMinAlt' || key === 'vUp' || key === 'vDown';
  if (deg) return `${v.toFixed(2)}°`;
  // Vitesses angulaires (deg/s → ″/s)
  const dps = key === 'vRateN' || key === 'vRateS' || key === 'vRateE' || key === 'vRateW'
    || key === 'vBias' || key === 'vNoise' || key === 'vDrift' || key === 'noise';
  if (dps) return `${(v * 3600).toFixed(1)}″/s`;
  if (key === 'vVsSidereal') return `${v >= 0 ? '+' : ''}${v.toFixed(2)}″/s`;
  // Compteurs
  if (key === 'vStallE' || key === 'vStallN') return v.toFixed(0);
  return v.toFixed(2);
}

export function Diagnostics() {
  const t = useT();
  const c = usePal();
  const connStatus = useScopeStore((st) => st.connStatus);
  const report = useDiagStore((st) => st.report);
  const running = useDiagStore((st) => st.running);
  const setReport = useDiagStore((st) => st.setReport);
  const setRunning = useDiagStore((st) => st.setRunning);
  const clear = useDiagStore((st) => st.clear);

  const [ev, setEv] = useState<DiagEvent | null>(null);

  const dx = t.align.diag;

  const start = async () => {
    setRunning(true);
    setEv(null);
    try {
      const r = await diagRunner.run((e) => setEv(e));
      setReport(r);
      const ok = r.results.filter((x) => x.status === 'ok').length;
      const warn = r.results.filter((x) => x.status === 'warn').length;
      const fail = r.results.filter((x) => x.status === 'fail').length;
      Alert.alert(
        t.common.success,
        r.aborted ? dx.abortedMsg : `${dx.doneMsg.replace('{ok}', String(ok)).replace('{warn}', String(warn)).replace('{fail}', String(fail))}`,
      );
    } catch (_) {
      Alert.alert(t.common.error, dx.needConnect);
    } finally {
      setRunning(false);
      setEv(null);
    }
  };

  const launch = () => {
    if (connStatus !== 'connected') {
      Alert.alert(t.common.error, dx.needConnect);
      return;
    }
    Alert.alert(dx.confirmTitle, dx.confirmMsg, [
      {text: t.common.cancel, style: 'cancel'},
      {text: dx.launch, style: 'default', onPress: () => void start()},
    ]);
  };

  const abort = () => diagRunner.abort();

  const testName = (id: DiagTestId): string =>
    (dx as Record<string, string>)[`testName${id.charAt(0).toUpperCase()}${id.slice(1)}`] ?? id;

  const phaseText = (): string => {
    if (!ev) return '';
    const ph = (dx as Record<string, string>)[`phase${ev.phase.charAt(0).toUpperCase()}${ev.phase.slice(1)}`] ?? '';
    const dir = ev.dir ? ` ${ev.dir.toUpperCase()}` : '';
    return `${ph}${dir}`;
  };

  const valueKeys = (r: DiagTestResult): Array<[string, number | null]> => {
    const rename: Record<string, string> = {
      n: 'vRateN', s: 'vRateS', e: 'vRateE', w: 'vRateW',
      pctN: 'vPctN', pctS: 'vPctS', pctE: 'vPctE', pctW: 'vPctW',
      raArcsec: 'vRa', decArcsec: 'vDec',
      altStartDeg: 'vAltStart', maxAltDeg: 'vMaxAlt', minAltDeg: 'vMinAlt',
      upDeg: 'vUp', downDeg: 'vDown',
      driftDegPerSec: 'vDrift', vsSiderealArcsecPerSec: 'vVsSidereal',
      pctP2PE: 'vP2PE', rmsPctE: 'vRmsE', stallsE: 'vStallE',
      pctP2PN: 'vP2PN', rmsPctN: 'vRmsN', stallsN: 'vStallN',
      biasMagDegPerSec: 'vBias', ambientNoiseDegPerSec: 'vNoise',
      linearityPct: 'vLinearity',
      meanDeg: 'vMean', stdDeg: 'vStd', spreadDeg: 'vSpread', relPct: 'vRel',
    };
    return Object.entries(r.values).map(([k, v]) => [rename[k] ?? k, v] as [string, number | null]);
  };

  const totalSec = Math.round(Object.values(DIAG_TEST_DURATIONS_S).reduce((a, b) => a + b, 0) / 5) * 5;

  return (
    <Card style={{marginTop: 12}}>
      <Title text={dx.title} />
      <Text style={{color: c.textDim, fontSize: 13, lineHeight: 19}}>{dx.intro}</Text>
      <Text style={{color: c.orange, fontSize: 12, lineHeight: 18, marginTop: 8}}>{dx.safety}</Text>

      {running ? (
        <>
          <Btn label={dx.abort} onPress={abort} variant="danger" style={{marginTop: 10}} />
          {ev ? (
            <View style={{marginTop: 10}}>
              <View style={[s.row, s.between]}>
                <Text style={{color: c.amber, fontWeight: '700', fontSize: 13}}>
                  {testName(ev.test)} — {phaseText()}
                </Text>
                <Text style={{color: c.textDim, fontSize: 12}}>{Math.round(ev.progress * 100)} %</Text>
              </View>
              <View style={{height: 6, borderRadius: 3, backgroundColor: c.bgPanel2, marginTop: 6, overflow: 'hidden'}}>
                <View style={{height: 6, borderRadius: 3, width: `${Math.max(2, ev.progress * 100)}%` as any, backgroundColor: c.amber}} />
              </View>
            </View>
          ) : (
            <Text style={{color: c.textDim, fontSize: 13, marginTop: 8}}>{dx.running}</Text>
          )}
        </>
      ) : (
        <Btn
          label={dx.launch.replace('{d}', `${Math.round(totalSec / 60)}`)}
          onPress={launch}
          variant="primary"
          disabled={connStatus !== 'connected'}
          style={{marginTop: 10}}
        />
      )}

      {/* Résultats persistés */}
      <View style={[s.row, s.between, {marginTop: 14}]}>
        <Text style={{color: c.text, fontWeight: '700', fontSize: 13}}>{dx.lastRun}</Text>
        {report ? (
          <TouchableOpacity onPress={clear}>
            <Text style={{color: c.red, fontSize: 12}}>{dx.reset}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {!report ? (
        <Text style={{color: c.textFaint, fontSize: 12, marginTop: 6}}>{dx.none}</Text>
      ) : (
        <View style={{backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.border, padding: 10, marginTop: 6}}>
          <Text style={{color: c.textFaint, fontSize: 11, marginBottom: 6}}>
            {new Date(report.finishedAt).toLocaleString()}
            {report.aborted ? ` · ${dx.stSkipped.toLowerCase()}` : ''} ·{' '}
            {report.results.reduce((a, b) => a + b.durationMs, 0) >= 60000
              ? `${Math.round(report.results.reduce((a, b) => a + b.durationMs, 0) / 60000)} min`
              : `${Math.round(report.results.reduce((a, b) => a + b.durationMs, 0) / 1000)} s`}
          </Text>
          {report.results.map((r) => (
            <View key={r.id} style={{marginBottom: 8}}>
              <View style={[s.row, s.between]}>
                <View style={s.row}>
                  <View style={{width: 9, height: 9, borderRadius: 5, backgroundColor: STATUS_COLOR[r.status], marginRight: 7}} />
                  <Text style={{color: c.text, fontWeight: '600', fontSize: 13}}>{testName(r.id)}</Text>
                </View>
                <Text style={{color: c.textDim, fontSize: 11}}>
                  {(dx as Record<string, string>)[`st${r.status.charAt(0).toUpperCase()}${r.status.slice(1)}`]}
                  {r.durationMs > 800 ? ` · ${Math.round(r.durationMs / 1000)} s` : ''}
                </Text>
              </View>
              <Text style={{color: c.textDim, fontFamily: 'monospace', fontSize: 12, marginLeft: 16, marginTop: 2, lineHeight: 17}}>
                {valueKeys(r).map(([k, v]) => {
                  const label = (dx as Record<string, string>)[k];
                  return label ? `${label} ${fmtValue(k, v)}` : '';
                }).filter(Boolean).join('  ·  ')}
              </Text>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}
