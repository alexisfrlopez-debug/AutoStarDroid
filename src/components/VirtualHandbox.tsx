/**
 * Raquette virtuelle — réplique fidèle du clavier Autostar #497 / Autostar II :
 *
 *   [ LCD 2×16 ]              <- LcdPanel, alimenté par le modèle de menus
 *   [ENTER][MODE][GO TO]      <- rangée de commandes (ordre physique)
 *         ▲                    <- croix directionnelle : maintien = slew
 *      ◀     ▶                    (:Mn/:Ms/:Me/:Mw, relâcher = :Q…)
 *         ▼
 *   [1 S][2 C][3 M]           <- pavé numérique ; étiquettes secondaires de
 *   [4 F][5 SS][6 ST]            l'Autostar II (SPEED/CALD/M/FOCUS/SS/STAR/
 *   [7 R][8 LC][9 N]             RET/LC/NGC) affichées selon le modèle choisi
 *        [0 ☀]
 *   [▲SC][ ? ][▼SC]           <- défilement des menus + aide contextuelle
 *
 * Synchronisation temps réel avec la raquette réelle : quand elle est ACTIVE
 * (par défaut à la connexion), le LCD affiche en continu le même écran
 * d'observation que la raquette physique (AD/DEC relues toutes les 500 ms,
 * alt/az toutes les 2 s, indicateur de mouvement) ; le bouton SYNCHRO sous
 * l'écran permet de la désactiver (retour au menu local) ou de la relancer
 * (appui long quand LIVE, appui direct quand elle est en erreur). Les touches
 * de navigation (MENU/ENTER/MODE/défilement) pilotent le modèle de menus
 * local, comme sur le matériel — le port série d'une raquette ne transmet
 * pas ces touches.
 */
import {useEffect, useMemo, useRef, useState} from 'react';
import {Pressable, Text, View, Vibration} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {autostar, type Dir} from '../services/protocol/client';
import {handboxSync, SYNC_FAST_MS} from '../services/protocol/handboxSync';
import {LcdPanel} from './LcdPanel';
import {usePal} from './ui';
import {
  buildMenuTree, nodeAt, findPath,
  type MenuNode, type TrackMode,
} from '../services/autostarMenus';
import {type DisplayObject} from '../services/catalog';
import {raDegToHMS, decDegToDMS} from '../services/astro/time';

type Speed = 'guide' | 'center' | 'find' | 'slew';

/** Raccourcis vitesse des raquettes #494/#495/#497 (touches 1-9). */
const DIGIT_SPEED: Record<number, Speed> = {
  1: 'guide', 2: 'guide', 3: 'center', 4: 'center', 5: 'center',
  6: 'find', 7: 'find', 8: 'slew', 9: 'slew',
};

