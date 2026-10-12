/**
 * Menu déroulant SANS dépendance native (v2.7.0 — « un menu déroulant pour
 * choisir la marque et un autre pour les modèles ») : Modal plein écran +
 * liste scrollable + recherche intégrée (listes longues : Meade, Celestron,
 * Sky-Watcher…). Pure JS — testable react-test-renderer.
 */
import {useState} from 'react';
import {View, Text, TouchableOpacity, Modal, ScrollView, TextInput} from 'react-native';
import {usePal} from './ui';

export interface DropdownOption {
  key: string;
  label: string;
  /** Sous-titre optionnel (protocole, note). */
  hint?: string;
}

export function Dropdown({
  label, value, options, onChange, placeholder,
}: {
  label: string;
  value: string | null;
  options: DropdownOption[];
  onChange: (key: string) => void;
  placeholder?: string;
}) {
  const c = usePal();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const current = options.find((o) => o.key === value) ?? null;

  const shown = filter.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(filter.trim().toLowerCase()))
    : options;

  return (
    <View style={{marginTop: 8}}>
      <Text style={{color: c.textDim, fontSize: 12, marginBottom: 4}}>{label}</Text>
      <TouchableOpacity
        onPress={() => { setFilter(''); setOpen(true); }}
        style={{
          backgroundColor: c.bgPanel2, borderRadius: 10, borderWidth: 1, borderColor: c.border,
          paddingHorizontal: 12, paddingVertical: 11, flexDirection: 'row',
          justifyContent: 'space-between', alignItems: 'center',
        }}>
        <Text style={{color: current ? c.text : c.textFaint, fontSize: 15}} numberOfLines={1}>
          {current ? current.label : (placeholder ?? '—')}
        </Text>
        <Text style={{color: c.textFaint, fontSize: 13, marginLeft: 8}}>▾</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end'}}>
          <View style={{
            backgroundColor: c.bgPanel, borderTopLeftRadius: 18, borderTopRightRadius: 18,
            borderWidth: 1, borderColor: c.border, maxHeight: '75%', paddingBottom: 16,
          }}>
            <View style={{padding: 12, borderBottomWidth: 1, borderBottomColor: c.border}}>
              <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}}>
                <Text style={{color: c.text, fontSize: 15, fontWeight: '700'}}>{label}</Text>
                <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                  <Text style={{color: c.textFaint, fontSize: 18, paddingHorizontal: 6}}>✕</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                value={filter}
                onChangeText={setFilter}
                placeholder='⋯'
                placeholderTextColor={c.textFaint}
                style={{
                  backgroundColor: c.bgPanel2, color: c.text, borderRadius: 8, borderWidth: 1,
                  borderColor: c.border, paddingHorizontal: 10, paddingVertical: 7,
                  fontSize: 14, marginTop: 10,
                }}
              />
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">
              {shown.map((o) => {
                const on = o.key === value;
                return (
                  <TouchableOpacity key={o.key}
                    onPress={() => { setOpen(false); onChange(o.key); }}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 11, flexDirection: 'row',
                      alignItems: 'center', justifyContent: 'space-between',
                      backgroundColor: on ? c.btnActive : 'transparent',
                    }}>
                    <View style={{flex: 1, paddingRight: 8}}>
                      <Text style={{color: on ? c.amber : c.text, fontSize: 15, fontWeight: on ? '700' : '400'}}>
                        {o.label}
                      </Text>
                      {o.hint ? (
                        <Text style={{color: c.textFaint, fontSize: 11, marginTop: 1}}>{o.hint}</Text>
                      ) : null}
                    </View>
                    {on ? <Text style={{color: c.amber, fontSize: 15, fontWeight: '800'}}>✓</Text> : null}
                  </TouchableOpacity>
                );
              })}
              {shown.length === 0 ? (
                <Text style={{color: c.textFaint, fontSize: 13, padding: 14, textAlign: 'center'}}>—</Text>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
