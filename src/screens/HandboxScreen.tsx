/**
 * Écran Raquette virtuelle : émulation de l'afficheur LCD et du clavier
 * Autostar II (menus arborescents + touches physiques reliées au protocole).
 */
import {useEffect, useMemo, useRef, useState} from 'react';
import {ScrollView, Text, View, Pressable, Vibration} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {autostar} from '../services/protocol/client';
import {LcdPanel} from '../components/LcdPanel';
import {StatusHeader} from '../components/StatusHeader';
import {Card, Title, usePal} from '../components/ui';
import {MESSIER} from '../services/catalog';

/** Nœud de menu émulé. */
interface MenuNode {
  key: string;
  children?: MenuNode[];
  line1?: string;
  line2?: string;
  /** Action protocole exécutée quand on appuie ENTER/GOTO sur le nœud. */
  onEnter?: () => void;
  onGoto?: () => void;
}

export function HandboxScreen() {
  const t = useT();
  const c = usePal();
  const site = useSettingsStore((s) => s.site);
  const connStatus = useScopeStore((s) => s.connStatus);
  const scopeTime = useScopeStore((s) => s.scopeTime);
  const [path, setPath] = useState<number[]>([]);
  const [msg, setMsg] = useState('');

  // Nettoyage des temporisateurs de message au démontage (évite setState après unmount)
  const timers = useRef<number[]>([]);
  useEffect(() => () => {timers.current.forEach((id) => clearTimeout(id));}, []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms) as unknown as number);
  };
  /** Retour haptique léger sur les touches si activé dans les réglages. */
  const keyFeedback = () => {
    if (useSettingsStore.getState().keySounds) {
      try {Vibration.vibrate(8);} catch (_) {}
    }
  };

  const root: MenuNode = useMemo(() => ({
    key: 'root',
    line1: 'AUTOSTAR II',
    line2: 'Bienvenue/Welcome',
    children: [
      {
        key: 'object',
        line1: t.handbox.menus.object,
        line2: '> ' + t.handbox.menus.item,
        children: [
          {
            key: 'item',
            line1: t.handbox.menus.object,
            line2: 'M1..' + String(MESSIER.length),
            onGoto: () => doGotoMessier(1),
          },
          {key: 'tour', line1: t.handbox.menus.tour, line2: 'Appuyer GOTO'},
          {key: 'target', line1: t.handbox.menus.target, line2: 'RA/DEC'},
        ],
      },
      {
        key: 'setup',
        line1: t.handbox.menus.setup,
        line2: '> Date/Time/Site',
        children: [
          {key: 'date', line1: t.handbox.menus.date, line2: scopeDate(), onEnter: () => syncNow()},
          {key: 'time', line1: t.handbox.menus.time, line2: scopeTime, onEnter: () => syncNow()},
          {key: 'site', line1: t.handbox.menus.site, line2: `${site.latDeg.toFixed(1)} ${site.lonDeg.toFixed(1)}`, onEnter: () => syncNow()},
        ],
      },
      {key: 'guiding', line1: t.handbox.menus.guiding, line2: 'Rate / PEC'},
      {key: 'util', line1: t.handbox.menus.util, line2: '> Beep/Align', children: [
        {key: 'beep', line1: t.handbox.menus.beep, line2: t.common.on},
      ]},
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [t, site, scopeTime, connStatus]);

  const current = useMemo(() => {
    let node = root;
    for (const i of path) node = node.children?.[i] ?? node;
    return node;
  }, [path, root]);

  const line1 = current.line1 ?? '';
  const line2 = current.line2 ?? (current.children?.length ? '> ' + current.children[0].line1 : '');

  function scopeDate(): string {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
  }

  async function syncNow() {
    if (connStatus !== 'connected') {setMsg(t.errors.notConnected); return;}
    try {
      await autostar.pushPhoneData(site.latDeg, site.lonDeg);
      setMsg(t.setup.synced);
      later(() => setMsg(''), 3000);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function doGotoMessier(n: number) {
    if (connStatus !== 'connected') {setMsg(t.errors.notConnected); return;}
    const m = MESSIER[n - 1];
    if (!m) return;
    try {
      setMsg(`GOTO ${m.name}...`);
      const r = await autostar.gotoRaDec(m.raDeg, m.decDeg);
      setMsg(r === 'ok' ? `${m.name} OK` : t.objects.belowHorizon);
      later(() => setMsg(''), 4000);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const enter = () => {
    if (current.children?.length) setPath([...path, 0]);
    else current.onEnter?.();
  };
  const mode = () => {
    setPath(path.slice(0, -1));
    setMsg('');
  };
  const up = () => {
    if (!path.length) return;
    const parentPath = path.slice(0, -1);
    let node = root;
    for (const i of parentPath) node = node.children?.[i] ?? node;
    const idx = path[path.length - 1];
    const next = (idx - 1 + (node.children?.length ?? 0)) % (node.children?.length || 1);
    setPath([...parentPath, next]);
  };
  const down = () => {
    if (!path.length) return;
    const parentPath = path.slice(0, -1);
    let node = root;
    for (const i of parentPath) node = node.children?.[i] ?? node;
    const idx = path[path.length - 1];
    const next = (idx + 1) % (node.children?.length || 1);
    setPath([...parentPath, next]);
  };
  const goto = () => {
    if (current.onGoto) current.onGoto();
    else if (current.children?.length) setPath([...path, 0]);
  };

  const Key = ({label, onPress, wide}: {label: string; onPress: () => void; wide?: boolean}) => (
    <Pressable onPress={() => {keyFeedback(); onPress();}}
      style={({pressed}) => ({
        flex: wide ? 2 : 1, height: 46, borderRadius: 10, justifyContent: 'center', alignItems: 'center',
        backgroundColor: pressed ? c.btnActive : c.btnBg, borderWidth: 1, borderColor: c.border, margin: 3,
      })}>
      <Text style={{color: c.amber, fontWeight: '800', fontSize: 13}}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView style={{flex: 1, backgroundColor: c.bg}} contentContainerStyle={{padding: 12, paddingBottom: 40}}>
      <StatusHeader />
      <Card style={{marginTop: 8}}>
        <Title text={t.handbox.title} />
        <Text style={{color: c.textFaint, fontSize: 11, marginBottom: 8}}>{t.handbox.help}</Text>
        <LcdPanel line1={msg || line1} line2={msg ? '' : line2} />
        <Text style={{color: c.textFaint, fontSize: 10, textAlign: 'center', marginTop: 4, fontFamily: 'monospace'}}>
          {path.join('/')}
        </Text>
      </Card>

      <Card style={{marginTop: 12}}>
        <View style={{flexDirection: 'row'}}>
          <Key label={t.handbox.keys.mode} onPress={mode} />
          <Key label={t.handbox.keys.enter} onPress={enter} />
          <Key label={t.handbox.keys.goto} onPress={goto} />
        </View>
        <View style={{flexDirection: 'row'}}>
          <Key label={t.handbox.keys.up} onPress={up} />
          <Key label={t.handbox.keys.down} onPress={down} />
          <Key label={t.handbox.keys.help} onPress={() => setMsg('AutoStar Droid')} />
        </View>
        <View style={{flexDirection: 'row'}}>
          <Key label="ESC" wide onPress={() => {setPath([]); setMsg('');}} />
          <Key label="SYNC" wide onPress={syncNow} />
        </View>
      </Card>
    </ScrollView>
  );
}
