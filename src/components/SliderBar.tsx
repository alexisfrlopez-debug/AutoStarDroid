/**
 * Curseur horizontal SANS dépendance native (v2.7.0 — « je voudrais aussi
 * pouvoir régler manuellement les paramètres de la caméra » ; le composant
 * Slider de la communauté n'est pas dans les dépendances du projet).
 * PanResponder pur JS : tap ou glisser → valeur bornée + pas.
 *
 * `snapToRange` est exporté pur (testable Jest) : borne + pas + arrondi.
 */
import {useRef, useState} from 'react';
import {View, Text, PanResponder, LayoutChangeEvent} from 'react-native';
import {usePal} from './ui';

/** Borne `v` dans [min,max], arrondie au pas `step` (> 0), décimales selon step. */
export function snapToRange(v: number, min: number, max: number, step: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const st = step > 0 ? step : 1;
  const k = Math.round((Math.min(hi, Math.max(lo, v)) - lo) / st);
  const out = lo + k * st;
  const dec = (String(st).split('.')[1] ?? '').length;
  return Number(out.toFixed(Math.min(dec, 6)));
}

export function SliderBar({
  label, value, min, max, step, unit, onCommit, format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onCommit: (v: number) => void;
  /** Format d'affichage de la valeur (défaut : adaptatif). */
  format?: (v: number) => string;
}) {
  const c = usePal();
  const [width, setWidth] = useState(1);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(1);
  const lastEmitted = useRef(value);

  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const frac = hi > lo ? Math.min(1, Math.max(0, (value - lo) / (hi - lo))) : 0;

  const emit = (px: number) => {
    const w = Math.max(1, widthRef.current);
    const f = Math.min(1, Math.max(0, px / w));
    const v = snapToRange(lo + f * (hi - lo), lo, hi, step);
    if (v !== lastEmitted.current) {
      lastEmitted.current = v;
      onCommit(v);
    }
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => { setDragging(true); emit(e.nativeEvent.locationX); },
      onPanResponderMove: (e) => emit(e.nativeEvent.locationX),
      onPanResponderRelease: () => setDragging(false),
      onPanResponderTerminate: () => setDragging(false),
    }),
  ).current;

  const onLayout = (e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width;
    setWidth(e.nativeEvent.layout.width);
  };

  const disp = format ? format(value)
    : Math.abs(value) >= 100 ? String(Math.round(value))
    : Math.abs(value) >= 10 ? value.toFixed(1)
    : value.toFixed(2);

  // Knob 22 px : fraction ajustée pour rester dans la piste
  const knobPct = width > 44 ? frac : 0;

  return (
    <View style={{marginTop: 8}}>
      <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2}}>
        <Text style={{color: c.textDim, fontSize: 12}}>{label}</Text>
        <Text style={{color: dragging ? c.amber : c.text, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums']}}>
          {disp}{unit ? ` ${unit}` : ''}
        </Text>
      </View>
      <View
        onLayout={onLayout}
        {...pan.panHandlers}
        style={{
          height: 30, justifyContent: 'center', borderRadius: 8,
        }}>
        <View style={{height: 6, borderRadius: 3, backgroundColor: c.bgPanel2, borderWidth: 1, borderColor: c.border}}>
          <View style={{
            height: 6, borderRadius: 3, backgroundColor: c.amber,
            width: `${Math.round(knobPct * 100)}%` as `${number}%`,
          }} />
        </View>
        <View style={{
          position: 'absolute', left: `${Math.round(knobPct * 100)}%` as `${number}%`,
          marginLeft: -11, width: 22, height: 22, borderRadius: 11,
          backgroundColor: c.bgPanel, borderWidth: 2, borderColor: c.amber,
        }} />
      </View>
    </View>
  );
}
