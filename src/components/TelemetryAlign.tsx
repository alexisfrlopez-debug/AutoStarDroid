/**
 * Section « Télémétrie téléphone » de l'écran Alignement (v1.9.0).
 *
 * Recalage de l'alignement du télescope à partir des capteurs du téléphone
 * (rotation vector : gyroscope + accéléromètre + magnétomètre) :
 *  1. le téléphone est solidaire du tube ;
 *  2. on pointe un objet (étoile du catalogue ou coordonnées manuelles),
 *     on le centre dans l'oculaire ;
 *  3. « Valider » fige l'orientation du téléphone (moyenne ~1 s) + les
 *     coordonnées de l'objet → point d'alignement persistant ;
 *  4. le fit (Wahba/Kabsch, cf. astro/telemetry.ts) recalcule en continu le
 *     pointage réel du télescope (AD/DEC + hauteur/azimut) et son écart
 *     avec la position crue par la raquette ;
 *  5. option : la validation met aussi à jour l'alignement interne de la
 *     raquette (:Sr/:Sd puis :CM#).
 */
import {useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, TouchableOpacity, Alert} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {useTelemetryStore, telemetryFitOf} from '../store/telemetryStore';
import {autostar} from '../services/protocol/client';
import {BRIGHT_STARS, withAlt} from '../services/catalog';
import {raDecToAltAz, altAzToRaDec, separationDeg} from '../services/astro/coords';
import {raDegToHMS, decDegToDMS} from '../services/astro/time';
import {
  applyFit,
  averageQuat,
  parseRaHms,
  parseDecDms,
  type Quat,
} from '../services/astro/telemetry';
import {
  sensorsAvailable,
  startOrientation,
  type Orientation,
  type SensorsAvailability,
} from '../services/phone/sensors';
import {getPhonePosition} from '../services/phone/gps';
import {Btn, Card, Input, Readout, Segmented, Title, Toggle, usePal, s} from './ui';

