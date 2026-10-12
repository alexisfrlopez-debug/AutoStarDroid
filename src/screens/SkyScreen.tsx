/**
 * CARTE DU CIEL interactive (v2.3.0 — demande utilisateur : « une carte du
 * ciel interactive qui affiche ce que voit le chercheur, la possibilité de
 * sélectionner un objet et faire le goto dessus ; lors de ce goto, l'appli
 * compare l'évolution de la télémétrie du téléphone et le mouvement des
 * moteurs, en vérifiant que la télémétrie est suffisamment fluide pour se
 * caler dessus »).
 *
 * - PROJECTION gnomonique (astro/skyview.ts) centrée sur la direction
 *   COURANTE du télescope (position raquette), à défaut sur l'orientation
 *   du téléphone (télémétrie), à défaut pan manuel ;
 * - CHAMP CHERCHEUR 5° avec réticule (cercle de champ vrai, même dézoomé),
 *   ou vue large 15°/45° pour choisir une cible ;
 * - SÉLECTION tactile d'un objet → fiche → GOTO / cible de suivi ;
 * - CONTRÔLE CROISÉ : pendant chaque GOTO, la carte affiche en live l'arc
 *   parcouru selon les moteurs (gyro intégré) et selon la télémétrie, puis
 *   le verdict de fluidité (gotocheck) — une télémétrie instable BLOQUE le
 *   réglage fin automatique (cf. fineTune.ts).
 */
import {useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, Modal, PanResponder, Alert,
} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {useTrackingStore} from '../store/trackingStore';
import {useGotoCheckStore} from '../store/gotoCheckStore';
import {autostar, gotoErrorText} from '../services/protocol/client';
import {raDecToAltAz} from '../services/astro/coords';
import {raDegToHMS, decDegToDMS} from '../services/astro/time';
import {projectView, fovCircleRadiusPx, panCenter, type ViewGeometry, type PlacedItem} from '../services/astro/skyview';
import {MESSIER, NGC_FAMOUS, BRIGHT_STARS, planetObjects, withAlt, DisplayObject} from '../services/catalog';
import type {SkyObject} from '../services/catalog/types';
import {startOrientation, type Orientation} from '../services/phone/sensors';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, Card, Segmented, Toggle, Title, usePal, s} from '../components/ui';

type Fov = 'finder' | 'mid' | 'wide';
const FOV_DEG: Record<Fov, number> = {finder: 5, mid: 15, wide: 45};
const FINDER_FOV = 5;
const TAP_RADIUS_PX = 26;

/** Taille du point (px) selon la magnitude. */
function dotSize(mag: number): number {
  if (mag < 1) return 8;
  if (mag < 2) return 7;
  if (mag < 3) return 6;
  if (mag < 4.5) return 5;
  return 4;
}

