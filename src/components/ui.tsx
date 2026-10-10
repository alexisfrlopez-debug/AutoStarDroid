/** Petits composants réutilisables. */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity, TextInput} from 'react-native';
import {theme} from '../theme/colors';
import {useSettingsStore} from '../store/settingsStore';

export function usePal() {
  const nv = useSettingsStore((s) => s.nightVision);
  return theme(nv);
}

export function Card({children, style}: {children: React.ReactNode; style?: object}) {
  const c = usePal();
  return <View style={[{backgroundColor: c.bgPanel, borderRadius: 14, borderWidth: 1, borderColor: c.border, padding: 12}, style]}>{children}</View>;
}

export function Title({text}: {text: string}) {
  const c = usePal();
  return <Text style={{color: c.textDim, fontSize: 13, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase'}}>{text}</Text>;
}

export function Btn({
  label, onPress, variant = 'normal', disabled, style,
}: {label: string; onPress?: () => void; variant?: 'normal' | 'primary' | 'danger' | 'ghost'; disabled?: boolean; style?: object}) {
  const c = usePal();
  const bg = variant === 'primary' ? c.amber : variant === 'danger' ? c.danger : variant === 'ghost' ? 'transparent' : c.btnBg;
  const fg = variant === 'primary' ? '#0A0D14' : c.text;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      style={[{
        backgroundColor: bg, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16,
        borderWidth: variant === 'ghost' ? 1 : 0, borderColor: c.border, opacity: disabled ? 0.4 : 1,
      }, style]}>
      <Text style={{color: fg, fontWeight: '700', fontSize: 14, textAlign: 'center'}}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Input(props: React.ComponentProps<typeof TextInput> & {label?: string}) {
  const c = usePal();
  const {label, style, ...rest} = props;
  return (
    <View style={{marginBottom: 10}}>
      {label ? <Text style={{color: c.textDim, fontSize: 12, marginBottom: 4}}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={c.textFaint}
        style={[{
          backgroundColor: c.bgPanel2, color: c.text, borderRadius: 10, borderWidth: 1,
          borderColor: c.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
        }, style]}
        {...rest}
      />
    </View>
  );
}

export function Segmented<T extends string>({
  options, value, onChange,
}: {options: Array<{key: T; label: string}>; value: T; onChange: (v: T) => void}) {
  const c = usePal();
  return (
    <View style={{flexDirection: 'row', backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.border, overflow: 'hidden'}}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <TouchableOpacity
            key={o.key}
            onPress={() => onChange(o.key)}
            style={{flex: 1, paddingVertical: 10, backgroundColor: active ? c.btnActive : 'transparent', alignItems: 'center'}}>
            <Text style={{color: active ? c.amber : c.textDim, fontWeight: '700', fontSize: 13}}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function Toggle({value, onChange, label}: {value: boolean; onChange: (v: boolean) => void; label: string}) {
  const c = usePal();
  return (
    <TouchableOpacity onPress={() => onChange(!value)} style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10}}>
      <Text style={{color: c.text, fontSize: 15}}>{label}</Text>
      <View style={{width: 48, height: 28, borderRadius: 14, backgroundColor: value ? c.amber : c.btnBg, borderWidth: 1, borderColor: c.border, justifyContent: 'center', paddingHorizontal: 2}}>
        <View style={{width: 22, height: 22, borderRadius: 11, backgroundColor: value ? '#0A0D14' : c.textFaint, alignSelf: value ? 'flex-end' : 'flex-start'}} />
      </View>
    </TouchableOpacity>
  );
}

export function Readout({label, value, unit}: {label: string; value: string; unit?: string}) {
  const c = usePal();
  return (
    <View style={{flex: 1}}>
      <Text style={{color: c.textDim, fontSize: 11, letterSpacing: 1}}>{label}</Text>
      <Text style={{color: c.amber, fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums']}}>
        {value}
        {unit ? <Text style={{fontSize: 12, color: c.textDim}}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

export const s = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center'},
  between: {justifyContent: 'space-between'},
  wrap: {flexWrap: 'wrap'},
  center: {alignItems: 'center', justifyContent: 'center'},
});
