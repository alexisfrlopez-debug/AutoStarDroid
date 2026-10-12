/**
 * Panneau « Suivi télémétrique » (v2.0.0) — boucle fermée sur la télémétrie
 * du téléphone : cible (planète/Lune/Soleil via éphémérides ou objet fixe),
 * GOTO, centrage fin, suivi continu avec corrections moteur automatiques.
 */
import {useEffect, useMemo, useState} from 'react';
import {View, Text, TouchableOpacity, Alert} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {useTrackingStore, type TrackTarget} from '../store/trackingStore';
import {telemetryFitOf, useTelemetryStore} from '../store/telemetryStore';
import {autostar, gotoErrorText} from '../services/protocol/client';
import {telemetryTracker} from '../services/tracking/tracker';
import {validateFineTune, dismissFineTune} from '../services/tracking/fineTune';
import {planetObjects as planetList} from '../services/catalog';
import {planetRaDec, type PlanetName} from '../services/astro/planets';
import {raDecToAltAz} from '../services/astro/coords';
import {raDegToHMS, decDegToDMS} from '../services/astro/time';
import {altAzRatesDegPerSec} from '../services/astro/tracking';
import {Btn, Card, Title, Toggle, usePal, s} from './ui';

export function TelemetryTracking() {
  const t = useT();
  const c = usePal();
  const site = useSettingsStore((st) => st.site);
  const telemPrecision = useSettingsStore((st) => st.telemetryPrecision);
  const setTelemPrecision = useSettingsStore((st) => st.setTelemetryPrecision);
  const connStatus = useScopeStore((st) => st.connStatus);
  const target = useTrackingStore((st) => st.target);
  const setTarget = useTrackingStore((st) => st.setTarget);
  const tracking = useTrackingStore((st) => st.tracking);
  const phase = useTrackingStore((st) => st.phase);
  const fineTune = useTrackingStore((st) => st.fineTune);
  const lastErrArcmin = useTrackingStore((st) => st.lastErrArcmin);
  const corrections = useTrackingStore((st) => st.corrections);
  const signs = useTrackingStore((st) => st.signs);
  const log = useTrackingStore((st) => st.log);
  const points = useTelemetryStore((st) => st.points);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Sécurité : connexion perdue → arrêt immédiat du suivi (stopAll interne).
  useEffect(() => {
    if (connStatus !== 'connected' && useTrackingStore.getState().tracking) {
      void telemetryTracker.stop();
    }
  }, [connStatus]);

  const now = useMemo(() => new Date(), [tick]);
  const fit = useMemo(() => telemetryFitOf(points), [points]);

  /** Planètes / Lune / Soleil au-dessus de l'horizon, triées par hauteur. */
  const planets = useMemo(
    () => planetList(site.latDeg, site.lonDeg, now, t).filter((p) => p.altDeg > 5),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [site.latDeg, site.lonDeg, Math.floor(now.getTime() / 60000), t],
  );

  const targetNow = useMemo(() => {
    if (!target) return null;
    const rd = target.moving
      ? planetRaDec(target.moving as PlanetName, now)
      : {raDeg: target.raDeg, decDeg: target.decDeg};
    const aa = raDecToAltAz(rd.raDeg, rd.decDeg, site.latDeg, site.lonDeg, now);
    const rates = altAzRatesDegPerSec(rd.raDeg, rd.decDeg, site.latDeg, site.lonDeg, now);
    return {...rd, ...aa, rates};
  }, [target, site.latDeg, site.lonDeg, now]);

  const pick = (o: {id: string; name: string; raDeg: number; decDeg: number; type: string}) => {
    // id du catalogue : 'PLANET_<clé>' (Moon, Sun, Jupiter…) → objet mobile.
    const moving: string | null = o.id.startsWith('PLANET_') ? o.id.slice(7) : null;
    const tt: TrackTarget = {name: o.name, raDeg: o.raDeg, decDeg: o.decDeg, moving, from: 'catalog'};
    setTarget(tt);
  };

  const pickScopeTarget = () => {
    const st = useScopeStore.getState();
    if (st.targetRaDeg == null || st.targetDecDeg == null) return;
    setTarget({
      name: st.targetName || t.align.track.scopeTarget,
      raDeg: st.targetRaDeg,
      decDeg: st.targetDecDeg,
      moving: null,
      from: 'scope',
    });
  };

  const doGoto = async () => {
    if (!target || !targetNow) return;
    if (connStatus !== 'connected') {
      Alert.alert(t.common.error, t.align.track.needConnect);
      return;
    }
    setBusy(true);
    try {
      const r = await autostar.gotoRaDec(targetNow.raDeg, targetNow.decDeg);
      const msg = gotoErrorText(r, {
        belowHorizon: t.objects.belowHorizon, empty: t.objects.empty,
        gotoNoLink: t.errors.gotoNoLink, gotoMute: t.errors.gotoMute, refused: t.errors.refused,
      });
      if (msg) Alert.alert(t.common.error, msg);
    } catch (e) {
      Alert.alert(t.common.error, (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doFineCenter = async () => {
    if (connStatus !== 'connected') {
      Alert.alert(t.common.error, t.align.track.needConnect);
      return;
    }
    setBusy(true);
    try {
      const r = await telemetryTracker.centerOnce();
      if (r.errArcmin != null) {
        Alert.alert(
          t.common.success,
          t.align.track.centered.replace('{err}', r.errArcmin.toFixed(1)).replace('{n}', String(r.iterations)),
        );
      } else {
        Alert.alert(t.common.error, t.align.track.noData);
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleTracking = async () => {
    if (tracking) {
      setBusy(true);
      try {
        await telemetryTracker.stop();
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!target) {
      Alert.alert(t.common.error, t.align.track.noTarget);
      return;
    }
    setBusy(true);
    try {
      const r = await telemetryTracker.start(target);
      if (r === 'noFit') Alert.alert(t.common.error, t.align.track.needFit);
      else if (r === 'fitRms') Alert.alert(t.common.error, t.align.track.fitRms);
      else if (r === 'noSensors') Alert.alert(t.common.error, t.align.track.noSensors);
      else if (r === 'disconnected') Alert.alert(t.common.error, t.align.track.needConnect);
    } finally {
      setBusy(false);
    }
  };

  const doSync = async () => {
    if (!target || !targetNow || connStatus !== 'connected') return;
    setBusy(true);
    try {
      const ok = await autostar.syncRaDec(targetNow.raDeg, targetNow.decDeg);
      Alert.alert(ok ? t.common.success : t.common.error, ok ? t.align.track.synced : t.errors.syncRefused);
    } catch (e) {
      Alert.alert(t.common.error, (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Validation du réglage fin : enregistre le point télémétrique (aucune
   *  commande moteur — c'est un enregistrement qui affine le recalage). */
  const doValidateFineTune = async () => {
    setBusy(true);
    try {
      const ok = await validateFineTune();
      if (!ok) Alert.alert(t.common.error, t.align.track.ftNoSensors);
    } finally {
      setBusy(false);
    }
  };

  const phaseLabel =
    phase === 'pulsing' ? t.align.track.phasePulsing
    : phase === 'centering' ? t.align.track.phaseCentering
    : tracking ? t.align.track.phaseRunning
    : t.align.track.phaseIdle;

  return (
    <Card style={{marginTop: 12}}>
      <Title text={t.align.track.title} />
      <Text style={{color: c.textDim, fontSize: 13, lineHeight: 19}}>{t.align.track.intro}</Text>

      {/* Cible courante */}
      <View
        style={{
          backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.border,
          padding: 10, marginTop: 10,
        }}>
        <Text style={{color: c.textDim, fontSize: 11, letterSpacing: 1}}>{t.align.track.target}</Text>
        {target && targetNow ? (
          <>
            <Text style={{color: c.amber, fontSize: 17, fontWeight: '700', marginTop: 2}}>
              {target.name}
              {target.moving ? <Text style={{color: c.textFaint, fontSize: 12}}>  · {t.align.track.moving}</Text> : null}
            </Text>
            <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 13, marginTop: 2}}>
              RA {raDegToHMS(targetNow.raDeg)}  DEC {decDegToDMS(targetNow.decDeg)}
            </Text>
            <Text style={{color: c.textFaint, fontSize: 12}}>
              {t.align.telem.alt} {targetNow.altDeg.toFixed(1)}° · {t.align.telem.az} {targetNow.azDeg.toFixed(1)}°
              {'  '}({targetNow.rates.dAltDegPerSec >= 0 ? '+' : ''}
              {(targetNow.rates.dAltDegPerSec * 60).toFixed(1)}′/min,{' '}
              {(targetNow.rates.dAzDegPerSec * 60).toFixed(1)}′/min)
            </Text>
          </>
        ) : (
          <Text style={{color: c.textFaint, fontSize: 13, marginTop: 2}}>{t.align.track.noTarget}</Text>
        )}
      </View>

      {/* Objets brillants maintenant (planètes, Lune, Soleil) */}
      {planets.length ? (
        <View style={{marginTop: 10}}>
          <Text style={{color: c.textDim, fontSize: 12, marginBottom: 4}}>{t.align.track.pickPlanet}</Text>
          <View style={[s.row, {flexWrap: 'wrap'}]}>
            {planets.map((p) => (
              <TouchableOpacity
                key={p.id}
                onPress={() => pick(p)}
                style={{
                  backgroundColor: target?.name === p.name ? c.amber : c.bgPanel2,
                  borderWidth: 1, borderColor: c.border, borderRadius: 14,
                  paddingHorizontal: 10, paddingVertical: 5, marginRight: 6, marginBottom: 6,
                }}>
                <Text style={{color: target?.name === p.name ? '#111' : c.text, fontSize: 12, fontWeight: '600'}}>
                  {p.name} {p.altDeg.toFixed(0)}°
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}

      {/* Cible raquette + actions */}
      <View style={[s.row, {marginTop: 8}]}>
        <TouchableOpacity onPress={pickScopeTarget}>
          <Text style={{color: c.blue, fontSize: 12, fontWeight: '700'}}>{t.align.track.useScopeTarget}</Text>
        </TouchableOpacity>
      </View>

      <View style={[s.row, {marginTop: 10}]}>
        <Btn label={t.align.track.goto} onPress={doGoto} disabled={busy || !target || connStatus !== 'connected'}
          style={{flex: 1, marginRight: 5}} />
        <Btn label={t.align.track.fineCenter} onPress={doFineCenter}
          disabled={busy || !target || connStatus !== 'connected' || !fit}
          style={{flex: 1, marginLeft: 5}} />
      </View>
      <Toggle
        value={tracking}
        onChange={() => void toggleTracking()}
        label={tracking ? t.align.track.stop : t.align.track.start}
      />
      <Btn label={t.align.track.syncScope} onPress={doSync} disabled={busy || !target || connStatus !== 'connected'}
        variant="ghost" style={{marginTop: 6}} />

      {/* PRÉCISION PAR TÉLÉMÉTRIE (v2.2.0) : réglage fin automatique à
          chaque arrivée de GOTO (app ou raquette) + validation. */}
      <Toggle
        value={telemPrecision}
        onChange={() => setTelemPrecision(!telemPrecision)}
        label={telemPrecision ? t.align.track.ftOn : t.align.track.ftOff}
      />
      <Text style={{color: c.textFaint, fontSize: 11, marginTop: 2, marginBottom: 4}}>
        {t.align.track.ftDesc}
      </Text>

      {/* BANNIÈRE DE VALIDATION du réglage fin (v2.2.0). */}
      {fineTune.state === 'running' ? (
        <View style={{backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.border, padding: 10, marginTop: 6}}>
          <Text style={{color: c.amber, fontSize: 13, fontWeight: '700'}}>{t.align.track.ftRunning}</Text>
          {fineTune.beforeArcmin != null ? (
            <Text style={{color: c.textDim, fontSize: 12, marginTop: 2}}>
              {t.align.track.err} {fineTune.beforeArcmin.toFixed(1)}′
            </Text>
          ) : null}
        </View>
      ) : null}
      {fineTune.state === 'awaitValidation' ? (
        <View style={{backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.amber, padding: 10, marginTop: 6}}>
          <Text style={{color: c.amber, fontSize: 13, fontWeight: '700'}}>{t.align.track.ftAsk}</Text>
          <Text style={{color: c.text, fontSize: 12, marginTop: 3, lineHeight: 17}}>
            {fineTune.name ?? '—'} : {fineTune.beforeArcmin != null ? fineTune.beforeArcmin.toFixed(1) : '?'}′ →{' '}
            {fineTune.afterArcmin != null ? fineTune.afterArcmin.toFixed(1) : '?'}′
            {fineTune.iterations ? `  ·  ${fineTune.iterations} ${t.align.track.ftIters}` : ''}
          </Text>
          <Text style={{color: c.textDim, fontSize: 11, marginTop: 3, lineHeight: 16}}>{t.align.track.ftAskDesc}</Text>
          <View style={[s.row, {marginTop: 8}]}>
            <Btn label={t.align.track.ftValidate} onPress={() => void doValidateFineTune()} disabled={busy}
              variant="primary" style={{flex: 1, marginRight: 5}} />
            <Btn label={t.align.track.ftIgnore} onPress={dismissFineTune} disabled={busy}
              style={{flex: 1, marginLeft: 5}} />
          </View>
        </View>
      ) : null}
      {fineTune.state === 'applied' ? (
        <Text style={{color: c.green, fontSize: 12, marginTop: 6}}>{t.align.track.ftApplied}</Text>
      ) : null}
      {/* GARDE DE FLUIDITÉ (v2.3.0) : télémétrie jugée instable pendant le
          GOTO (contrôle croisé) — réglage fin automatique REFUSÉ. */}
      {fineTune.state === 'unreliable' ? (
        <View style={{backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.danger, padding: 10, marginTop: 6}}>
          <Text style={{color: c.orange, fontSize: 13, fontWeight: '700'}}>{t.align.track.ftUnreliable}</Text>
          <Text style={{color: c.textDim, fontSize: 11, marginTop: 3, lineHeight: 16}}>
            {t.align.track.ftUnreliableDesc.replace('{name}', fineTune.name ?? '—')}
            {fineTune.beforeArcmin != null ? ` (${t.align.track.err} ${fineTune.beforeArcmin.toFixed(1)}′)` : ''}
          </Text>
        </View>
      ) : null}

      {/* Statut live */}
      <View style={[s.row, s.between, {marginTop: 12}]}>
        <Text style={{color: tracking ? c.green : c.textFaint, fontSize: 12, fontWeight: '700'}}>
          {tracking ? '◉ ' : '○ '}
          {phaseLabel}
        </Text>
        <Text style={{color: c.textDim, fontSize: 12}}>
          {lastErrArcmin != null
            ? `${t.align.track.err} ${lastErrArcmin < 1 ? '<1' : lastErrArcmin.toFixed(1)}′`
            : '—'}
        </Text>
      </View>
      <Text style={{color: c.textFaint, fontSize: 11, marginTop: 2}}>
        {t.align.track.corrections} : {corrections} · {t.align.track.signs} : DEC{' '}
        {signs.dec > 0 ? 'N↑' : 'N↓'} / AD {signs.ra > 0 ? 'E→' : 'E←'}
        {fit ? ` · RMS ${(fit.rmsDeg * 60).toFixed(1)}′` : ''}
      </Text>

      {/* Journal des corrections */}
      {log.length ? (
        <View style={{marginTop: 8}}>
          <Text style={{color: c.textDim, fontSize: 12, marginBottom: 2}}>{t.align.track.log}</Text>
          {log.slice(-5).reverse().map((l, i) => (
            <Text key={`${l.ts}-${i}`} style={{color: c.textFaint, fontFamily: 'monospace', fontSize: 11}}>
              {new Date(l.ts).toLocaleTimeString()}  {l.axis === 'ra' ? 'AD' : 'DEC'} {l.dir.toUpperCase()}{' '}
              {(l.durationMs / 1000).toFixed(1)}s  {l.beforeArcmin.toFixed(1)}′ →{' '}
              {l.afterArcmin != null ? `${l.afterArcmin.toFixed(1)}′` : '…'}
            </Text>
          ))}
        </View>
      ) : null}
    </Card>
  );
}
