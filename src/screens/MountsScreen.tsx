/**
 * ÉCRAN MONTURES (v2.7.0 — « un onglet entier dédié » à la sélection de la
 * monture/télescope) :
 *  - MARQUE → MODÈLE : deux menus déroulants en cascade (le second est
 *    alimenté par la marque choisie) — catalogue aussi fourni pour chaque
 *    marque que Meade (Celestron, Sky-Watcher, iOptron, Orion, Losmandy,
 *    10Micron, Astro-Physics, ZWO…) ;
 *  - SAISIE MANUELLE : marque « Autre » ou « modèle non listé » →
 *    caractéristiques libres (protocole, type, butées, taux) ;
 *  - SOURCE UNIQUE : la configuration s'applique aux réglages existants
 *    (protocole, interface, preset mécanique) — les cartes redondantes des
 *    onglets Connexion/Alignement sont remplacées par un résumé + lien.
 */
import {useState} from 'react';
import {View, Text, ScrollView} from 'react-native';
import {useT, useI18n} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {
  BRANDS, GENERIC_MODELS, findBrand, findModel, resolveMountConfig, activePreset,
  BRAND_OTHER, MODEL_NOT_LISTED,
  type CustomMount,
} from '../services/mounts/catalog';
import {MOUNT_PRESETS, type MountPresetId} from '../services/astro/mounts';
import type {DriverPref} from '../services/protocol/driver';
import {Dropdown} from '../components/Dropdown';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, Card, Input, Segmented, Title, Toggle, usePal, s} from '../components/ui';

/** Libellé i18n d'un protocole. */
function driverLabel(t: ReturnType<typeof useT>, d: DriverPref): string {
  switch (d) {
    case 'meade': return t.connect.driverMeade;
    case 'celestron': return t.connect.driverCelestron;
    case 'skywatcher': return t.connect.driverSkywatcher;
    case 'ioptron': return t.connect.driverIoptron;
    default: return t.connect.driverAuto;
  }
}

