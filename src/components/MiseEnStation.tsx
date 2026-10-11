/**
 * Mise en station assistée par les capteurs du téléphone :
 *  1. Niveau à bulle électronique (accéléromètre) — base de la monture ;
 *  2. Inclinomètre de l'axe horaire (pitch vs latitude du site) ;
 *  3. Boussole + visée Polaris (azimut vrai corrigé de la déclinaison) ;
 *  4. Site GPS : acquisition + envoi date/heure/site vers la raquette.
 *
 * Méthode recommandée : caler le téléphone à plat sur la base (étape 1),
 * puis le long du tube / de l'axe horaire, bord supérieur pointé vers
 * l'étoile polaire (étapes 2-3), et régler la monture jusqu'à Δ ≈ 0.
 */
import {useEffect, useMemo, useRef, useState} from 'react';
import {Text, View, TouchableOpacity} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {autostar} from '../services/protocol/client';
import {Card, Title, Btn, Input, Readout, usePal} from './ui';
import {startOrientation, sensorsAvailable, type Orientation, type SensorsAvailability} from '../services/phone/sensors';
import {getPhonePosition, type PhonePos} from '../services/phone/gps';
import {bubbleOffset, polarAxisErrors, polarisAltAz, trueHeadingDeg} from '../services/astro/alignment';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmtDeg = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}°`;

export function MiseEnStation() {
  const t = useT();
  const c = usePal();
  const site = useSettingsStore((s) => s.site);
  const setSite = useSettingsStore((s) => s.setSite);
  const declination = useSettingsStore((s) => s.declinationDeg);
  const setDeclination = useSettingsStore((s) => s.setDeclinationDeg);
  const connStatus = useScopeStore((s) => s.connStatus);
  const connected = connStatus === 'connected';

  const [orient, setOrient] = useState<Orientation | null>(null);
  const [avail, setAvail] = useState<SensorsAvailability | null>(null);
  const [pos, setPos] = useState<PhonePos | null>(null);
  const [invertAlt, setInvertAlt] = useState(false);
  const [msg, setMsg] = useState('');
  /** Nettoyage des timers de message : un setState après unmount est un
   *  warning React (et casse les suites de tests qui se suivent). */
  const alive = useRef(true);
  const msgTimers = useRef<number[]>([]);
  useEffect(() => () => {
    alive.current = false;
    msgTimers.current.forEach((id) => clearTimeout(id));
  }, []);
  const laterClear = (ms: number) => {
    msgTimers.current.push(
      setTimeout(() => {if (alive.current) setMsg('');}, ms) as unknown as number,
    );
  };

  useEffect(() => {
    sensorsAvailable().then(setAvail);
    const stop = startOrientation(setOrient, 100);
    return stop;
  }, []);

  /* ---------- Dérivés ---------- */
  const pitch = orient?.pitchDeg ?? 0;
  const roll = orient?.rollDeg ?? 0;
  const az = orient?.azimuthDeg ?? 0;
  const level = bubbleOffset(pitch, roll);
  const levelOk = level.deg < 0.5;

  const lat = pos?.latDeg ?? site.latDeg;
  const lon = pos?.lonDeg ?? site.lonDeg;
  const pitchAdj = invertAlt ? -pitch : pitch;
  const errors = polarAxisErrors(trueHeadingDeg(az, declination), pitchAdj, lat);

  const polaris = useMemo(
    () => polarisAltAz(lat, lon, new Date()),
    // recalcul léger à chaque rendu (10 Hz) — math pure, coût négligeable
    [lat, lon],
  );

  const deltaColor = (d: number, good: number, mid: number) =>
    Math.abs(d) <= good ? c.green : Math.abs(d) <= mid ? c.orange : c.red;

  async function grabGps() {
    try {
      setMsg(t.station.gps.sending);
      const p = await getPhonePosition();
      if (!alive.current) return; // résolu après démontage : no-op
      setPos(p);
      setSite({name: 'GPS', latDeg: p.latDeg, lonDeg: p.lonDeg, elevM: Math.round(p.elevM)});
      setMsg(t.station.gps.sent);
    } catch (e) {
      if (!alive.current) return;
      setMsg(`${t.station.gps.failed}: ${(e as Error).message}`);
    }
    laterClear(4000);
  }

  async function pushSite() {
    if (!connected) {setMsg(t.errors.notConnected); return;}
    try {
      setMsg(t.station.gps.sending);
      await autostar.pushPhoneData(site.latDeg, site.lonDeg);
      if (!alive.current) return;
      setMsg(t.station.gps.sent);
    } catch (e) {
      if (!alive.current) return;
      setMsg(`${t.station.gps.failed}: ${(e as Error).message}`);
    }
    laterClear(4000);
  }

  /* ---------- Rendu ---------- */
  return (
    <View>
      {msg ? (
        <Text style={{color: c.orange, fontSize: 12, marginBottom: 6, textAlign: 'center'}}>{msg}</Text>
      ) : null}

      {avail && !avail.rotationVector ? (
        <Card style={{marginBottom: 10}}>
          <Text style={{color: c.red, fontSize: 12, lineHeight: 17}}>{t.station.noSensors}</Text>
        </Card>
      ) : null}
      {avail && avail.rotationVector && !avail.magnetometer ? (
        <Card style={{marginBottom: 10}}>
          <Text style={{color: c.orange, fontSize: 12, lineHeight: 17}}>{t.station.noCompass}</Text>
        </Card>
      ) : null}

      {/* 1 — Niveau à bulle */}
      <Card style={{marginBottom: 10}}>
        <Title text={`1 · ${t.station.level.title}`} />
        <View style={{flexDirection: 'row', alignItems: 'center'}}>
          <View style={{
            width: 150, height: 150, borderRadius: 75, borderWidth: 2, borderColor: c.border,
            backgroundColor: c.bgPanel2, alignItems: 'center', justifyContent: 'center', marginRight: 14,
          }}>
            {/* cercle central : niveau parfait */}
            <View style={{
              position: 'absolute', width: 60, height: 60, borderRadius: 30,
              borderWidth: 1, borderColor: levelOk ? c.green : c.border, borderStyle: 'dashed',
            }} />
            {/* bulle */}
            <View style={{
              position: 'absolute',
              width: 26, height: 26, borderRadius: 13,
              backgroundColor: levelOk ? c.green : c.amber,
              opacity: orient ? 0.95 : 0.25,
              transform: [
                {translateX: clamp(level.x, -6, 6) / 6 * 62},
                {translateY: -clamp(level.y, -6, 6) / 6 * 62},
              ],
            }} />
          </View>
          <View style={{flex: 1}}>
            <Readout label={t.station.level.pitch} value={fmtDeg(pitch)} />
            <Readout label={t.station.level.roll} value={fmtDeg(roll)} />
            <Text style={{color: levelOk ? c.green : c.textDim, fontSize: 12, marginTop: 4, fontWeight: '600'}}>
              {levelOk ? t.station.level.ok : t.station.level.adjust}
            </Text>
          </View>
        </View>
        <Text style={{color: c.textFaint, fontSize: 11, marginTop: 8, lineHeight: 16}}>{t.station.level.hint}</Text>
      </Card>

      {/* 2 — Axe horaire (inclinomètre) */}
      <Card style={{marginBottom: 10}}>
        <Title text={`2 · ${t.station.axis.title}`} />
        <View style={{flexDirection: 'row'}}>
          <Readout label={t.station.axis.current} value={fmtDeg(pitchAdj)} unit="°" />
          <Readout label={`${t.station.axis.target} (${lat >= 0 ? 'N' : 'S'})`} value={fmtDeg(Math.abs(lat))} unit="°" />
          <Readout label="Δ" value={fmtDeg(errors.altErrorDeg)} unit="°" />
        </View>
        {/* jauge d'écart */}
        <View style={{height: 8, borderRadius: 4, backgroundColor: c.bgPanel2, marginTop: 8, overflow: 'hidden', position: 'relative'}}>
          <View style={{position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, backgroundColor: c.textFaint}} />
          <View style={{
            position: 'absolute', top: 0, bottom: 0, width: 6, borderRadius: 3,
            backgroundColor: deltaColor(errors.altErrorDeg, 1, 3),
            left: `${50 + clamp(errors.altErrorDeg / 10, -1, 1) * 48}%`,
          }} />
        </View>
        <TouchableOpacity onPress={() => setInvertAlt(!invertAlt)} style={{marginTop: 10}}>
          <Text style={{color: c.blue, fontSize: 12, fontWeight: '600'}}>
            {invertAlt ? t.station.axis.inverted : t.station.axis.invert}
          </Text>
        </TouchableOpacity>
        <Text style={{color: c.textFaint, fontSize: 11, marginTop: 8, lineHeight: 16}}>{t.station.axis.hint}</Text>
      </Card>

      {/* 3 — Boussole / Polaris */}
      <Card style={{marginBottom: 10}}>
        <Title text={`3 · ${t.station.compass.title}`} />
        <View style={{flexDirection: 'row', alignItems: 'center'}}>
          <View style={{width: 150, height: 150, marginRight: 14, alignItems: 'center', justifyContent: 'center'}}>
            {/* rose : le Nord tourne à l'opposé du cap du téléphone */}
            <View style={{
              position: 'absolute', width: 150, height: 150, borderRadius: 75,
              borderWidth: 2, borderColor: c.border, backgroundColor: c.bgPanel2,
              transform: [{rotate: `${-az}deg`}],
              alignItems: 'center', justifyContent: 'flex-start',
            }}>
              <Text style={{color: c.red, fontWeight: '800', fontSize: 15, marginTop: 6}}>N</Text>
              <View style={{width: 2, height: 40, backgroundColor: c.red, marginTop: 2}} />
            </View>
            {/* aiguille de visée : bord supérieur du téléphone */}
            <View style={{width: 4, height: 66, borderRadius: 2, backgroundColor: c.amber, marginBottom: 60}} />
          </View>
          <View style={{flex: 1}}>
            <Readout label={t.station.compass.mag} value={`${az.toFixed(0)}°`} />
            <Readout label={t.station.compass.trueH} value={`${trueHeadingDeg(az, declination).toFixed(0)}°`} />
            <Text style={{color: deltaColor(errors.azErrorDeg, 2, 5), fontSize: 12, marginTop: 4, fontWeight: '700'}}>
              Δaz {fmtDeg(errors.azErrorDeg)}   Δalt {fmtDeg(errors.altErrorDeg)}
            </Text>
          </View>
        </View>
        <Text style={{color: c.textDim, fontSize: 11, marginTop: 8, lineHeight: 16}}>
          {t.station.compass.polaris}: AZ {polaris.azDeg.toFixed(1)}° · {t.station.compass.alt} {polaris.altDeg.toFixed(1)}°
        </Text>
        <Text style={{color: c.textFaint, fontSize: 11, marginTop: 6, lineHeight: 16}}>{t.station.compass.hint}</Text>
      </Card>

      {/* 4 — Site GPS */}
      <Card style={{marginBottom: 10}}>
        <Title text={`4 · ${t.station.gps.title}`} />
        <View style={{flexDirection: 'row', marginBottom: 8}}>
          <Readout label={t.setup.lat} value={`${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}`} />
          <Readout label={t.setup.lon} value={`${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`} />
          <Readout label={t.setup.elev} value={`${Math.round(pos?.elevM ?? site.elevM)}`} unit="m" />
        </View>
        <View style={{flexDirection: 'row', gap: 8}}>
          <Btn label={t.station.gps.get} onPress={grabGps} style={{flex: 1}} />
          <Btn label={t.station.gps.sendTo} onPress={pushSite} disabled={!connected} variant={connected ? 'primary' : 'normal'} style={{flex: 1}} />
        </View>
        <Input
          label={`${t.station.gps.declination} (${t.station.gps.declHint})`}
          keyboardType="decimal-pad"
          value={String(declination)}
          onChangeText={(v) => {
            const n = parseFloat(v.replace(',', '.'));
            if (!isNaN(n)) setDeclination(clamp(n, -30, 30));
          }}
        />
      </Card>

      {/* Méthode */}
      <Card>
        <Title text={t.station.method.title} />
        <Text style={{color: c.textDim, fontSize: 12, lineHeight: 18}}>
          {t.station.method.s1}{'\n'}{t.station.method.s2}{'\n'}{t.station.method.s3}
        </Text>
      </Card>
    </View>
  );
}
