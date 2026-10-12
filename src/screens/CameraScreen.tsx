/**
 * ÉCRAN CAMÉRA ASTRONOMIQUE (v2.5.0 — « je veux un module d'affichage de
 * flux video, afin de connecter une caméra astronomique, avec une option de
 * suivi de l'objet par le télescope basé sur l'image video, et possibilité
 * d'automatiser l'acquisition d'image (réglages automatiques des paramètres
 * de la caméra, choix du temps de pause/nombre d'images selon qualité
 * choisie, traitements/empilement d'images) avec des presets spécifiques aux
 * objets les plus courants »).
 *
 * 1. CAMÉRA : énumération (UVC externe d'abord, interne en secours), flux
 *    JPEG (Camera2), aperçu + FPS ; TAP sur l'aperçu = verrou de suivi.
 * 2. AUTOGUIDAGE : dérive du centroïde → impulsions moteur (guide) — avec
 *    calibrage d'échelle/axes par une impulsion connue.
 * 3. ACQUISITION : presets objets (Lune, planètes, Soleil, doubles, amas,
 *    nébuleuses, galaxies) × qualité → plan de pose/comptage → poses
 *    automatiques → EMPILEMENT + étirement → image finale (galerie).
 */
import {useEffect, useRef, useState} from 'react';
import {
  View, Text, Image, TouchableOpacity, PermissionsAndroid, Platform, ActivityIndicator,
} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useCameraStore} from '../store/cameraStore';
import {useScopeStore} from '../store/scopeStore';
import {
  astroCamera, type CameraRanges, type ManualParams,
} from '../services/phone/astroCamera';
import {
  acquisitionRunner, buildPlan,
  type AcqKind, type AcqQuality, type AcqProgress,
} from '../services/astro/acquisition';
import {
  guidingRunner, calibrateGuiding, type GuidingAxes,
} from '../services/astro/guiding';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, Card, Segmented, Toggle, Title, usePal, s} from '../components/ui';
import {SliderBar} from '../components/SliderBar';
import {Dropdown} from '../components/Dropdown';

/** Aperçu : consomme le flux à part (throttle 150 ms) pour ne pas
 *  relancer tout l'écran à chaque frame. */
function Preview() {
  const c = usePal();
  const [uri, setUri] = useState<string | null>(null);
  const lastTs = useRef(0);
  useEffect(() => {
    const rel = astroCamera.onFrame((f) => {
      if (f.ts - lastTs.current < 150) return;
      lastTs.current = f.ts;
      setUri(`data:image/jpeg;base64,${f.data}`);
    });
    return rel;
  }, []);
  return (
    <View style={{
      borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: c.border,
      backgroundColor: '#04060C', aspectRatio: 4 / 3, marginTop: 8,
    }}>
      {uri ? (
        <Image source={{uri}} style={{flex: 1, width: '100%', height: '100%', resizeMode: 'contain'}} />
      ) : (
        <View style={{flex: 1, alignItems: 'center', justifyContent: 'center'}}>
          <Text style={{color: c.textFaint, fontSize: 12}}>—</Text>
        </View>
      )}
    </View>
  );
}

/** Libellé i18n d'un contrôle du panneau de réglages. */
function paramLabel(t: ReturnType<typeof useT>, key: string): string {
  const cs = t.cam as unknown as Record<string, string>;
  return cs[`param${key.charAt(0).toUpperCase()}${key.slice(1)}`] ?? key;
}