export function MountsScreen() {
  const t = useT();
  const c = usePal();
  const lang = useI18n((st) => st.lang);
  const mx = t.mounts;

  const brandId = useSettingsStore((st) => st.mountBrandId);
  const modelId = useSettingsStore((st) => st.mountModelId);
  const customMount = useSettingsStore((st) => st.customMount);
  const setMountSelection = useSettingsStore((st) => st.setMountSelection);
  const setCustomMount = useSettingsStore((st) => st.setCustomMount);
  const setModel = useSettingsStore((st) => st.setModel);
  const setPrefDriver = useSettingsStore((st) => st.setPrefDriver);
  const setMountPreset = useSettingsStore((st) => st.setMountPreset);
  const fwModel = useScopeStore((st) => st.fwModel);
  const driverId = useScopeStore((st) => st.driverId);

  const [applied, setApplied] = useState(false);
  const [form, setForm] = useState<CustomMount>(customMount ?? {
    label: '', protocol: 'auto', altaz: true,
    minAltDeg: 0, maxAltDeg: 90, preset: 'generic', active: false,
  });

  const cfg = resolveMountConfig(brandId, modelId, customMount);
  const mountPreset = useSettingsStore((st) => st.mountPreset);
  const preset = activePreset(brandId, modelId, customMount, fwModel, mountPreset);
  const mdl = findModel(brandId, modelId);

  const brandOptions = [
    ...BRANDS.map((b) => ({
      key: b.id, label: b.label,
      hint: driverLabel(t, b.protocol ?? 'auto'),
    })),
    {key: BRAND_OTHER, label: mx.other},
  ];

  const isOther = brandId === BRAND_OTHER;
  const brand = findBrand(brandId);
  const modelOptions: Array<{key: string; label: string; hint?: string}> = isOther
    ? [
        ...GENERIC_MODELS.map((x) => ({key: x.id, label: x.label, hint: driverLabel(t, x.protocol ?? 'auto')})),
        {key: MODEL_NOT_LISTED, label: mx.notListed},
      ]
    : [
        ...(brand?.models ?? []).map((x) => ({
          key: x.id, label: x.label,
          hint: x.goto ? undefined : mx.noMotors,
        })),
        {key: MODEL_NOT_LISTED, label: mx.notListed},
      ];
  const showCustomForm = modelId === MODEL_NOT_LISTED
    || (mdl != null && mdl.protocol === null)
    || isOther && modelId === MODEL_NOT_LISTED;

  const applyModel = (key: string) => {
    setApplied(false);
    if (key === MODEL_NOT_LISTED) {
      setMountSelection(brandId, key);
      return;
    }
    const x = findModel(brandId, key);
    if (!x) return;
    setMountSelection(brandId, key);
    setModel(x.interfaceId);
    setPrefDriver(x.protocol ?? 'auto');
    setMountPreset(x.preset);
    setApplied(true);
  };

  const saveCustom = () => {
    const cm: CustomMount = {
      ...form,
      label: form.label.trim() || '—',
      minAltDeg: Math.max(0, Math.min(80, form.minAltDeg)),
      maxAltDeg: Math.min(90, Math.max(form.minAltDeg + 5, form.maxAltDeg)),
      active: true,
    };
    setCustomMount(cm);
    setMountPreset(cm.preset);
    if (cm.protocol !== 'auto') setPrefDriver(cm.protocol);
    const resolved = resolveMountConfig(null, null, cm);
    setModel(resolved.interfaceId);
    setApplied(true);
  };

  const presetOptions = (Object.keys(MOUNT_PRESETS) as MountPresetId[]).map((k) => ({
    key: k, label: MOUNT_PRESETS[k].label,
  }));

  return (
    <ScrollView style={{flex: 1, backgroundColor: c.bg}} contentContainerStyle={{padding: 12, paddingBottom: 40}}>
      <StatusHeader />

      {/* ---------- CONFIGURATION ACTIVE ---------- */}
      <Card style={{marginTop: 8}}>
        <Title text={mx.current} />
        {cfg.brandLabel === '—' && cfg.modelLabel === '—' ? (
          <Text style={{color: c.textDim, fontSize: 13}}>{mx.none}</Text>
        ) : (
          <View>
            <View style={[s.row, s.between]}>
              <Text style={{color: c.text, fontSize: 16, fontWeight: '700', flex: 1}}>
                {cfg.brandLabel !== '—' ? `${cfg.brandLabel} · ` : ''}{cfg.modelLabel}
              </Text>
              {cfg.custom ? (
                <View style={{
                  borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1,
                  backgroundColor: 'rgba(232,184,75,0.12)', borderColor: c.amber,
                }}>
                  <Text style={{color: c.amber, fontSize: 9, fontWeight: '800', letterSpacing: 0.6}}>
                    {mx.activeBadge}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={{color: c.blue, fontSize: 12, marginTop: 3, fontWeight: '600'}}>
              {driverLabel(t, cfg.driverPref)}
              {driverId ? ` · ${driverId}` : ''}
            </Text>
            <Text style={{color: c.textDim, fontSize: 12, marginTop: 5, lineHeight: 17}}>
              {mx.limits} {preset.minAltDeg}° → {preset.maxAltDeg}°  ·  {mx.rates}{' '}
              {preset.expectedRates.center.toFixed(2)}/{preset.expectedRates.find.toFixed(1)}/{preset.expectedRates.slew.toFixed(1)}°/s
              {'  ·  '}{preset.altaz ? mx.altaz : mx.polar}
            </Text>
          </View>
        )}
        <Text style={{color: c.textFaint, fontSize: 11, marginTop: 8, lineHeight: 16}}>{mx.hint}</Text>
        {applied ? (
          <Text style={{color: c.green, fontSize: 12, marginTop: 6, fontWeight: '600'}}>✓ {mx.applied}</Text>
        ) : null}
      </Card>

      {/* ---------- CATALOGUE (marque → modèle) ---------- */}
      <Card style={{marginTop: 12}}>
        <Title text={mx.title} />
        <Text style={{color: c.textDim, fontSize: 12, marginBottom: 4, lineHeight: 17}}>{mx.intro}</Text>
        <Dropdown
          label={mx.brand}
          value={brandId}
          options={brandOptions}
          placeholder={mx.pickBrand}
          onChange={(k) => {
            setApplied(false);
            setMountSelection(k, null);
          }}
        />
        <Dropdown
          label={mx.model}
          value={modelId}
          options={brandId ? modelOptions : []}
          placeholder={brandId ? mx.pickModel : mx.pickBrand}
          onChange={applyModel}
        />

        {mdl && modelId !== MODEL_NOT_LISTED ? (
          <View style={{backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.border, padding: 10, marginTop: 8}}>
            <Text style={{color: c.amber, fontSize: 13, fontWeight: '700'}}>{mdl.label}</Text>
            <Text style={{color: c.textDim, fontSize: 12, marginTop: 3}}>
              {mx.protocol} : {driverLabel(t, mdl.protocol ?? 'auto')}
            </Text>
            {!mdl.goto ? (
              <Text style={{color: c.orange, fontSize: 11, marginTop: 3}}>⚠ {mx.noMotors}</Text>
            ) : null}
            {mdl.goto && mdl.protocol === null ? (
              <Text style={{color: c.orange, fontSize: 11, marginTop: 3}}>⚠ {mx.unsupported}</Text>
            ) : null}
            {(lang === 'fr' ? mdl.noteFr : mdl.noteEn) ? (
              <Text style={{color: c.textFaint, fontSize: 11, marginTop: 3, lineHeight: 16}}>
                {(lang === 'fr' ? mdl.noteFr : mdl.noteEn) as string}
              </Text>
            ) : null}
            {mdl.goto && mdl.protocol !== null ? (
              <Btn label={mx.apply} variant="primary" style={{marginTop: 8}}
                onPress={() => applyModel(mdl.id)} />
            ) : null}
          </View>
        ) : null}
        <Text style={{color: c.textFaint, fontSize: 10.5, marginTop: 8, lineHeight: 15}}>{mx.detection}</Text>
      </Card>

      {/* ---------- SAISIE MANUELLE ---------- */}
      {showCustomForm ? (
        <Card style={{marginTop: 12, marginBottom: 20}}>
          <Title text={mx.customTitle} />
          <Text style={{color: c.textDim, fontSize: 12, marginBottom: 6, lineHeight: 17}}>{mx.customHint}</Text>
          <Input label={mx.customName} value={form.label}
            onChangeText={(label) => setForm({...form, label})}
            placeholder="EQ5 maison, Async One…" />
          <Text style={{color: c.textDim, fontSize: 12, marginTop: 2, marginBottom: 4}}>{t.connect.proto}</Text>
          <Segmented<'auto' | 'meade' | 'celestron' | 'skywatcher' | 'ioptron'>
            value={form.protocol}
            onChange={(v) => setForm({...form, protocol: v})}
            options={[
              {key: 'auto', label: t.connect.driverAuto},
              {key: 'meade', label: 'Meade'},
              {key: 'celestron', label: 'NexStar'},
              {key: 'skywatcher', label: 'SynScan'},
              {key: 'ioptron', label: 'iOptron'},
            ]}
          />
          <View style={{marginTop: 6}}>
            <Toggle value={form.altaz} onChange={(altaz) => setForm({...form, altaz})}
              label={form.altaz ? mx.typeAltaz : mx.typePolar} />
          </View>
          <Input label={mx.customMin} value={String(form.minAltDeg)} keyboardType="numeric"
            onChangeText={(v) => setForm({...form, minAltDeg: parseInt(v, 10) || 0})} />
          <Input label={mx.customMax} value={String(form.maxAltDeg)} keyboardType="numeric"
            onChangeText={(v) => setForm({...form, maxAltDeg: parseInt(v, 10) || 90})} />
          <Dropdown label={mx.customPreset} value={form.preset} options={presetOptions}
            onChange={(k) => setForm({...form, preset: k as MountPresetId})} />
          <Btn label={mx.customSave} variant="primary" style={{marginTop: 10}} onPress={saveCustom} />
        </Card>
      ) : null}
    </ScrollView>
  );
}
