/**
 * CARTE DU CIEL interactive (v2.3.0 — demande utilisateur : « une carte du
 * ciel interactive qui affiche ce que voit le chercheur, la possibilité de
 * sélectionner un objet et faire le goto dessus ; lors de ce goto, l'appli
 * compare l'évolution de la télémétrie du téléphone et le mouvement des
 * moteurs, en vérifiant que la télémétrie est suffisamment fluide pour se
 * caler dessus »).
 *
 * v2.4.0 (retours utilisateur) :
 *  - NOMS DES OBJETS HORIZONTAUX et CLIQUABLES : les étiquettes restent
 *    toujours horizontales, sans chevauchement, et le tap sur le NOM ouvre
 *    la fiche (le tap sur le point aussi) — correction au passage du
 *    `placed` PÉRIMÉ capturé par le PanResponder (le tap ne sélectionnait
 *    plus rien après le premier rendu) ;
 *  - fiche objet : GOTO + SYNC TÉLESCOPE (:Sr/:Sd/:CM — déclare que le
 *    télescope pointe déjà cet objet) + cible de suivi ;
 *  - MONTAGE DU TÉLÉPHONE SUR LE TUBE (astro/phonemount.ts) : pose
 *    portrait/paysage, chemin optique (aligné au tube / 45° oculaire+
 *    prisme / 90° oculaire bout de tube), position dessus/gauche/droite —
 *    la visée du tube est déduite du quaternion des capteurs.
 *
 * - PROJECTION gnomonique (astro/skyview.ts) centrée sur la direction
 *   COURANTE du télescope (position raquette), à défaut sur l'orientation
 *   du téléphone (télémétrie transformée par le montage), à défaut pan
 *   manuel ;
 * - CHAMP CHERCHEUR 5° avec réticule (cercle de champ vrai, même dézoomé),
 *   ou vue large 15°/45° pour choisir une cible ;
 * - CONTRÔLE CROISÉ : pendant chaque GOTO, la carte affiche en live l'arc
 *   parcouru selon les moteurs (gyro intégré) et selon la télémétrie, puis
 *   le verdict de fluidité (gotocheck) — une télémétrie instable BLOQUE le
 *   réglage fin automatique (cf. fineTune.ts).
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, Modal, PanResponder, Alert, TouchableOpacity,
} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {useTrackingStore} from '../store/trackingStore';
import {useGotoCheckStore} from '../store/gotoCheckStore';
import {autostar, gotoErrorText} from '../services/protocol/client';
import {raDecToAltAz} from '../services/astro/coords';
import {raDegToHMS, decDegToDMS} from '../services/astro/time';
import {
  projectView, fovCircleRadiusPx, panCenter, layoutLabels, skyCenter,
  SKY_SCOPE_FRESH_MS, SKY_TARGET_HOLD_MS,
  type ViewGeometry, type PlacedItem, type LabelLayout,
} from '../services/astro/skyview';
import {
  starVisual, planetColor, discRadiusPx, asterismSegments, horizonAzSamples,
} from '../services/astro/skyrender';
import Svg, {Circle, Line, Rect, Defs, RadialGradient, Stop} from 'react-native-svg';
import {
  tubeAltAzFromOrientation, isDefaultMount,
  type PhoneMountConfig, type PhonePose, type PhoneAngle, type PhonePosition,
} from '../services/astro/phonemount';
import {MESSIER, NGC_FAMOUS, BRIGHT_STARS, planetObjects, withAlt, DisplayObject} from '../services/catalog';
import type {SkyObject} from '../services/catalog/types';
import {startOrientation, type Orientation} from '../services/phone/sensors';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, Card, Segmented, Toggle, Title, usePal, s} from '../components/ui';

type Fov = 'finder' | 'mid' | 'wide';
const FOV_DEG: Record<Fov, number> = {finder: 5, mid: 15, wide: 45};
const FINDER_FOV = 5;
const TAP_RADIUS_PX = 26;
type AngleKey = '0' | '45' | '90';

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
  const gotoRunning = useScopeStore((st) => st.gotoRunning);
  const posAt = useScopeStore((st) => st.posAt);
  const targetAt = useScopeStore((st) => st.targetAt);
  const setTarget = useScopeStore((st) => st.setTarget);
  const setTrackTarget = useTrackingStore((st) => st.setTarget);
  const skyMountPose = useSettingsStore((st) => st.skyMountPose);
  const skyMountAngle = useSettingsStore((st) => st.skyMountAngle);
  const skyMountPosition = useSettingsStore((st) => st.skyMountPosition);
  const setSkyMountPose = useSettingsStore((st) => st.setSkyMountPose);
  const setSkyMountAngle = useSettingsStore((st) => st.setSkyMountAngle);
  const setSkyMountPosition = useSettingsStore((st) => st.setSkyMountPosition);

  const [fov, setFov] = useState<Fov>('finder');
  const [mirror, setMirror] = useState(false);
  const [mountOpen, setMountOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [size, setSize] = useState({w: 320, h: 320});
  const [manual, setManual] = useState<{altDeg: number; azDeg: number} | null>(null);
  /** SUIVI DU TÉLESCOPE (v2.9.5) : actif par défaut — la carte colle à la
   *  position de la monture (« suit le chercheur »). Le glisser le COUPE
   *  (exploration libre, marqueur ✛ du télescope visible) ; un GOTO ou le
   *  bouton « ↺ Recentrer » le réarme. v2.9.4 faisait l'inverse (le pan
   *  gagnait jusqu'au GOTO suivant) — la carte paraissait figée. */
  const [follow, setFollow] = useState(true);
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

  // GOTO : le suivi reprend AUTOMATIQUEMENT et la carte part sur la CIBLE
  // (pas de saut vers la position périmée du télescope) — le pan manuel est
  // oublié. (v2.9.4, recentrage cible v2.9.5)
  useEffect(() => {
    if (gotoRunning) {
      setManual(null);
      setFollow(true);
    }
  }, [gotoRunning]);

  // Centre de la carte (v2.9.5 — décision pure skyCenter) : exploration
  // manuelle > cible (GOTO/cible récente) > télescope FRAÎS > téléphone.
  const mountCfg: PhoneMountConfig = useMemo(
    () => ({pose: skyMountPose, angle: skyMountAngle, position: skyMountPosition}),
    [skyMountPose, skyMountAngle, skyMountPosition],
  );
  const center = useMemo(() => {
    const nowD = new Date();
    const toAA = (ra: number, dec: number) =>
      raDecToAltAz(ra, dec, site.latDeg, site.lonDeg, nowD);
    const scopeAA = connStatus === 'connected' && hasPos ? toAA(raDeg, decDeg) : null;
    const targetAA = targetRa != null && targetDec != null ? toAA(targetRa, targetDec) : null;
    let phoneAA: {altDeg: number; azDeg: number} | null = null;
    if (phoneOrient) {
      const tube = tubeAltAzFromOrientation(phoneOrient, mountCfg, declinationDeg);
      if (tube) {
        phoneAA = {altDeg: Math.max(1, Math.min(89, tube.altDeg)), azDeg: tube.azDeg};
      }
    }
    return skyCenter({
      follow,
      manual,
      gotoRunning,
      target: targetAA,
      targetRecent: Date.now() - targetAt < SKY_TARGET_HOLD_MS,
      scope: scopeAA,
      scopeFresh: Date.now() - posAt < SKY_SCOPE_FRESH_MS,
      phone: phoneAA,
      fallback: {altDeg: 35, azDeg: 180},
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, follow, manual, gotoRunning, targetRa, targetDec, targetAt, posAt,
      connStatus, hasPos, raDeg, decDeg, site.latDeg, site.lonDeg, phoneOrient,
      declinationDeg, mountCfg]);

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

  // MARQUEUR DU TÉLESCOPE (v2.9.5) : croix cyan à la position réelle de la
  // monture — visible même en exploration manuelle (« ne suit pas le
  // chercheur » : l'utilisateur voyait une carte immobile SANS savoir où
  // pointait le télescope). En suivi il recouvre le réticule central.
  const scopeMark = useMemo(() => {
    if (connStatus !== 'connected' || !hasPos) return null;
    const aa = raDecToAltAz(raDeg, decDeg, site.latDeg, site.lonDeg, new Date());
    const [p] = projectView([{altDeg: aa.altDeg, azDeg: aa.azDeg}], geom);
    return p.visible ? p : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connStatus, hasPos, raDeg, decDeg, tick, geom, site.latDeg, site.lonDeg]);

  // ÉTIQUETTES HORIZONTALES (v2.4.0) : noms toujours lisibles, sans
  // chevauchement, posés en priorité sur les objets les plus brillants.
  // Le rect renvoyé sert aussi de ZONE CLIQUABLE (tap sur le nom).
  const labelMap = useMemo(() => {
    const brightFirst = [...placed].reverse(); // placed est trié pâles d'abord
    return layoutLabels(brightFirst as Array<PlacedItem<DisplayObject>>, {
      width: size.w,
      height: size.h,
      dotSize: (it) => dotSize(it.mag),
      labelFor: (it, p) => {
        const moving = it.type === 'PLANET' || it.type === 'MOON' || it.type === 'SUN';
        if (fov === 'finder') return p.sepDeg < FOV_DEG[fov] * 0.62 ? it.name : null;
        if (moving || it.mag < (fov === 'mid' ? 3.4 : 2.2)) return it.name;
        return null;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, size.w, size.h, fov]);

  // Valeurs à JOUR pour les callbacks du PanResponder (créé une seule fois —
  // les closures captureraient sinon le premier rendu : pan erratique ET,
  // bug v2.3.0 corrigé ici, `placed` périmé → le tap ne sélectionnait plus
  // aucun objet après le premier rendu).
  const live = useRef({center, fov, size});
  live.current = {center, fov, size};
  const livePlaced = useRef(placed);
  livePlaced.current = placed;
  const liveLabels = useRef(labelMap);
  liveLabels.current = labelMap;

  // ---------- RENDU EMBELLI (v2.5.0) — calculs purs ----------
  /** Échelle px/deg au centre (projection gnomonique : tan). */
  const pxPerDeg = useMemo(() => {
    const rad = Math.PI / 180;
    return (size.w / 2 / Math.tan((FOV_DEG[fov] / 2) * rad)) * (1 * rad);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, fov]);
  const segments = useMemo(() => asterismSegments(placed as Array<PlacedItem<DisplayObject>>), [placed]);

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
      // v2.9.5 : le glisser coupe le SUIVI (exploration libre) — la carte
      // reste où posée ; « ↺ Recentrer » ou un GOTO réarment le suivi.
      setFollow(false);
    },
    onPanResponderRelease: (e) => {
      const wasTap = drag.current && !drag.current.moved;
      drag.current = null;
      if (!wasTap) return;
      const tx = e.nativeEvent.locationX;
      const ty = e.nativeEvent.locationY;
      let bestItem: DisplayObject | null = null;
      let bestD = Infinity;
      // 1) tap sur le POINT (rayon adapté à la taille du point)
      for (const p of livePlaced.current as Array<PlacedItem<DisplayObject>>) {
        const d = Math.hypot(p.x - tx, p.y - ty);
        const r = Math.max(TAP_RADIUS_PX, dotSize(p.item.mag) + 8);
        if (d <= r && d < bestD) {
          bestItem = p.item;
          bestD = d;
        }
      }
      // 2) tap sur le NOM (rectangle de l'étiquette horizontale, aéré)
      for (const [item, lay] of liveLabels.current) {
        if (!lay.show) continue;
        if (tx >= lay.x - 6 && tx <= lay.x + lay.w + 6 && ty >= lay.y - 4 && ty <= lay.y + lay.h + 4) {
          const d = Math.hypot(lay.x + lay.w / 2 - tx, lay.y + lay.h / 2 - ty);
          if (d < bestD) {
            bestItem = item;
            bestD = d;
          }
        }
      }
      if (bestItem) setSelected(bestItem);
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
          relayPartial: t.errors.relayPartial,
      });
      if (msg) Alert.alert(t.common.error, msg);
    } catch (e) {
      Alert.alert(t.common.error, (e as Error).message);
    }
  };

  /** SYNC TÉLESCOPE (v2.4.0) : :Sr/:Sd posent l'objet puis :CM# déclare la
   *  position physique COURANTE = cet objet (après centrage manuel ou GOTO).
   *  Recadre le modèle d'alignement interne de la raquette SANS moteur. */
  const doSync = async (o: DisplayObject) => {
    setSelected(null);
    if (connStatus !== 'connected') {
      navigation?.navigate('Connect');
      return;
    }
    try {
      const ok = await autostar.syncRaDec(o.raDeg, o.decDeg);
      if (ok) {
        Alert.alert(t.sky.syncOk, o.name);
      } else {
        Alert.alert(t.common.error, t.sky.syncFail);
      }
    } catch (e) {
      Alert.alert(t.common.error, (e as Error).message);
    }
  };

  const gc = useGotoCheckStore();
  const finderR = fovCircleRadiusPx(FINDER_FOV, geom);
  const reticleR = Math.min(size.w, size.h) / 2 - 14;
  const cross = Math.min(size.w, size.h) * 0.06;

  // ---------- MONTAGE DU TÉLÉPHONE (textes d'aide dynamiques) ----------
  const help = t.sky.mountHelp as Record<string, string>;
  let mountHelper: string;
  let mountNote: string | null = null;
  if (mountCfg.angle === 45) {
    mountHelper = mountCfg.pose === 'portrait' ? help.a45p : help.a45l;
    mountNote = help.a45note;
  } else if (mountCfg.angle === 90) {
    mountHelper = mountCfg.pose === 'portrait' ? help.a90p : help.a90l;
    mountNote = help.a90note;
  } else {
    const side = mountCfg.position === 'top' ? 'top' : mountCfg.position;
    mountHelper = help[`a0${side}${mountCfg.pose === 'portrait' ? 'P' : 'L'}`];
  }
  const mountSummary = `${mountCfg.pose === 'portrait' ? t.sky.posePortrait : t.sky.poseLandscape}
    · ${mountCfg.angle === 0 ? t.sky.angle0 : mountCfg.angle === 45 ? t.sky.angle45 : t.sky.angle90}
    · ${mountCfg.position === 'top' ? t.sky.posTop : mountCfg.position === 'left' ? t.sky.posLeft : t.sky.posRight}`.replace(/\s+/g, ' ').trim();
  // Le flux capteurs ne tourne que hors centrage télescope : l'avertissement
  // quaternion ne concerne que ce cas (pose avancée non mesurable).
  const quatMissing = phoneOrient != null && typeof phoneOrient.qw !== 'number';
  const mountDirty = !isDefaultMount(mountCfg);

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

      {/* ---------- MONTAGE DU TÉLÉPHONE SUR LE TUBE ---------- */}
      <Card style={{marginTop: 8, paddingVertical: 10, paddingHorizontal: 12}}>
        <TouchableOpacity onPress={() => setMountOpen(!mountOpen)} style={s.row}>
          <Text style={{
            color: c.textDim, fontSize: 12, fontWeight: '700', flex: 1,
            letterSpacing: 0.5, textTransform: 'uppercase',
          }}>
            {t.sky.mountTitle}
          </Text>
          <Text style={{color: c.amber, fontSize: 13}}>{mountOpen ? '▾' : '▸'}</Text>
        </TouchableOpacity>
        {mountOpen ? (
          <>
            <Text style={{color: c.textFaint, fontSize: 11, marginTop: 8}}>{mountHelper}</Text>
            {mountNote ? <Text style={{color: c.textFaint, fontSize: 11, marginTop: 2}}>{mountNote}</Text> : null}
            {quatMissing && mountDirty ? (
              <Text style={{color: c.orange, fontSize: 11, marginTop: 2}}>{t.sky.mountNoQuat}</Text>
            ) : null}
            <Text style={{color: c.textFaint, fontSize: 11, marginTop: 10, marginBottom: 4}}>{t.sky.mountPose}</Text>
            <Segmented<PhonePose>
              value={skyMountPose}
              onChange={setSkyMountPose}
              options={[
                {key: 'portrait', label: t.sky.posePortrait},
                {key: 'landscape', label: t.sky.poseLandscape},
              ]}
            />
            <Text style={{color: c.textFaint, fontSize: 11, marginTop: 10, marginBottom: 4}}>{t.sky.mountAngle}</Text>
            <Segmented<AngleKey>
              value={String(skyMountAngle) as AngleKey}
              onChange={(k) => setSkyMountAngle(Number(k) as PhoneAngle)}
              options={[
                {key: '0', label: t.sky.angle0},
                {key: '45', label: t.sky.angle45},
                {key: '90', label: t.sky.angle90},
              ]}
            />
            <Text style={{color: c.textFaint, fontSize: 11, marginTop: 10, marginBottom: 4}}>{t.sky.mountPosition}</Text>
            <Segmented<PhonePosition>
              value={skyMountPosition}
              onChange={setSkyMountPosition}
              options={[
                {key: 'top', label: t.sky.posTop},
                {key: 'left', label: t.sky.posLeft},
                {key: 'right', label: t.sky.posRight},
              ]}
            />
          </>
        ) : (
          <Text style={{color: c.textFaint, fontSize: 11, marginTop: 6}}>{mountSummary}</Text>
        )}
      </Card>

      {/* ---------- CIEL (rendu SVG v2.5.0) ---------- */}
      <View
        {...pan.panHandlers}
        onLayout={(e) => setSize({w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height})}
        style={{
          flex: 1, borderRadius: 14, borderWidth: 1, borderColor: c.border,
          backgroundColor: '#04060C', overflow: 'hidden', marginTop: 2,
        }}>
        <Svg width={size.w} height={size.h} style={{position: 'absolute', left: 0, top: 0}}>
          <Defs>
            <RadialGradient id="skyGlow" cx="50%" cy="46%" rx="80%" ry="80%">
              <Stop offset="0%" stopColor="#0B1328" stopOpacity="1" />
              <Stop offset="55%" stopColor="#060A18" stopOpacity="1" />
              <Stop offset="100%" stopColor="#02040A" stopOpacity="1" />
            </RadialGradient>
          </Defs>
          {/* fond : vignette nuit profonde */}
          <Rect x={0} y={0} width={size.w} height={size.h} fill="url(#skyGlow)" />

          {/* arc d'horizon (alt 0°) — bleu discret, jamais dominant */}
          {(() => {
            const pts = projectView(horizonAzSamples(), geom);
            const lines: React.ReactNode[] = [];
            for (let i = 1; i < pts.length; i++) {
              const a = pts[i - 1]; const b = pts[i];
              if (a.visible && b.visible && a.x != null && b.x != null) {
                lines.push(<Line key={`hz-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke="rgba(79,163,255,0.30)" strokeWidth={1.4} />);
              }
            }
            return lines;
          })()}

          {/* astérismes : lignes fines entre étoiles du catalogue */}
          {segments.map((sg, i) => (
            <Line key={`ast-${i}`} x1={sg.x1} y1={sg.y1} x2={sg.x2} y2={sg.y2}
              stroke="rgba(143,160,191,0.30)" strokeWidth={0.9} />
          ))}

          {/* étoiles & objets : halos puis noyaux (placed = pâles d'abord) */}
          {(placed as Array<PlacedItem<DisplayObject>>).map((p) => {
            const it = p.item;
            const moving = it.type === 'PLANET' || it.type === 'MOON' || it.type === 'SUN';
            if (moving) {
              const col = planetColor(it.id);
              const r = it.type === 'MOON' || it.type === 'SUN'
                ? discRadiusPx(31, pxPerDeg)
                : Math.max(3.4, 4.6 - Math.min(it.mag, 2));
              return (
                <React.Fragment key={it.id}>
                  <Circle cx={p.x} cy={p.y} r={r * 2.6} fill={col} opacity={0.16} />
                  <Circle cx={p.x} cy={p.y} r={r * 1.5} fill={col} opacity={0.22} />
                  <Circle cx={p.x} cy={p.y} r={r} fill={col} opacity={0.97} />
                </React.Fragment>
              );
            }
            if (it.type === 'STAR' || it.type === 'DOUBLE_STAR' || it.type === 'ASTERISM') {
              const v = starVisual(it.mag);
              return (
                <React.Fragment key={it.id}>
                  <Circle cx={p.x} cy={p.y} r={v.glowR} fill={v.color} opacity={v.glowOpacity} />
                  <Circle cx={p.x} cy={p.y} r={v.glowR * 0.55} fill={v.color} opacity={v.glowOpacity + 0.10} />
                  <Circle cx={p.x} cy={p.y} r={v.coreR} fill={v.color} opacity={0.98} />
                </React.Fragment>
              );
            }
            // ciel profond : cercle de taille apparente + cœur ambré
            const r = it.sizeMin ? discRadiusPx(it.sizeMin, pxPerDeg) : 5;
            return (
              <React.Fragment key={it.id}>
                <Circle cx={p.x} cy={p.y} r={r} fill="none" stroke={c.amber} strokeOpacity={0.55} strokeWidth={1} strokeDasharray="2 2.5" />
                <Circle cx={p.x} cy={p.y} r={Math.max(1.6, r * 0.22)} fill={c.amber} opacity={0.8} />
              </React.Fragment>
            );
          })}

          {/* réticule chercheur : cercle de champ VRAI + cercle externe + croix */}
          <Circle cx={size.w / 2} cy={size.h / 2} r={finderR} fill="none"
            stroke="rgba(232,184,75,0.85)" strokeWidth={1.2} />
          <Circle cx={size.w / 2} cy={size.h / 2} r={reticleR} fill="none"
            stroke="rgba(232,184,75,0.28)" strokeWidth={1} strokeDasharray="3 6" />
          {(() => {
            const cx = size.w / 2; const cy = size.h / 2; const g = 9;
            const L = cross * 2.1;
            return (
              <React.Fragment>
                <Line x1={cx - g - L} y1={cy} x2={cx - g} y2={cy} stroke="rgba(232,184,75,0.7)" strokeWidth={1} />
                <Line x1={cx + g} y1={cy} x2={cx + g + L} y2={cy} stroke="rgba(232,184,75,0.7)" strokeWidth={1} />
                <Line x1={cx} y1={cy - g - L} x2={cx} y2={cy - g} stroke="rgba(232,184,75,0.7)" strokeWidth={1} />
                <Line x1={cx} y1={cy + g} x2={cx} y2={cy + g + L} stroke="rgba(232,184,75,0.7)" strokeWidth={1} />
              </React.Fragment>
            );
          })()}

          {/* cible de suivi : double anneau vert */}
          {targetMark ? (
            <React.Fragment>
              <Circle cx={targetMark.x} cy={targetMark.y} r={11} fill="none"
                stroke={c.green} strokeWidth={1.5} />
              <Circle cx={targetMark.x} cy={targetMark.y} r={16.5} fill="none"
                stroke={c.green} strokeOpacity={0.35} strokeWidth={1} />
            </React.Fragment>
          ) : null}

          {/* TÉLESCOPE : croix cyan à la position réelle de la monture
              (v2.9.5) — visible même en exploration manuelle (« ne suit pas
              le chercheur » : la carte restait immobile SANS montrer où
              pointait le télescope). En suivi il recouvre le réticule. */}
          {scopeMark ? (() => {
            const cx = scopeMark.x; const cy = scopeMark.y;
            const col = '#56C8FF';
            return (
              <React.Fragment>
                <Circle cx={cx} cy={cy} r={9} fill="none" stroke={col} strokeWidth={1.6} />
                <Circle cx={cx} cy={cy} r={1.8} fill={col} />
                <Line x1={cx - 15} y1={cy} x2={cx - 9} y2={cy} stroke={col} strokeWidth={1.3} />
                <Line x1={cx + 9} y1={cy} x2={cx + 15} y2={cy} stroke={col} strokeWidth={1.3} />
                <Line x1={cx} y1={cy - 15} x2={cx} y2={cy - 9} stroke={col} strokeWidth={1.3} />
                <Line x1={cx} y1={cy + 9} x2={cx} y2={cy + 15} stroke={col} strokeWidth={1.3} />
              </React.Fragment>
            );
          })() : null}
        </Svg>

        {/* étiquettes horizontales (v2.4.0) : TOUJOURS horizontales,
            posées à côté des points, zone cliquable gérée par le tap */}
        {Array.from(labelMap.entries()).map(([item, lay]) => (lay as LabelLayout).show ? (
          <View
            key={`lbl-${item.id}`}
            pointerEvents="none"
            style={{
              position: 'absolute', left: (lay as LabelLayout).x, top: (lay as LabelLayout).y,
              width: (lay as LabelLayout).w,
            }}>
            <Text numberOfLines={1} style={{color: '#A7B6D4', fontSize: 9, textShadowColor: '#000', textShadowRadius: 3}}>
              {item.name}
            </Text>
          </View>
        ) : null)}

        {/* boussole de bord (E/O) + hint */}
        <Text style={{position: 'absolute', left: 8, bottom: 4, color: c.textFaint, fontSize: 10}}>E {mirror ? '←' : '→'}</Text>
        <Text style={{position: 'absolute', right: 8, bottom: 4, color: c.textFaint, fontSize: 10}}>{mirror ? '→' : '←'} O</Text>
        <Text style={{position: 'absolute', left: 8, top: 4, color: c.textFaint, fontSize: 10}}>{t.sky.tapHint}</Text>
        <Text style={{position: 'absolute', right: 8, top: 4, color: c.textFaint, fontSize: 10}}>
          {center.src === 'scope' ? t.sky.followScope
            : center.src === 'target' ? t.sky.followTarget
            : center.src === 'phone' ? t.sky.followPhone
            : t.sky.followManual}
        </Text>
      </View>

      {!follow ? (
        <Btn label={t.sky.recenter} variant="ghost"
          onPress={() => {setManual(null); setFollow(true);}} style={{marginTop: 6}} />
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
                  {gc.report.reasons.map((k) => (t.sky as unknown as Record<string, string>)[k] ?? k).join(' · ')}
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
                <Btn label={t.objects.sync} style={{flex: 1, marginLeft: 6}}
                  onPress={() => void doSync(selected)} />
              </View>
              <Text style={{color: c.textFaint, fontSize: 11, marginTop: 6}}>{t.sky.syncHint}</Text>
              <Btn label={t.objects.set} style={{marginTop: 8}}
                onPress={() => {
                  setTarget(selected.raDeg, selected.decDeg, selected.name);
                  setTrackTarget({name: selected.name, raDeg: selected.raDeg, decDeg: selected.decDeg, moving: null, from: 'catalog'});
                  setSelected(null);
                }} />
              <Btn label={t.common.close} variant="ghost" onPress={() => setSelected(null)} style={{marginTop: 8}} />
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}