/** Formatage adapté de la valeur (ms de pose → s au-delà de 1 000). */
function fmtValue(key: string, v: number): string {
  if (key === 'exposureMs') {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} s`;
    if (Math.abs(v) >= 1) return `${v.toFixed(v >= 10 ? 1 : 2)} ms`;
    return `${(v * 1000).toFixed(0)} µs`;
  }
  if (key === 'zoom') return `${(1 + v * 4).toFixed(1)}×`;
  if (key === 'ev') return `${v > 0 ? '+' : ''}${v.toFixed(1)} EV`;
  if (key === 'whiteBalanceTemp') return `${Math.round(v)} K`;
  if (key === 'focusAbsolute') return v.toFixed(2);
  return Math.abs(v) >= 10 ? String(Math.round(v)) : v.toFixed(2);
}

/**
 * PANNEAU « RÉGLAGES MANUELS » (v2.7.0 — « je voudrais aussi pouvoir régler
 * manuellement les paramètres de la caméra ») : construit depuis les plages
 * lues du MATÉRIEL (UVC : GET_MIN/GET_MAX des contrôles · Camera2 :
 * caractéristiques du capteur) — seuls les contrôles réellement disponibles
 * sont affichés, chacun avec son curseur borné + pas.
 */
function ParamsPanel({cameraId, streaming}: {cameraId: string | null; streaming: boolean}) {
  const t = useT();
  const c = usePal();
  const [ranges, setRanges] = useState<CameraRanges | null>(null);
  const [vals, setVals] = useState<Record<string, number>>({});
  const [exposureMode, setExposureMode] = useState<'auto' | 'manual'>('auto');
  const [focusAuto, setFocusAuto] = useState(true);
  const [wbAuto, setWbAuto] = useState(true);
  const [wbMode, setWbMode] = useState<string>('auto');
  const [failed, setFailed] = useState<string[]>([]);

  const loadRanges = async () => {
    if (!cameraId) return;
    setRanges(null);
    setFailed([]);
    const r = await astroCamera.getRanges(cameraId);
    setRanges(r);
    const init: Record<string, number> = {};
    for (const k of Object.keys(r.controls)) init[k] = r.controls[k].def;
    setVals(init);
  };

  useEffect(() => {
    if (streaming) void loadRanges();
    else { setRanges(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, streaming]);

  const apply = async (p: ManualParams) => {
    if (!cameraId) return;
    try {
      const f = await astroCamera.setParams(cameraId, p);
      setFailed(f ?? []);
    } catch (_) {
      setFailed(['error']);
    }
  };

  const setParam = (key: string, value: number) => {
    setVals({...vals, [key]: value});
    const p: ManualParams = {};
    switch (key) {
      case 'exposureMs': p.exposureMode = 'manual'; p.exposureMs = value; break;
      case 'iso': p.exposureMode = 'manual'; p.iso = Math.round(value); break;
      case 'ev': p.exposureComp = Math.round(value); break;
      default: (p as Record<string, number>)[key] = value;
    }
    void apply(p);
  };

  const switchExposure = (mode: 'auto' | 'manual') => {
    setExposureMode(mode);
    if (mode === 'auto') {
      void apply({exposureMode: 'auto'});
    } else {
      const p2: ManualParams = {exposureMode: 'manual'};
      if (vals.exposureMs !== undefined) p2.exposureMs = vals.exposureMs;
      else if (ranges?.controls.exposureMs) p2.exposureMs = ranges.controls.exposureMs.def;
      if (vals.iso !== undefined) p2.iso = Math.round(vals.iso);
      else if (ranges?.controls.iso) p2.iso = Math.round(ranges.controls.iso.def);
      void apply(p2);
    }
  };

  const hasControl = (k: string) => ranges?.controls[k] != null;
  const manualExposure = hasControl('exposureMs') || hasControl('iso');

  if (!streaming) return null;

  return (
    <Card style={{marginTop: 10}}>
      <View style={[s.row, s.between]}>
        <Title text={t.cam.settingsTitle} />
        <TouchableOpacity onPress={() => void loadRanges()}>
          <Text style={{color: c.blue, fontSize: 11, fontWeight: '700'}}>{t.cam.refreshRanges}</Text>
        </TouchableOpacity>
      </View>
      {!ranges ? (
        <Text style={{color: c.textFaint, fontSize: 12}}>…</Text>
      ) : !manualExposure && Object.keys(ranges.controls).length === 0 && ranges.wbModes.length === 0 ? (
        <Text style={{color: c.textFaint, fontSize: 12}}>{t.cam.noRanges}</Text>
      ) : (
        <View>
          {manualExposure ? (
            <View style={{marginBottom: 4}}>
              <Segmented<'auto' | 'manual'>
                value={exposureMode}
                onChange={switchExposure}
                options={[{key: 'auto', label: t.cam.autoMode}, {key: 'manual', label: t.cam.manualMode}]}
              />
            </View>
          ) : null}
          {exposureMode === 'manual' && hasControl('exposureMs') ? (
            <SliderBar label={paramLabel(t, 'exposureMs')} value={vals.exposureMs ?? 0}
              {...ranges.controls.exposureMs} unit=""
              format={(v) => fmtValue('exposureMs', v)}
              onCommit={(v) => setParam('exposureMs', v)} />
          ) : null}
          {exposureMode === 'manual' && hasControl('iso') ? (
            <SliderBar label={paramLabel(t, 'iso')} value={vals.iso ?? 0}
              {...ranges.controls.iso} unit=""
              format={(v) => `${Math.round(v)}`}
              onCommit={(v) => setParam('iso', v)} />
          ) : null}
          {exposureMode === 'auto' && hasControl('ev') ? (
            <SliderBar label={paramLabel(t, 'ev')} value={vals.ev ?? 0}
              {...ranges.controls.ev} unit=""
              format={(v) => fmtValue('ev', v)}
              onCommit={(v) => setParam('ev', v)} />
          ) : null}
          {(['gain', 'brightness', 'contrast', 'saturation', 'sharpness'] as const).map((k) =>
            hasControl(k) ? (
              <SliderBar key={k} label={paramLabel(t, k)} value={vals[k] ?? 0}
                {...ranges.controls[k]} unit=""
                format={(v) => fmtValue(k, v)}
                onCommit={(v) => setParam(k, v)} />
            ) : null,
          )}
          {ranges.source === 'uvc' && hasControl('whiteBalanceTemp') ? (
            <View>
              <Toggle value={wbAuto} label={t.cam.wbAuto}
                onChange={(v) => { setWbAuto(v); void apply({whiteBalanceAuto: v}); }} />
              {!wbAuto ? (
                <SliderBar label={paramLabel(t, 'whiteBalanceTemp')} value={vals.whiteBalanceTemp ?? 0}
                  {...ranges.controls.whiteBalanceTemp} unit=""
                  format={(v) => fmtValue('whiteBalanceTemp', v)}
                  onCommit={(v) => setParam('whiteBalanceTemp', v)} />
              ) : null}
            </View>
          ) : null}
          {ranges.wbModes.length > 1 ? (
            <Dropdown label={t.cam.wbMode} value={wbMode}
              options={ranges.wbModes.map((m) => ({key: m, label: m}))}
              onChange={(m) => { setWbMode(m); void apply({wbMode: m as ManualParams['wbMode']}); }} />
          ) : null}
          {hasControl('zoom') ? (
            <SliderBar label={paramLabel(t, 'zoom')} value={vals.zoom ?? 0}
              {...ranges.controls.zoom} unit=""
              format={(v) => fmtValue('zoom', v)}
              onCommit={(v) => setParam('zoom', v)} />
          ) : null}
          {hasControl('focusAbsolute') ? (
            <View>
              <Toggle value={focusAuto} label={t.cam.focusAuto}
                onChange={(v) => { setFocusAuto(v); void apply({focusMode: v ? 'auto' : 'manual'}); }} />
              {!focusAuto ? (
                <SliderBar label={paramLabel(t, 'focusAbsolute')} value={vals.focusAbsolute ?? 0}
                  {...ranges.controls.focusAbsolute} unit=""
                  format={(v) => fmtValue('focusAbsolute', v)}
                  onCommit={(v) => setParam('focusAbsolute', v)} />
              ) : null}
            </View>
          ) : null}
          {failed.length > 0 ? (
            <Text style={{color: c.orange, fontSize: 11, marginTop: 6}}>
              {t.cam.failed.replace('{0}', failed.join(', '))}
            </Text>
          ) : null}
          <Text style={{color: c.textFaint, fontSize: 10.5, marginTop: 8, lineHeight: 15}}>{t.cam.hint}</Text>
        </View>
      )}
    </Card>
  );
}

export function CameraScreen() {
  const t = useT();
  const c = usePal();
  const connStatus = useScopeStore((st) => st.connStatus);
  const guideAxes = useSettingsStore((st) => st.guideAxes);
  const guideScale = useSettingsStore((st) => st.guideScaleArcsecPerPx);
  const setGuideAxes = useSettingsStore((st) => st.setGuideAxes);
  const setGuideScale = useSettingsStore((st) => st.setGuideScale);

  const cam = useCameraStore();
  const [busy, setBusy] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibMsg, setCalibMsg] = useState<string | null>(null);
  const [kind, setKind] = useState<AcqKind>('moon');
  const [quality, setQuality] = useState<AcqQuality>('standard');

  const plan = buildPlan(kind, quality, cam.devices.find((d) => d.id === cam.cameraId));

  // Abonnement léger aux frames : FPS + dernier frame + centroïde (autoguidage store)
  useEffect(() => {
    let n = 0;
    let window0 = Date.now();
    const rel = astroCamera.onFrame((f) => {
      const st = useCameraStore.getState();
      n += 1;
      const el = Date.now() - window0;
      if (el >= 2000) {
        st.setFps(Math.round((n * 1000) / el));
        n = 0; window0 = Date.now();
      }
      st.setLastFrame({data: '', w: f.w, h: f.h, ts: f.ts, cx: f.cx, cy: f.cy, peak: f.peak, flux: f.flux});
    });
    // Coupure matérielle du flux UVC (débranchement) — l'écran repart propre
    const relLost = astroCamera.onStreamLost(() => {
      const st = useCameraStore.getState();
      st.setStreaming(false);
      st.setFps(0);
      st.setLock(null);
      st.setAcq({state: 'error', done: 0, total: 0, note: 'noFrames'});
    });
    return () => { rel(); relLost(); };
  }, []);

  const requestPermission = async (cameraId: string | null): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    // UVC USB-host : PAS de permission CAMÉRA Android requise (accès direct USB)
    if (cameraId?.startsWith('uvc:')) return true;
    try {
      const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
      return r === PermissionsAndroid.RESULTS.GRANTED;
    } catch (_) {
      return false;
    }
  };

  const refreshDevices = async () => {
    setBusy(true);
    const devs = await astroCamera.listCameras();
    cam.setDevices(devs.map((d) => ({id: d.id, label: d.label, external: d.external, manual: d.manual})));
    if (devs.length && cam.cameraId === null) {
      cam.setCameraId(devs.find((d) => d.external)?.id ?? devs[0].id);
    }
    setBusy(false);
  };

  useEffect(() => {void refreshDevices(); /* eslint-disable-next-line react-hooks/exhaustive-deps */}, []);

  const startStream = async () => {
    if (!cam.cameraId) return;
    const ok = await requestPermission(cam.cameraId);
    if (!ok) {cam.setAcq({state: 'error', done: 0, total: 0, note: 'cameraPermission'}); return;}
    setBusy(true);
    try {
      await astroCamera.open(cam.cameraId, 960, 720, 12, 75);
      cam.setStreaming(true);
    } catch (e) {
      cam.setAcq({state: 'error', done: 0, total: 0, note: (e as Error).message});
    }
    setBusy(false);
  };

  const stopStream = async () => {
    guidingRunner.stop();
    cam.setGuiding({...cam.guiding, running: false});
    await astroCamera.clearLock();
    await astroCamera.close();
    cam.setLock(null);
    cam.setStreaming(false);
    cam.setFps(0);
  };

  const tapPreview = () => {
    if (!cam.streaming) return;
    // verrou au CENTRE par défaut (l'objet visé au chercheur) — réglable au
    // tap réel sur l'aperçu complet plus tard ; centre = zone fiable
    void astroCamera.setLock(0.5, 0.5, 0.13);
    cam.setLock({x: 0.5, y: 0.5});
  };

  const toggleGuiding = () => {
    if (cam.guiding.running) {
      guidingRunner.stop();
      cam.setGuiding({...cam.guiding, running: false});
      return;
    }
    if (!cam.lock) {tapPreview();}
    guidingRunner.setAxes(guideAxes, guideScale);
    guidingRunner.start((st) => useCameraStore.getState().setGuiding(st));
  };

  const runCalibration = async () => {
    if (connStatus !== 'connected' || !cam.streaming || !cam.lock) return;
    setCalibrating(true);
    setCalibMsg(null);
    const r = await calibrateGuiding(2500, 0.02);
    if (r.ok) {
      setGuideScale(r.scaleArcsecPerPx);
      if (r.xAxis !== guideAxes.xAxis) {
        setGuideAxes({...guideAxes, xAxis: r.xAxis} as GuidingAxes);
      }
      setCalibMsg(`${r.scaleArcsecPerPx.toFixed(2)}″/px · ${r.xAxis === 'ra' ? 'AD' : 'DEC'}`);
    } else {
      setCalibMsg(r.note === 'noMove' ? t.cam.calibNoMove : t.cam.calibNoCentroid);
    }
    setCalibrating(false);
  };

  const startAcq = async () => {
    const onProgress = (p: AcqProgress) => useCameraStore.getState().setAcq(p);
    const res = await acquisitionRunner.run(plan, onProgress);
    if (res) useCameraStore.getState().setResult(res);
  };

  const stopAcq = () => acquisitionRunner.stop();

  const acqKinds: Array<{key: AcqKind; label: string}> = [
    {key: 'moon', label: t.cam.presetMoon},
    {key: 'planets', label: t.cam.presetPlanets},
    {key: 'sun', label: t.cam.presetSun},
    {key: 'doubleStar', label: t.cam.presetDouble},
    {key: 'globular', label: t.cam.presetGlobular},
    {key: 'nebulaBright', label: t.cam.presetNebulaBright},
    {key: 'nebulaFaint', label: t.cam.presetNebulaFaint},
    {key: 'galaxyBright', label: t.cam.presetGalaxy},
  ];

  return (
    <View style={{flex: 1, backgroundColor: c.bg, padding: 12, paddingTop: 0}}>
      <StatusHeader />

      {/* ---------- CAMÉRA + FLUX ---------- */}
      <Card>
        <Title text={t.cam.title} />
        {cam.devices.length === 0 ? (
          <View>
            <Text style={{color: c.textDim, fontSize: 12, marginBottom: 8}}>{t.cam.noCamera}</Text>
            <Btn label={t.cam.refresh} onPress={() => void refreshDevices()} />
          </View>
        ) : (
          <View>
            {cam.devices.map((d) => (
              <TouchableOpacity key={d.id} onPress={() => cam.setCameraId(d.id)}
                style={{
                  paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, marginBottom: 4,
                  backgroundColor: d.id === cam.cameraId ? c.btnActive : c.bgPanel2,
                  flexDirection: 'row', justifyContent: 'space-between',
                }}>
                <Text style={{color: d.id === cam.cameraId ? c.amber : c.text, fontSize: 13}}>{d.label}</Text>
                <Text style={{color: c.textFaint, fontSize: 11}}>{d.external ? 'UVC' : 'int.'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {cam.streaming ? (
          <TouchableOpacity onPress={tapPreview} activeOpacity={0.9}>
            <Preview />
            <View style={{position: 'absolute', left: '50%' as const, top: '50%' as const, marginLeft: -11, marginTop: -11, width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: cam.lock ? c.green : 'rgba(232,184,75,0.6)'}} pointerEvents="none" />
          </TouchableOpacity>
        ) : (
          <View style={{borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: '#04060C', aspectRatio: 4 / 3, marginTop: 8, alignItems: 'center', justifyContent: 'center'}}>
            {busy ? <ActivityIndicator color={c.amber} /> : (
              <Text style={{color: c.textFaint, fontSize: 12, textAlign: 'center', padding: 12}}>{t.cam.tapStart}</Text>
            )}
          </View>
        )}
        <View style={[s.row, {marginTop: 8}]}>
          {cam.streaming ? (
            <Btn label={`${t.cam.stop} (${cam.fps} fps)`} variant="danger" style={{flex: 1}} onPress={() => void stopStream()} />
          ) : (
            <Btn label={t.cam.start} variant="primary" style={{flex: 1}} disabled={!cam.cameraId || busy} onPress={() => void startStream()} />
          )}
        </View>
        {cam.streaming ? <Text style={{color: c.textFaint, fontSize: 11, marginTop: 4}}>{t.cam.tapLock}</Text> : null}
      </Card>

      {/* ---------- RÉGLAGES MANUELS (v2.7.0) ---------- */}
      <ParamsPanel cameraId={cam.cameraId} streaming={cam.streaming} />

      {/* ---------- AUTOGUIDAGE ---------- */}
      <Card style={{marginTop: 10}}>
        <Title text={t.cam.guideTitle} />
        <Toggle value={cam.guiding.running} onChange={() => toggleGuiding()}
          label={cam.guiding.running ? t.cam.guidingOn : t.cam.guidingOff} />
        {cam.guiding.running || cam.guiding.corrections > 0 ? (
          <View style={{backgroundColor: c.bgPanel2, borderRadius: 10, padding: 10, marginTop: 4}}>
            <Text style={{color: cam.guiding.locked ? c.green : c.orange, fontSize: 12, fontWeight: '700'}}>
              {cam.guiding.locked ? t.cam.locked : t.cam.lockLost}
            </Text>
            <Text style={{color: c.textDim, fontFamily: 'monospace', fontSize: 12, marginTop: 3}}>
              ΔX {cam.guiding.lastDxPx.toFixed(1)} px · ΔY {cam.guiding.lastDyPx.toFixed(1)} px
            </Text>
            <Text style={{color: c.textDim, fontSize: 12}}>
              {t.cam.corrections} : {cam.guiding.corrections} · {t.cam.lost} : {cam.guiding.lostFrames}
            </Text>
            <Text style={{color: c.textFaint, fontSize: 11, marginTop: 3}}>
              {t.cam.scale} {guideScale.toFixed(2)}″/px · {guideAxes.xAxis === 'ra' ? 'X→AD' : 'X→DEC'}
              {guideAxes.flipX ? ' · X−' : ''}{guideAxes.flipY ? ' · Y−' : ''}
            </Text>
          </View>
        ) : null}
        <View style={[s.row, {marginTop: 8}]}>
          <Btn label={calibrating ? t.cam.calibrating : t.cam.calibrate} style={{flex: 1, marginRight: 6}}
            disabled={!cam.streaming || !cam.lock || connStatus !== 'connected' || calibrating}
            onPress={() => void runCalibration()} />
          {calibrating ? <ActivityIndicator color={c.amber} /> : null}
        </View>
        {calibMsg ? <Text style={{color: c.amber, fontSize: 12, marginTop: 4}}>{calibMsg}</Text> : null}
        <View style={{marginTop: 8}}>
          <Segmented<'ra' | 'dec'>
            value={guideAxes.xAxis}
            onChange={(v) => setGuideAxes({...guideAxes, xAxis: v})}
            options={[{key: 'ra', label: 'X→AD'}, {key: 'dec', label: 'X→DEC'}]}
          />
        </View>
        <View style={{marginTop: 6}}>
          <Toggle value={guideAxes.flipX} onChange={(v) => setGuideAxes({...guideAxes, flipX: v})} label={t.cam.flipX} />
          <Toggle value={guideAxes.flipY} onChange={(v) => setGuideAxes({...guideAxes, flipY: v})} label={t.cam.flipY} />
        </View>
      </Card>

      {/* ---------- ACQUISITION ---------- */}
      <Card style={{marginTop: 10, marginBottom: 20}}>
        <Title text={t.cam.acqTitle} />
        <Segmented<'rapide' | 'standard' | 'haute'>
          value={quality}
          onChange={(q) => setQuality(q)}
          options={[
            {key: 'rapide', label: t.cam.qFast},
            {key: 'standard', label: t.cam.qStd},
            {key: 'haute', label: t.cam.qHigh},
          ]}
        />
        <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8}}>
          {acqKinds.map((k) => (
            <TouchableOpacity key={k.key} onPress={() => setKind(k.key)}
              style={{
                paddingVertical: 6, paddingHorizontal: 10, borderRadius: 16, borderWidth: 1,
                borderColor: kind === k.key ? c.amber : c.border,
                backgroundColor: kind === k.key ? c.btnActive : 'transparent',
              }}>
              <Text style={{color: kind === k.key ? c.amber : c.textDim, fontSize: 12, fontWeight: '600'}}>{k.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={{color: c.textFaint, fontSize: 11, marginTop: 8}}>
          {(t.camAcq as unknown as Record<string, string>)[plan.note.replace('camAcq.', '')] ?? ''}
        </Text>
        <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 12, marginTop: 6}}>
          {t.cam.planPose} {(plan.exposureMs / 1000).toFixed(2)} s · ISO {plan.iso || 'auto'} · {plan.count} {t.cam.frames} · {plan.stack === 'kappa' ? 'κσ' : plan.stack === 'median' ? 'médiane' : 'moyenne'}
        </Text>
        {plan.needsManualSensor ? <Text style={{color: c.orange, fontSize: 11, marginTop: 2}}>{t.cam.manualSensor}</Text> : null}
        {cam.acq.state !== 'idle' ? (
          <View style={{backgroundColor: c.bgPanel2, borderRadius: 10, padding: 10, marginTop: 8}}>
            <Text style={{color: cam.acq.state === 'error' ? c.red : cam.acq.state === 'done' ? c.green : c.amber, fontSize: 12, fontWeight: '700'}}>
              {cam.acq.state === 'running' ? `${t.cam.running} ${cam.acq.done}/${cam.acq.total}`
                : cam.acq.state === 'stacking' ? t.cam.stacking
                : cam.acq.state === 'done' ? t.cam.done
                : `${t.cam.error} ${cam.acq.note
                  ? ((t.cam as unknown as Record<string, string>)[cam.acq.note] ?? cam.acq.note)
                  : ''}`}
            </Text>
          </View>
        ) : null}
        <View style={[s.row, {marginTop: 8}]}>
          {acquisitionRunner.isRunning ? (
            <Btn label={t.cam.stopAcq} variant="danger" style={{flex: 1}} onPress={stopAcq} />
          ) : (
            <Btn label={t.cam.startAcq} variant="primary" style={{flex: 1}}
              disabled={!cam.streaming}
              onPress={() => void startAcq()} />
          )}
        </View>
        {cam.result ? (
          <View style={{marginTop: 10}}>
            <Text style={{color: c.textDim, fontSize: 12, marginBottom: 4}}>{t.cam.result} ({cam.result.used}/{cam.result.total})</Text>
            <Image source={{uri: cam.result.resultUri}} style={{width: '100%', aspectRatio: 4 / 3, borderRadius: 10, backgroundColor: '#000'}} resizeMode="contain" />
          </View>
        ) : null}
        {cam.gallery.length > 1 ? (
          <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8}}>
            {cam.gallery.map((g, i) => (
              <Image key={i} source={{uri: g.resultUri}} style={{width: 72, height: 54, borderRadius: 6, backgroundColor: '#000'}} resizeMode="cover" />
            ))}
          </View>
        ) : null}
      </Card>
    </View>
  );
}