export function SkyScreen({navigation}: {navigation?: {navigate: (s: string) => void}}) {
  const t = useT();
  const c = usePal();
  const site = useSettingsStore((st) => st.site);
  const declinationDeg = useSettingsStore((st) => st.declinationDeg);
  const connStatus = useScopeStore((st) => st.connStatus);
  const hasPos = useScopeStore((st) => st.hasPos);
  const raDeg = useScopeStore((st) => st.raDeg);
  const decDeg = useScopeStore((st) => st.decDeg);
  const targetRa = useScopeStore((st) => st.targetRaDeg);
  const targetDec = useScopeStore((st) => st.targetDecDeg);
  const setTarget = useScopeStore((st) => st.setTarget);
  const setTrackTarget = useTrackingStore((st) => st.setTarget);

  const [fov, setFov] = useState<Fov>('finder');
  const [mirror, setMirror] = useState(false);
  const [tick, setTick] = useState(0);
  const [size, setSize] = useState({w: 320, h: 320});
  const [manual, setManual] = useState<{altDeg: number; azDeg: number} | null>(null);
  const [phoneOrient, setPhoneOrient] = useState<Orientation | null>(null);
  const [selected, setSelected] = useState<DisplayObject | null>(null);

  // Horloge de la carte : 1 Hz (positions célestes + centrage auto)
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Orientation du téléphone (centrage de secours) — flux léger 5 Hz
  useEffect(() => {
    if (connStatus === 'connected' && hasPos) return; // le télescope prime
    const rel = startOrientation((o) => setPhoneOrient(o), 200);
    return rel;
  }, [connStatus, hasPos]);

  // Centre de la carte : télescope > téléphone > pan manuel
  const center = useMemo(() => {
    const nowD = new Date();
    if (connStatus === 'connected' && hasPos) {
      const aa = raDecToAltAz(raDeg, decDeg, site.latDeg, site.lonDeg, nowD);
      return {altDeg: aa.altDeg, azDeg: aa.azDeg, src: 'scope' as const};
    }
    if (phoneOrient && !manual) {
      return {
        altDeg: Math.max(1, Math.min(89, phoneOrient.pitchDeg)),
        azDeg: ((phoneOrient.azimuthDeg + declinationDeg) % 360 + 360) % 360,
        src: 'phone' as const,
      };
    }
    return {altDeg: manual?.altDeg ?? 35, azDeg: manual?.azDeg ?? 180, src: manual ? ('manual' as const) : ('phone' as const)};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, connStatus, hasPos, raDeg, decDeg, site.latDeg, site.lonDeg, phoneOrient, manual, declinationDeg]);

  const geom: ViewGeometry = useMemo(() => ({
    centerAltDeg: center.altDeg,
    centerAzDeg: center.azDeg,
    fovDeg: FOV_DEG[fov],
    width: size.w,
    height: size.h,
    mirror,
  }), [center.altDeg, center.azDeg, fov, size.w, size.h, mirror]);

  // Catalogue projeté (étoiles + Messier + NGC célèbres + planètes)
  const placed = useMemo(() => {
    const nowD = new Date();
    const base: SkyObject[] = [...BRIGHT_STARS, ...MESSIER, ...NGC_FAMOUS];
    const withPos: DisplayObject[] = withAlt(base, site.latDeg, site.lonDeg, nowD)
      .concat(planetObjects(site.latDeg, site.lonDeg, nowD, t));
    const items = projectView(withPos, geom);
    return items
      .filter((p) => p.visible && p.sepDeg < FOV_DEG[fov] * 0.72)
      .sort((a, b) => b.item.mag - a.item.mag); // les brillants dessinés EN DERNIER
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, geom, site.latDeg, site.lonDeg, fov]);

  // Cible de suivi (anneau)
  const targetMark = useMemo(() => {
    if (targetRa == null || targetDec == null) return null;
    const aa = raDecToAltAz(targetRa, targetDec, site.latDeg, site.lonDeg, new Date());
    const [p] = projectView([{altDeg: aa.altDeg, azDeg: aa.azDeg}], geom);
    return p.visible ? p : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRa, targetDec, tick, geom, site.latDeg, site.lonDeg]);

  // Valeurs à JOUR pour les callbacks du PanResponder (créé une seule fois —
  // les closures captureraient sinon le premier rendu : pan erratique).
  const live = useRef({center, fov, size});
  live.current = {center, fov, size};

  // Pan + tap (PanResponder : glisser = explorer, tap = sélection)
  const drag = useRef<{x: number; y: number; moved: boolean} | null>(null);
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      drag.current = {x: e.nativeEvent.locationX, y: e.nativeEvent.locationY, moved: false};
    },
    onPanResponderMove: (e) => {
      if (!drag.current) return;
      const dx = e.nativeEvent.locationX - drag.current.x;
      const dy = e.nativeEvent.locationY - drag.current.y;
      if (!drag.current.moved && Math.abs(dx) + Math.abs(dy) < 7) return;
      drag.current.moved = true;
      drag.current.x = e.nativeEvent.locationX;
      drag.current.y = e.nativeEvent.locationY;
      const {center: ctr, fov: f, size: sz} = live.current;
      const nc = panCenter(ctr.altDeg, ctr.azDeg, dx, dy, {fovDeg: FOV_DEG[f], width: sz.w, height: sz.h});
      setManual({altDeg: nc.altDeg, azDeg: nc.azDeg});
    },
    onPanResponderRelease: (e) => {
      const wasTap = drag.current && !drag.current.moved;
      drag.current = null;
      if (!wasTap) return;
      const tx = e.nativeEvent.locationX;
      const ty = e.nativeEvent.locationY;
      let best: PlacedItem<DisplayObject> | null = null;
      for (const p of placed as Array<PlacedItem<DisplayObject>>) {
        const d = Math.hypot(p.x - tx, p.y - ty);
        const r = Math.max(TAP_RADIUS_PX, dotSize(p.item.mag) + 8);
        if (d <= r && (!best || d < Math.hypot(best.x - tx, best.y - ty))) best = p;
      }
      if (best) setSelected(best.item);
    },
  })).current;

  const doGoto = async (o: DisplayObject) => {
    setSelected(null);
    setTarget(o.raDeg, o.decDeg, o.name);
    setTrackTarget({name: o.name, raDeg: o.raDeg, decDeg: o.decDeg, moving: o.type === 'PLANET' || o.type === 'MOON' || o.type === 'SUN' ? o.id.replace('PLANET_', '') : null, from: 'catalog'});
    if (connStatus !== 'connected') {
      navigation?.navigate('Connect');
      return;
    }
    try {
      const r = await autostar.gotoRaDec(o.raDeg, o.decDeg);
      const msg = gotoErrorText(r, {
        belowHorizon: t.objects.belowHorizon, empty: t.objects.empty,
        gotoNoLink: t.errors.gotoNoLink, gotoMute: t.errors.gotoMute, refused: t.errors.refused,
      });
      if (msg) Alert.alert(t.common.error, msg);
    } catch (e) {
      Alert.alert(t.common.error, (e as Error).message);
    }
  };

  const gc = useGotoCheckStore();
  const finderR = fovCircleRadiusPx(FINDER_FOV, geom);
  const reticleR = Math.min(size.w, size.h) / 2 - 14;
  const cross = Math.min(size.w, size.h) * 0.06;

  return (
    <View style={{flex: 1, backgroundColor: c.bg, padding: 12, paddingTop: 0}}>
      <StatusHeader />
      <View style={{marginTop: 8}}>
        <Segmented<Fov>
          value={fov}
          onChange={(f) => setFov(f)}
          options={[
            {key: 'finder', label: t.sky.fovFinder},
            {key: 'mid', label: t.sky.fovMid},
            {key: 'wide', label: t.sky.fovWide},
          ]}
        />
      </View>
      <Toggle value={mirror} onChange={setMirror} label={t.sky.mirror} />

      {/* ---------- CIEL ---------- */}
      <View
        {...pan.panHandlers}
        onLayout={(e) => setSize({w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height})}
        style={{
          flex: 1, borderRadius: 14, borderWidth: 1, borderColor: c.border,
          backgroundColor: '#04060C', overflow: 'hidden', marginTop: 2,
        }}>
        {/* réticule chercheur : cercle de champ VRAI + cercle externe + croix */}
        <View style={{
          position: 'absolute', left: size.w / 2 - finderR, top: size.h / 2 - finderR,
          width: finderR * 2, height: finderR * 2, borderRadius: finderR,
          borderWidth: 1, borderColor: 'rgba(232,184,75,0.85)',
        }} pointerEvents="none" />
        <View style={{
          position: 'absolute', left: size.w / 2 - reticleR, top: size.h / 2 - reticleR,
          width: reticleR * 2, height: reticleR * 2, borderRadius: reticleR,
          borderWidth: 1, borderColor: 'rgba(232,184,75,0.30)',
        }} pointerEvents="none" />
        <View style={{position: 'absolute', left: size.w / 2 - cross / 2, top: size.h / 2 - 0.5, width: cross, height: 1, backgroundColor: 'rgba(232,184,75,0.7)'}} pointerEvents="none" />
        <View style={{position: 'absolute', left: size.w / 2 - 0.5, top: size.h / 2 - cross / 2, width: 1, height: cross, backgroundColor: 'rgba(232,184,75,0.7)'}} pointerEvents="none" />

        {/* cible de suivi : anneau vert */}
        {targetMark ? (
          <View style={{
            position: 'absolute', left: targetMark.x - 11, top: targetMark.y - 11,
            width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: c.green,
          }} pointerEvents="none" />
        ) : null}

        {/* objets */}
        {(placed as Array<PlacedItem<DisplayObject>>).map((p) => {
          const sz = dotSize(p.item.mag);
          const col = p.item.type === 'PLANET' || p.item.type === 'MOON' || p.item.type === 'SUN' ? c.green
            : p.item.type === 'STAR' || p.item.type === 'DOUBLE_STAR' ? '#DDE4EE'
            : c.amber;
          const labeled = fov === 'finder' || p.item.mag < 2.2;
          return (
            <View key={p.item.id} pointerEvents="none"
              style={{position: 'absolute', left: p.x - sz / 2, top: p.y - sz / 2, width: sz, height: sz, borderRadius: sz / 2, backgroundColor: col, opacity: 0.95}}>
              {labeled && p.sepDeg < FOV_DEG[fov] * 0.5 ? (
                <Text style={{position: 'absolute', left: sz + 2, top: -3, color: c.textDim, fontSize: 9}}>
                  {p.item.name}
                </Text>
              ) : null}
            </View>
          );
        })}

        {/* boussole de bord (E/O) + hint */}
        <Text style={{position: 'absolute', left: 8, bottom: 4, color: c.textFaint, fontSize: 10}}>E {mirror ? '←' : '→'}</Text>
        <Text style={{position: 'absolute', right: 8, bottom: 4, color: c.textFaint, fontSize: 10}}>{mirror ? '→' : '←'} O</Text>
        <Text style={{position: 'absolute', left: 8, top: 4, color: c.textFaint, fontSize: 10}}>{t.sky.tapHint}</Text>
        <Text style={{position: 'absolute', right: 8, top: 4, color: c.textFaint, fontSize: 10}}>
          {center.src === 'scope' ? t.sky.followScope : center.src === 'phone' ? t.sky.followPhone : t.sky.followManual}
        </Text>
      </View>

      {manual ? (
        <Btn label={t.sky.recenter} variant="ghost" onPress={() => setManual(null)} style={{marginTop: 6}} />
      ) : null}

      {/* ---------- CONTRÔLE CROISÉ GOTO ---------- */}
      {gc.state !== 'idle' ? (
        <Card style={{marginTop: 8}}>
          <Title text={t.sky.gotoCard} />
          {gc.state === 'monitoring' ? (
            gc.noSensors ? (
              <Text style={{color: c.textDim, fontSize: 12}}>{t.sky.noSensors}</Text>
            ) : (
              <>
                <Text style={{color: c.amber, fontSize: 13, fontWeight: '700'}}>
                  {t.sky.monitoring}{gc.targetName ? ` — ${gc.targetName}` : ''}
                </Text>
                <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 13, marginTop: 4}}>
                  {t.sky.motors} {gc.liveGyroDeg.toFixed(1)}°  ·  {t.sky.tele} {gc.liveTeleDeg.toFixed(1)}°
                </Text>
              </>
            )
          ) : gc.report ? (
            <>
              <Text style={{
                color: gc.report.verdict === 'good' ? c.green : gc.report.verdict === 'poor' ? c.orange : c.textDim,
                fontSize: 13, fontWeight: '700',
              }}>
                {gc.report.verdict === 'good' ? t.sky.qGood : gc.report.verdict === 'poor' ? t.sky.qPoor : t.sky.qUnknown}
              </Text>
              <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 13, marginTop: 4}}>
                {t.sky.motors} {gc.report.gyroDeg.toFixed(1)}°  ·  {t.sky.tele} {gc.report.teleDeg.toFixed(1)}°
                {gc.report.ratio != null ? `  ·  ${t.sky.ratio} ${gc.report.ratio.toFixed(2)}` : ''}
              </Text>
              {gc.report.reasons.length ? (
                <Text style={{color: c.orange, fontSize: 12, marginTop: 3}}>
                  {gc.report.reasons.map((k) => (t.sky as Record<string, string>)[k] ?? k).join(' · ')}
                </Text>
              ) : null}
            </>
          ) : null}
        </Card>
      ) : null}

      {/* ---------- FICHE OBJET ---------- */}
      <Modal visible={selected !== null} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={{flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'}}>
          {selected ? (
            <View style={{backgroundColor: c.bg, borderRadius: 18, padding: 18, borderWidth: 1, borderColor: c.border}}>
              <Text style={{color: c.amber, fontSize: 20, fontWeight: '800'}}>{selected.name}</Text>
              <Text style={{color: c.textDim, fontSize: 13, marginTop: 2}}>
                {selected.id} — {t.types[selected.type] ?? selected.type}
              </Text>
              <View style={{marginTop: 12, backgroundColor: c.bgPanel, borderRadius: 10, padding: 10}}>
                <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 13}}>
                  RA  {raDegToHMS(selected.raDeg)}   DEC  {decDegToDMS(selected.decDeg)}
                </Text>
                <Text style={{color: c.textDim, fontFamily: 'monospace', fontSize: 12, marginTop: 4}}>
                  {t.objects.altitudeNow} : {selected.altDeg.toFixed(1)}° / Az {selected.azDeg.toFixed(1)}°
                  {selected.mag < 90 ? `   ${t.objects.mag} ${selected.mag.toFixed(1)}` : ''}
                </Text>
              </View>
              <View style={[s.row, {marginTop: 14}]}>
                <Btn label={t.objects.goto} variant="primary" style={{flex: 1, marginRight: 6}}
                  onPress={() => void doGoto(selected)} />
                <Btn label={t.objects.set} style={{flex: 1, marginLeft: 6}}
                  onPress={() => {
                    setTarget(selected.raDeg, selected.decDeg, selected.name);
                    setTrackTarget({name: selected.name, raDeg: selected.raDeg, decDeg: selected.decDeg, moving: null, from: 'catalog'});
                    setSelected(null);
                  }} />
              </View>
              <Btn label={t.common.close} variant="ghost" onPress={() => setSelected(null)} style={{marginTop: 8}} />
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}
