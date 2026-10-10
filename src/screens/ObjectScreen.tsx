/** Écran Objets : catalogues Messier/NGC/étoiles/planètes + tour du ciel + GoTo. */
import {useEffect, useMemo, useState} from 'react';
import {FlatList, Modal, Text, TextInput, TouchableOpacity, View, Alert} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {autostar} from '../services/protocol/client';
import {raDecToAltAz} from '../services/astro/coords';
import {raDegToHMS, decDegToDMS} from '../services/astro/time';
import {MESSIER, NGC_FAMOUS, BRIGHT_STARS, planetObjects, tourOfSky, searchAll, DisplayObject} from '../services/catalog';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, Segmented, Toggle, usePal} from '../components/ui';

type Cat = 'messier' | 'ngc' | 'stars' | 'planets' | 'tour';

export function ObjectScreen({navigation}: {navigation: {navigate: (s: string) => void}}) {
  const t = useT();
  const c = usePal();
  const site = useSettingsStore((s) => s.site);
  const onlyAboveHorizon = useSettingsStore((s) => s.onlyAboveHorizon);
  const setOnlyAboveHorizon = useSettingsStore((s) => s.setOnlyAboveHorizon);
  const connStatus = useScopeStore((s) => s.connStatus);
  const setTarget = useScopeStore((s) => s.setTarget);
  const [cat, setCat] = useState<Cat>('messier');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<DisplayObject | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 20000);
    return () => clearInterval(id);
  }, []);

  const now = useMemo(() => new Date(), [tick]);

  const list: DisplayObject[] = useMemo(() => {
    if (query.trim()) {
      const base = searchAll(query).map((o) => {
        const aa = raDecToAltAz(o.raDeg, o.decDeg, site.latDeg, site.lonDeg, now);
        return {...o, altDeg: aa.altDeg, azDeg: aa.azDeg};
      });
      return onlyAboveHorizon ? base.filter((o) => o.altDeg > 0) : base;
    }
    switch (cat) {
      case 'messier':
        return withFilter(MESSIER);
      case 'ngc':
        return withFilter(NGC_FAMOUS);
      case 'stars':
        return withFilter(BRIGHT_STARS);
      case 'planets':
        return withFilter(planetObjects(site.latDeg, site.lonDeg, now, t), false);
      case 'tour':
        return tourOfSky(site.latDeg, site.lonDeg, now);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, query, onlyAboveHorizon, tick, site.latDeg, site.lonDeg, t]);

  function withFilter(arr: import('../services/catalog/types').SkyObject[], sortAlt = true): DisplayObject[] {
    let out = arr.map((o) => {
      const aa = raDecToAltAz(o.raDeg, o.decDeg, site.latDeg, site.lonDeg, now);
      return {...o, altDeg: aa.altDeg, azDeg: aa.azDeg};
    });
    if (onlyAboveHorizon) out = out.filter((o) => o.altDeg > 0);
    return sortAlt ? out.sort((a, b) => b.altDeg - a.altDeg) : out;
  }

  const doGoto = async (o: DisplayObject, mode: 'goto' | 'sync') => {
    setTarget(o.raDeg, o.decDeg, o.name);
    setSelected(null);
    if (connStatus !== 'connected') {
      navigation.navigate('Connect');
      return;
    }
    try {
      if (mode === 'goto') {
        const r = await autostar.gotoRaDec(o.raDeg, o.decDeg);
        if (r !== 'ok') {
          Alert.alert(t.common.error,
            r === 'belowHorizon' ? t.objects.belowHorizon : r === 'noObject' ? t.objects.empty : t.errors.refused);
        }
      } else {
        // SYNC : GOTO fin puis CM sur l'objet déjà centré ? Non : SET cible puis l'utilisateur centre.
        Alert.alert(o.name, t.objects.set);
      }
    } catch (e) {
      Alert.alert(t.common.error, (e as Error).message);
    }
  };

  const renderItem = ({item}: {item: DisplayObject}) => (
    <TouchableOpacity onPress={() => setSelected(item)}
      style={{
        backgroundColor: c.bgPanel, borderRadius: 12, borderWidth: 1, borderColor: c.border,
        padding: 12, marginBottom: 8,
      }}>
      <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
        <Text style={{color: c.amber, fontWeight: '700', fontSize: 15}}>{item.name}</Text>
        <Text style={{
          color: item.altDeg > 0 ? c.green : c.textFaint, fontSize: 12, fontWeight: '600',
        }}>
          {item.altDeg > 0 ? `${t.objects.visible} ${item.altDeg.toFixed(0)}°` : t.objects.belowHorizon}
        </Text>
      </View>
      <View style={{flexDirection: 'row', marginTop: 4, flexWrap: 'wrap'}}>
        <Text style={{color: c.textDim, fontSize: 12, marginRight: 10}}>
          {t.objects.type} : {t.types[item.type] ?? item.type}
        </Text>
        <Text style={{color: c.textDim, fontSize: 12, marginRight: 10}}>
          {t.objects.mag} {item.mag < 90 ? item.mag.toFixed(1) : '—'}
        </Text>
        {item.constel ? <Text style={{color: c.textDim, fontSize: 12}}>{item.constel}</Text> : null}
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={{flex: 1, backgroundColor: c.bg, padding: 12, paddingTop: 0}}>
      <StatusHeader />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t.objects.search}
        placeholderTextColor={c.textFaint}
        style={{
          backgroundColor: c.bgPanel, color: c.text, borderRadius: 12, borderWidth: 1,
          borderColor: c.border, paddingHorizontal: 14, paddingVertical: 10, marginTop: 8,
        }}
      />
      <View style={{marginTop: 10}}>
        <Segmented<Cat>
          value={cat}
          onChange={setCat}
          options={[
            {key: 'messier', label: t.objects.catMessier},
            {key: 'ngc', label: t.objects.catNgc},
            {key: 'stars', label: t.objects.catStars},
            {key: 'planets', label: t.objects.catPlanets},
            {key: 'tour', label: t.objects.catTour},
          ]}
        />
      </View>
      <View style={{marginTop: 8}}>
        <Toggle value={onlyAboveHorizon} onChange={setOnlyAboveHorizon} label={t.objects.aboveHorizon} />
      </View>
      {cat === 'planets' ? <Text style={{color: c.textFaint, fontSize: 11, marginBottom: 6}}>{t.objects.planetsNote}</Text> : null}
      {cat === 'tour' ? <Text style={{color: c.textFaint, fontSize: 11, marginBottom: 6}}>{t.objects.tourNote}</Text> : null}

      <FlatList
        data={list}
        keyExtractor={(o) => o.id}
        renderItem={renderItem}
        style={{flex: 1}}
        contentContainerStyle={{paddingBottom: 30}}
        ListEmptyComponent={<Text style={{color: c.textFaint, textAlign: 'center', marginTop: 20}}>{t.objects.empty}</Text>}
      />

      <Modal visible={selected !== null} transparent animationType="slide"
        onRequestClose={() => setSelected(null)}>
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
                </Text>
                <Text style={{color: c.textDim, fontFamily: 'monospace', fontSize: 12}}>
                  {t.objects.mag} {selected.mag < 90 ? selected.mag.toFixed(1) : '—'}
                  {selected.sizeMin ? `   ${t.objects.size} ${selected.sizeMin.toFixed(0)}'` : ''}
                </Text>
              </View>
              <View style={{flexDirection: 'row', marginTop: 14}}>
                <Btn label={t.objects.goto} variant="primary" style={{flex: 1, marginRight: 6}}
                  onPress={() => doGoto(selected, 'goto')} />
                <Btn label={t.objects.set} style={{flex: 1, marginLeft: 6}}
                  onPress={() => {setTarget(selected.raDeg, selected.decDeg, selected.name); setSelected(null);}} />
              </View>
              <Btn label={t.common.close} variant="ghost" onPress={() => setSelected(null)} style={{marginTop: 8}} />
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}