export function TelemetryAlign() {
  const t = useT();
  const c = usePal();
  const site = useSettingsStore((st) => st.site);
  const setSite = useSettingsStore((st) => st.setSite);
  const connStatus = useScopeStore((st) => st.connStatus);
  const scopeRa = useScopeStore((st) => st.raDeg);
  const scopeDec = useScopeStore((st) => st.decDeg);
  const hasPos = useScopeStore((st) => st.hasPos);
  const points = useTelemetryStore((st) => st.points);
  const addPoint = useTelemetryStore((st) => st.addPoint);
  const removePoint = useTelemetryStore((st) => st.removePoint);
  const clearPoints = useTelemetryStore((st) => st.clearPoints);

  const [pick, setPick] = useState<'stars' | 'manual'>('stars');
  const [starId, setStarId] = useState<string | null>(null);
  const [raTxt, setRaTxt] = useState('');
  const [decTxt, setDecTxt] = useState('');
  const [syncAfter, setSyncAfter] = useState(true);
  const [orient, setOrient] = useState<Orientation | null>(null);
  const [avail, setAvail] = useState<SensorsAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [tick, setTick] = useState(0); // horloge 1 s : conversions live
  const samples = useRef<Quat[]>([]);

  /* Flux capteurs (réf-compté : coexiste avec MiseEnStation de l'onglet Raquette) */
  useEffect(() => {
    let alive = true;
    let stop: () => void = () => undefined;
    (async () => {
      const a = await sensorsAvailable();
      if (!alive) return;
      setAvail(a);
      if (a.rotationVector) {
        stop = startOrientation((o) => {
          if (!alive) return;
          setOrient(o);
          if (typeof o.qw === 'number') {
            samples.current.push({w: o.qw, x: o.qx ?? 0, y: o.qy ?? 0, z: o.qz ?? 0});
            if (samples.current.length > 12) samples.current.shift();
          }
        }, 120);
      }
    })();
    return () => {
      alive = false;
      stop();
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = useMemo(() => new Date(), [tick]);
  const nowMin = useMemo(() => Math.floor(now.getTime() / 60000), [tick]);

  const fit = useMemo(() => telemetryFitOf(points), [points]);

  /** Étoiles brillantes au-dessus de 15° (rafraîchi à la minute). */
  const stars = useMemo(() => {
    const d = new Date(nowMin * 60000);
    return withAlt(BRIGHT_STARS, site.latDeg, site.lonDeg, d)
      .filter((o) => o.altDeg > 15)
      .sort((a, b) => a.mag - b.mag)
      .slice(0, 15);
  }, [site.latDeg, site.lonDeg, nowMin]);

  const manual = useMemo(() => {
    const ra = parseRaHms(raTxt);
    const dec = parseDecDms(decTxt);
    return ra != null && dec != null ? {raDeg: ra, decDeg: dec} : null;
  }, [raTxt, decTxt]);

  /** Objet sélectionné : nom, coordonnées J2000, direction horizontale actuelle. */
  const selected = useMemo(() => {
    if (pick === 'stars') {
      const st = stars.find((o) => o.id === starId);
      return st
        ? {name: st.name, raDeg: st.raDeg, decDeg: st.decDeg, altDeg: st.altDeg, azDeg: st.azDeg}
        : null;
    }
    if (!manual) return null;
    const aa = raDecToAltAz(manual.raDeg, manual.decDeg, site.latDeg, site.lonDeg, now);
    return {
      name: `${raDegToHMS(manual.raDeg)} ${decDegToDMS(manual.decDeg)}`,
      ...manual,
      altDeg: aa.altDeg,
      azDeg: aa.azDeg,
    };
  }, [pick, starId, stars, manual, site.latDeg, site.lonDeg, now]);

  /** Pointage réel du télescope déduit des capteurs (fit) + position raquette. */
  const live = useMemo(() => {
    if (!fit || typeof orient?.qw !== 'number') return null;
    const aa = applyFit(fit, {w: orient.qw, x: orient.qx ?? 0, y: orient.qy ?? 0, z: orient.qz ?? 0});
    const rd = altAzToRaDec(aa.altDeg, aa.azDeg, site.latDeg, site.lonDeg, now);
    return {...aa, ...rd};
  }, [fit, orient, site.latDeg, site.lonDeg, now]);

  /** Écart raquette ↔ téléphone (minutes d'arc) : erreur d'alignement interne. */
  const deltaArcmin = useMemo(() => {
    if (!live || !hasPos) return null;
    return separationDeg(live.raDeg, live.decDeg, scopeRa, scopeDec) * 60;
  }, [live, hasPos, scopeRa, scopeDec]);

  const hasQuat = typeof orient?.qw === 'number';

  const validate = async () => {
    if (!selected) {
      Alert.alert(t.common.error, t.align.telem.needObject);
      return;
    }
    if (!hasQuat) {
      Alert.alert(t.common.error, t.align.telem.needSamples);
      return;
    }
    const q = averageQuat(samples.current);
    if (!q) {
      Alert.alert(t.common.error, t.align.telem.needSamples);
      return;
    }
    setBusy(true);
    try {
      addPoint({
        name: selected.name,
        raDeg: selected.raDeg,
        decDeg: selected.decDeg,
        altDeg: selected.altDeg,
        azDeg: selected.azDeg,
        quat: q,
      });
      if (syncAfter && connStatus === 'connected') {
        await autostar.syncRaDec(selected.raDeg, selected.decDeg).catch(() => false);
      }
    } finally {
      setBusy(false);
    }
  };

  const grabGps = async () => {
    setGpsBusy(true);
    try {
      const pos = await getPhonePosition();
      setSite({...site, latDeg: pos.latDeg, lonDeg: pos.lonDeg, elevM: pos.elevM || site.elevM});
    } catch (_) {
      Alert.alert(t.common.error, t.align.telem.gpsFail);
    } finally {
      setGpsBusy(false);
    }
  };

  const acc = orient?.accuracy ?? 0;
  const rmsArcmin = fit ? fit.rmsDeg * 60 : null;

  return (
    <Card style={{marginTop: 12}}>
      <Title text={t.align.telem.title} />
      <Text style={{color: c.textDim, fontSize: 13, lineHeight: 19}}>{t.align.telem.intro}</Text>

      {/* Capteurs + site + GPS */}
      <View style={[s.row, s.between, {marginTop: 10}]}>
        <Text
          style={{
            color: avail == null ? c.textFaint : avail.rotationVector ? c.green : c.red,
            fontSize: 12,
            fontWeight: '700',
          }}>
          {avail == null ? '…' : avail.rotationVector ? `● ${t.align.telem.sensors} OK` : `● ${t.align.telem.sensorsOff}`}
        </Text>
        <TouchableOpacity onPress={grabGps} disabled={gpsBusy}>
          <Text style={{color: c.blue, fontSize: 12, fontWeight: '700'}}>
            {gpsBusy ? t.align.telem.gpsBusy : `⌖ ${t.align.telem.gps}`}
          </Text>
        </TouchableOpacity>
      </View>
      <Text style={{color: c.textFaint, fontSize: 11, marginTop: 4}}>
        {t.align.telem.site}: {site.name} — {site.latDeg.toFixed(4)}°, {site.lonDeg.toFixed(4)}°
        {acc > 0 ? `  ·  ${t.align.telem.accuracy} ${'★'.repeat(Math.max(1, Math.min(3, acc)))}` : ''}
      </Text>

      {/* Orientation brute du téléphone */}
      <View style={[s.row, {marginTop: 10}]}>
        <Readout label={t.align.telem.az} value={orient ? orient.azimuthDeg.toFixed(1) : '--'} unit="°" />
        <Readout label={t.align.telem.alt} value={orient ? orient.pitchDeg.toFixed(1) : '--'} unit="°" />
        <Readout label="Roll" value={orient ? orient.rollDeg.toFixed(1) : '--'} unit="°" />
      </View>

      {/* Pointage live recalé */}
      <View
        style={{
          backgroundColor: c.bgPanel2,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: c.border,
          padding: 10,
          marginTop: 10,
        }}>
        <Text style={{color: c.textDim, fontSize: 11, letterSpacing: 1}}>
          {live ? t.align.telem.live : t.align.telem.liveOff}
        </Text>
        {live ? (
          <>
            <Text style={{color: c.amber, fontSize: 17, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums']}}>
              {raDegToHMS(live.raDeg)}  {decDegToDMS(live.decDeg)}
            </Text>
            <Text style={{color: c.textFaint, fontSize: 12}}>
              {t.align.telem.az} {live.azDeg.toFixed(1)}° · {t.align.telem.alt} {live.altDeg.toFixed(1)}°
            </Text>
            {deltaArcmin != null ? (
              <Text style={{color: deltaArcmin < 30 ? c.green : c.orange, fontSize: 12, marginTop: 2}}>
                {t.align.telem.delta}: {deltaArcmin.toFixed(1)}′
              </Text>
            ) : null}
          </>
        ) : null}
      </View>

      {/* Choix de l'objet */}
      <Text style={{color: c.textDim, fontSize: 12, marginTop: 12, marginBottom: 6}}>{t.align.telem.pick}</Text>
      <Segmented<'stars' | 'manual'>
        value={pick}
        onChange={setPick}
        options={[
          {key: 'stars', label: t.align.telem.pickStars},
          {key: 'manual', label: t.align.telem.pickManual},
        ]}
      />
      {pick === 'stars' ? (
        <View style={{marginTop: 4}}>
          {stars.map((st) => (
            <TouchableOpacity
              key={st.id}
              onPress={() => setStarId(st.id)}
              style={[s.row, s.between, {paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border}]}>
              <Text style={{color: starId === st.id ? c.amber : c.text, fontWeight: '600', fontSize: 14}}>{st.name}</Text>
              <Text style={{color: c.textFaint, fontSize: 12}}>
                {st.altDeg.toFixed(0)}° · mag {st.mag.toFixed(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : (
        <View style={{marginTop: 4}}>
          <Input label={t.align.telem.manualRa} value={raTxt} onChangeText={setRaTxt} placeholder="05:34:31" autoCapitalize="none" />
          <Input label={t.align.telem.manualDec} value={decTxt} onChangeText={setDecTxt} placeholder="+22:00" autoCapitalize="none" />
          {!manual && (raTxt !== '' || decTxt !== '') ? (
            <Text style={{color: c.orange, fontSize: 12, marginBottom: 6}}>{t.align.telem.manualBad}</Text>
          ) : null}
        </View>
      )}

      {/* Validation */}
      <Toggle value={syncAfter} onChange={setSyncAfter} label={t.align.telem.syncAfter} />
      <Btn
        label={t.align.telem.validate}
        variant="primary"
        disabled={busy || !selected || !hasQuat}
        onPress={validate}
        style={{marginTop: 8}}
      />

      {/* Points enregistrés + qualité */}
      <View style={[s.row, s.between, {marginTop: 14}]}>
        <Text style={{color: c.text, fontWeight: '700', fontSize: 13}}>
          {t.align.telem.points} ({points.length})
        </Text>
        {points.length ? (
          <TouchableOpacity onPress={clearPoints}>
            <Text style={{color: c.red, fontSize: 12}}>{t.align.telem.clear}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {fit && rmsArcmin != null ? (
        <Text style={{color: c.textDim, fontSize: 12, marginTop: 2}}>
          {t.align.telem.rms}: {rmsArcmin < 1 ? '<1' : rmsArcmin.toFixed(1)}′
          {' — '}
          {points.length >= 3 ? t.align.telem.goodHint : t.align.telem.refineHint}
        </Text>
      ) : (
        <Text style={{color: c.textFaint, fontSize: 12, marginTop: 2}}>{t.align.telem.none}</Text>
      )}
      {points.map((p, i) => (
        <View key={p.id} style={[s.row, s.between, {paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border}]}>
          <View style={{flex: 1, marginRight: 8}}>
            <Text style={{color: c.text, fontSize: 13, fontWeight: '600'}}>{p.name}</Text>
            <Text style={{color: c.textFaint, fontSize: 11}}>
              {raDegToHMS(p.raDeg)} {decDegToDMS(p.decDeg)}
              {fit ? ` · ${t.align.telem.residual} ${(fit.residualsDeg[i] * 60).toFixed(1)}′` : ''}
            </Text>
          </View>
          <TouchableOpacity onPress={() => removePoint(p.id)}>
            <Text style={{color: c.red, fontSize: 16, fontWeight: '700'}}>✕</Text>
          </TouchableOpacity>
        </View>
      ))}

      {/* Conseils précision */}
      <Text style={{color: c.textDim, fontSize: 12, fontWeight: '700', marginTop: 12}}>{t.align.telem.tips}</Text>
      <Text style={{color: c.textFaint, fontSize: 12, lineHeight: 18, marginTop: 4}}>{t.align.telem.tipsBody}</Text>
    </Card>
  );
}