export function VirtualHandbox() {
  const t = useT();
  const c = usePal();
  const site = useSettingsStore((s) => s.site);
  const model = useSettingsStore((s) => s.model);
  const nightVision = useSettingsStore((s) => s.nightVision);
  const keySounds = useSettingsStore((s) => s.keySounds);
  const connStatus = useScopeStore((s) => s.connStatus);
  const raDeg = useScopeStore((s) => s.raDeg);
  const decDeg = useScopeStore((s) => s.decDeg);
  const speed = useScopeStore((s) => s.speed);
  const alignMode = useScopeStore((s) => s.alignMode);
  const hbSync = useScopeStore((s) => s.hbSync);
  const hbMoving = useScopeStore((s) => s.hbMoving);
  const altDeg = useScopeStore((s) => s.altDeg);
  const azDeg = useScopeStore((s) => s.azDeg);

  const [cursor, setCursor] = useState<number[]>([]);
  const [input, setInput] = useState('');
  const [msg, setMsg] = useState('');
  const [posView, setPosView] = useState<'radec' | 'altaz'>('radec');
  const timers = useRef<number[]>([]);
  useEffect(() => () => {timers.current.forEach((id) => clearTimeout(id));}, []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms) as unknown as number);
  };
  const showMsg = (m: string, ms = 3500) => {
    setMsg(m);
    later(() => setMsg(''), ms);
  };
  const feedback = () => {
    if (useSettingsStore.getState().keySounds) {
      try {Vibration.vibrate(8);} catch (_) {}
    }
  };

  /* ---------- Actions protocole ---------- */
  const connected = connStatus === 'connected';

  async function gotoObject(o: DisplayObject) {
    if (!connected) {showMsg(t.errors.notConnected); return;}
    try {
      showMsg(`GOTO ${o.name}…`, 6000);
      const r = await autostar.gotoRaDec(o.raDeg, o.decDeg);
      if (r === 'ok') {
        useScopeStore.getState().setTarget(o.raDeg, o.decDeg, o.name);
        showMsg(`${o.name.slice(0, 12)} OK`, 4000);
      } else {
        showMsg(r === 'belowHorizon' ? t.objects.belowHorizon : t.hb.msgs.noObject, 4000);
      }
    } catch (e) {
      showMsg((e as Error).message, 4000);
    }
  }

  function syncPhone() {
    if (!connected) {showMsg(t.errors.notConnected); return;}
    showMsg(t.hb.msgs.syncing, 4000);
    autostar.pushPhoneData(site.latDeg, site.lonDeg)
      .then(() => showMsg(t.hb.msgs.synced, 3000))
      .catch((e: Error) => showMsg(e.message, 4000));
  }

  function readScope() {
    if (!connected) {showMsg(t.errors.notConnected); return;}
    showMsg(t.setup.scopeRead, 6000);
    autostar.readScopeData()
      .then((d) => showMsg(`${d.time} ${d.date}`, 5000))
      .catch((e: Error) => showMsg(e.message, 4000));
  }

  function applySpeed(s: Speed) {
    useScopeStore.getState().setSpeed(s);
    if (connected) autostar.setSpeed(s).catch(() => undefined);
  }

  /* ---------- Modèle de menus ---------- */
  const root: MenuNode = useMemo(() => buildMenuTree({
    t, site, model, speed, alignMode, nightVision, keySounds,
    actions: {
      gotoObject,
      showMsg,
      syncPhone,
      readScope,
      setSpeed: applySpeed,
      setTracking: (m: TrackMode) => {
        if (!connected) {showMsg(t.errors.notConnected); return;}
        autostar.setTracking(m).then(
          () => showMsg(t.hb.msgs.trackSet, 2500),
        ).catch((e: Error) => showMsg(e.message, 3500));
      },
      toggleNight: () => useSettingsStore.getState().setNightVision(!nightVision),
      toggleBeeps: () => useSettingsStore.getState().setKeySounds(!keySounds),
      focusIn: () => doFocus(true),
      focusOut: () => doFocus(false),
      focusStop: () => {if (connected) autostar.focusStop().catch(() => undefined);},
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [t, site, model, speed, alignMode, nightVision, keySounds, connStatus]);

  function doFocus(inward: boolean) {
    if (!connected) {showMsg(t.errors.notConnected); return;}
    autostar.focusStart(inward).catch(() => undefined);
    later(() => autostar.focusStop().catch(() => undefined), 2500);
  }

  const selected = nodeAt(root, cursor);
  const parent = nodeAt(root, cursor.slice(0, -1));
  const siblings = cursor.length ? (parent.children ?? []) : (root.children ?? []);

  /* ---------- Navigation ---------- */
  const enter = () => {
    if (input) {jumpToInput(false); return;}
    if (!cursor.length) {setCursor([0]); return;}
    if (selected.children?.length) {setInput(''); setCursor([...cursor, 0]); return;}
    selected.onEnter?.();
  };
  const mode = () => {
    setInput('');
    setMsg('');
    setCursor(cursor.slice(0, -1));
  };
  const modeRoot = () => {setInput(''); setMsg(''); setCursor([]);};
  const scroll = (delta: number) => {
    setInput('');
    if (!cursor.length) {
      const len = root.children?.length ?? 0;
      if (len) setCursor([delta > 0 ? 0 : len - 1]);
      return;
    }
    const len = siblings.length;
    if (!len) return;
    const idx = ((cursor[cursor.length - 1] ?? 0) + delta + len) % len;
    setCursor([...cursor.slice(0, -1), idx]);
  };
  const gotoKey = () => {
    if (input) {jumpToInput(true); return;}
    if (!cursor.length) {showMsg(t.hb.msgs.selectTarget); return;}
    if (selected.onGoto) {selected.onGoto(); return;}
    if (selected.children?.length) {setCursor([...cursor, 0]); return;}
    showMsg(t.hb.msgs.selectTarget);
  };

  /** Saisie de chiffres : saut direct à l'item n de la liste affichée. */
  const jumpToInput = (thenGoto: boolean) => {
    const n = parseInt(input, 10);
    setInput('');
    if (!n || n < 1 || n > siblings.length) {showMsg(t.hb.msgs.badIndex); return;}
    const target = [...cursor.slice(0, -1), n - 1];
    setCursor(target);
    if (thenGoto) {
      const node = nodeAt(root, target);
      node.onGoto?.();
    }
  };

  const typeDigit = (d: number) => {
    const numbered = !cursor.length ? false : (parent.numbered ?? false);
    if (!numbered) {nonDigitAction(d); return;}
    if (input.length < 3) setInput(input + String(d));
  };

  /** Étiquettes secondaires (Autostar II / LX200) et raccourcis vitesse (#49x). */
  const nonDigitAction = (d: number) => {
    const dual = model === 'autostar2' || model === 'lx200';
    if (d === 0) {
      const nv = !nightVision;
      useSettingsStore.getState().setNightVision(nv);
      showMsg(nv ? t.hb.msgs.nightOn : t.hb.msgs.nightOff, 2000);
      return;
    }
    if (dual) {
      const jump = (key: string) => {
        const p = findPath(root, key);
        if (p) {setCursor([...p, 0]); return true;}
        return false;
      };
      switch (d) {
        case 1: jump('speed'); return;                    // SPEED
        case 2: showMsg(t.hb.msgs.unavailable); return;   // CALD
        case 3: jump('messier'); return;                  // M
        case 4: jump('focus'); return;                    // FOCUS
        case 5: jump('planets'); return;                  // SS
        case 6: jump('stars'); return;                    // STAR
        case 7: showMsg(t.hb.msgs.reticle); return;       // RET
        case 8: showMsg(t.hb.msgs.landmark); return;      // LC.
        case 9: jump('ngc'); return;                      // NGC
      }
    } else {
      const s = DIGIT_SPEED[d];
      if (s) {
        applySpeed(s);
        const label = {guide: t.slew.guide, center: t.slew.center, find: t.slew.find, slew: t.slew.slew}[s];
        showMsg(`${t.slew.speed}: ${label}`, 2000);
      }
    }
  };

  const help = () => {
    const h = selected.help ?? t.hb.helpGeneric;
    setMsg(h.slice(0, 32));
    later(() => setMsg(''), 5000);
  };

  /* ---------- Slew directionnel (croix) ---------- */
  const activeDirs = useRef<Set<Dir>>(new Set());
  const dirStart = (d: Dir) => {
    feedback();
    if (!connected) {showMsg(t.errors.notConnected, 1500); return;}
    activeDirs.current.add(d);
    autostar.startMove(d).catch(() => undefined);
  };
  const dirStop = (d: Dir) => {
    if (!activeDirs.current.has(d)) return;
    activeDirs.current.delete(d);
    if (connected) autostar.stopMove(d).catch(() => undefined);
  };

  /* ---------- Affichage LCD ---------- */
  let line1: string;
  let line2: string;
  if (msg) {
    line1 = msg.slice(0, 16);
    line2 = msg.slice(16, 32);
  } else if (!cursor.length && connected && hbSync === 'live') {
    // Écran d'observation synchronisé : identique à la raquette physique
    line1 = `RA ${raDegToHMS(raDeg)}`;
    line2 = `DEC ${decDegToDMS(decDeg)}`;
  } else if (!cursor.length) {
    line1 = 'Select Item';
    line2 = '> ' + (root.children?.[0]?.line1 ?? '');
  } else {
    line1 = parent.line1.slice(0, 16);
    line2 = '> ' + (input ? input + '_' : (selected.line1 ?? ''));
  }
  const ctxLine = selected.line2 ?? '';
  // Ligne de télémétrie sous l'écran (appui = bascule AD/DEC ↔ Alt/Az)
  const raDecText = `${hbMoving ? '»' : ' '}${raDegToHMS(raDeg)}  ${decDegToDMS(decDeg)}`;
  const altAzText = altDeg !== null && azDeg !== null
    ? `ALT ${decDegToDMS(altDeg)}  AZ ${decDegToDMS(azDeg)}`
    : raDecText;
  const statusText = !connected
    ? 'RA --:--:--  DEC --°--'
    : cursor.length ? ctxLine : (posView === 'altaz' ? altAzText : raDecText);

  /* ---------- Composants de touches ---------- */
  const CmdKey = ({label, onPress, onLongPress}: {label: string; onPress: () => void; onLongPress?: () => void}) => (
    <Pressable
      onPress={() => {feedback(); onPress();}}
      onLongPress={onLongPress}
      delayLongPress={600}
      style={({pressed}) => ({
        flex: 1, height: 46, borderRadius: 10, justifyContent: 'center', alignItems: 'center',
        backgroundColor: pressed ? c.btnActive : c.btnBg, borderWidth: 1, borderColor: pressed ? c.amber : c.border, marginHorizontal: 3,
      })}>
      <Text style={{color: c.amber, fontWeight: '800', fontSize: 14, letterSpacing: 1}}>{label}</Text>
    </Pressable>
  );

  const ArrowKey = ({d, label, size = 56}: {d: Dir; label: string; size?: number}) => (
    <Pressable
      onPressIn={() => dirStart(d)}
      onPressOut={() => dirStop(d)}
      style={({pressed}) => ({
        width: size, height: size, borderRadius: size / 2, justifyContent: 'center', alignItems: 'center',
        backgroundColor: pressed ? c.btnActive : c.btnBg, borderWidth: 1.5, borderColor: pressed ? c.amber : c.border,
      })}>
      {({pressed}) => (
        <Text style={{color: pressed ? c.amber : c.text, fontSize: 22, fontWeight: '700'}}>{label}</Text>
      )}
    </Pressable>
  );

  const NumKey = ({digit, sub}: {digit: number; sub?: string}) => (
    <Pressable
      onPress={() => {feedback(); typeDigit(digit);}}
      style={({pressed}) => ({
        flex: 1, height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center',
        backgroundColor: pressed ? c.btnActive : c.btnBg, borderWidth: 1, borderColor: c.border, margin: 3,
      })}>
      {sub ? (
        <Text style={{color: c.textFaint, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.5, position: 'absolute', top: 4}}>
          {sub}
        </Text>
      ) : null}
      <Text style={{color: c.amber, fontWeight: '800', fontSize: 18, marginTop: sub ? 6 : 0}}>{digit}</Text>
    </Pressable>
  );

  const dual = model === 'autostar2' || model === 'lx200';

  /* ---------- Bouton de synchronisation temps réel ---------- */
  const pillBox = (bg: string, border: string) => ({
    height: 26, borderRadius: 13, justifyContent: 'center' as const, alignItems: 'center' as const,
    backgroundColor: bg, borderWidth: 1, borderColor: border, paddingHorizontal: 10, marginLeft: 8,
  });
  const SyncPill = () => {
    if (!connected) {
      return (
        <View style={pillBox(c.btnBg, c.border)}>
          <Text style={{color: c.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 0.5}}>{t.hb.sync.na}</Text>
        </View>
      );
    }
    if (hbSync === 'live') {
      return (
        <Pressable
          onPress={() => {feedback(); handboxSync.disable(); showMsg(t.hb.sync.stopped, 2200);}}
          onLongPress={() => {feedback(); handboxSync.restart(); showMsg(t.hb.sync.restarted, 2200);}}
          delayLongPress={600}
          style={({pressed}) => pillBox(pressed ? c.btnActive : 'rgba(63,214,140,0.12)', pressed ? c.amber : 'rgba(63,214,140,0.55)')}>
          <Text style={{color: c.green, fontSize: 10, fontWeight: '800', letterSpacing: 0.5}}>
            ● {t.hb.sync.live} {SYNC_FAST_MS / 1000}s
          </Text>
        </Pressable>
      );
    }
    if (hbSync === 'error') {
      return (
        <Pressable
          onPress={() => {feedback(); handboxSync.restart();}}
          style={({pressed}) => pillBox(pressed ? c.btnActive : 'rgba(255,93,93,0.12)', 'rgba(255,93,93,0.55)')}>
          <Text style={{color: c.red, fontSize: 10, fontWeight: '800', letterSpacing: 0.5}}>
            ⟳ {t.hb.sync.retry}
          </Text>
        </Pressable>
      );
    }
    return (
      <Pressable
        onPress={() => {feedback(); if (!handboxSync.enable()) showMsg(t.errors.notConnected, 2000);}}
        style={({pressed}) => pillBox(pressed ? c.btnActive : c.btnBg, c.border)}>
        <Text style={{color: c.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.5}}>{t.hb.sync.off}</Text>
      </Pressable>
    );
  };

  return (
    <View>
      {/* LCD + état live de la raquette réelle */}
      <LcdPanel line1={line1} line2={line2} />
      <View style={{flexDirection: 'row', alignItems: 'center', marginTop: 6, paddingHorizontal: 2}}>
        <Pressable
          onPress={() => setPosView((v) => (v === 'radec' ? 'altaz' : 'radec'))}
          style={{flex: 1}}>
          <Text style={{color: c.textDim, fontSize: 11, fontFamily: 'monospace'}} numberOfLines={1}>
            {statusText}
          </Text>
        </Pressable>
        <SyncPill />
      </View>

      {/* Rangée de commandes — ordre physique : ENTER MODE GO TO */}
      <View style={{flexDirection: 'row', marginTop: 10}}>
        <CmdKey label={t.hb.keys.enter} onPress={enter} />
        <CmdKey label={t.hb.keys.mode} onPress={mode} onLongPress={modeRoot} />
        <CmdKey label={t.hb.keys.goto} onPress={gotoKey} />
      </View>

      {/* Croix directionnelle */}
      <View style={{alignItems: 'center', marginTop: 12, marginBottom: 4}}>
        <ArrowKey d="n" label="▲" />
        <View style={{flexDirection: 'row', alignItems: 'center', marginVertical: 4}}>
          <ArrowKey d="w" label="◀" />
          <View style={{width: 18}} />
          <ArrowKey d="e" label="▶" />
        </View>
        <ArrowKey d="s" label="▼" />
      </View>

      {/* Pavé numérique + étiquettes secondaires */}
      <View style={{flexDirection: 'row'}}>
        <NumKey digit={1} sub={dual ? 'SPEED' : undefined} />
        <NumKey digit={2} sub={dual ? 'CALD' : undefined} />
        <NumKey digit={3} sub={dual ? 'M' : undefined} />
      </View>
      <View style={{flexDirection: 'row'}}>
        <NumKey digit={4} sub={dual ? 'FOCUS' : undefined} />
        <NumKey digit={5} sub={dual ? 'SS' : undefined} />
        <NumKey digit={6} sub={dual ? 'STAR' : undefined} />
      </View>
      <View style={{flexDirection: 'row'}}>
        <NumKey digit={7} sub={dual ? 'RET' : undefined} />
        <NumKey digit={8} sub={dual ? 'LC.' : undefined} />
        <NumKey digit={9} sub={dual ? 'NGC' : undefined} />
      </View>
      <View style={{flexDirection: 'row'}}>
        <View style={{flex: 1}} />
        <NumKey digit={0} sub="LIGHT" />
        <View style={{flex: 1}} />
      </View>

      {/* Défilement + aide — comme sous l'écran du matériel */}
      <View style={{flexDirection: 'row', marginTop: 6}}>
        <CmdKey label="▲" onPress={() => scroll(-1)} />
        <CmdKey label={t.hb.keys.help} onPress={help} />
        <CmdKey label="▼" onPress={() => scroll(1)} />
      </View>

      <Text style={{color: c.textFaint, fontSize: 10, textAlign: 'center', marginTop: 10, lineHeight: 15}}>
        {t.hb.keypadHelp}
      </Text>
    </View>
  );
}
