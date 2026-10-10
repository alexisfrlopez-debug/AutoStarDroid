/** Pad directionnel — maintenir = déplacer, relâcher = stop. */
import {useRef} from 'react';
import {View, Text, Pressable, StyleSheet, Vibration} from 'react-native';
import type {Dir} from '../services/protocol/client';
import {useSettingsStore} from '../store/settingsStore';
import {usePal} from './ui';

interface Props {
  onStart: (d: Dir) => void;
  onStop: (d: Dir) => void;
  size?: number;
  labels?: {n: string; s: string; e: string; w: string};
}

export function DirectionPad({onStart, onStop, size = 210}: Props) {
  const c = usePal();
  const btn = (size - 18) / 2 - 4;
  const active = useRef<Set<Dir>>(new Set());

  const start = (d: Dir) => {
    if (useSettingsStore.getState().keySounds) {
      try {Vibration.vibrate(8);} catch (_) {}
    }
    active.current.add(d);
    onStart(d);
  };
  const stop = (d: Dir) => {
    if (active.current.has(d)) {
      active.current.delete(d);
      onStop(d);
    }
  };

  const padBtn = (d: Dir, label: string, extra: object) => (
    <Pressable
      onPressIn={() => start(d)}
      onPressOut={() => stop(d)}
      style={({pressed}) => [styles.btn, {
        width: btn, height: btn, borderRadius: 14,
        backgroundColor: pressed ? c.btnActive : c.btnBg,
        borderColor: pressed ? c.amber : c.border,
      }, extra]}>
      {({pressed}) => (
        <Text style={{color: pressed ? c.amber : c.text, fontSize: 22, fontWeight: '700'}}>{label}</Text>
      )}
    </Pressable>
  );

  return (
    <View style={{width: size, height: size, alignSelf: 'center'}}>
      <View style={{flexDirection: 'row', justifyContent: 'center'}}>{padBtn('n', '▲', {})}</View>
      <View style={{flexDirection: 'row', justifyContent: 'center', marginVertical: 4}}>
        {padBtn('w', '◀', {marginRight: 4})}
        <View style={{width: btn, height: btn, justifyContent: 'center', alignItems: 'center'}}>
          <View style={{width: 10, height: 10, borderRadius: 5, backgroundColor: c.amberDim}} />
        </View>
        {padBtn('e', '▶', {marginLeft: 4})}
      </View>
      <View style={{flexDirection: 'row', justifyContent: 'center'}}>{padBtn('s', '▼', {})}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: {justifyContent: 'center', alignItems: 'center', borderWidth: 1.5},
});
