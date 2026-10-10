/**
 * Raquette virtuelle — clavier reconstruit automatiquement selon le
 * firmware détecté (voir services/protocol/keymaps.ts) :
 *
 *   À la connexion, l'app interroge :GVP#/:GVN# ; le firmware reconnu
 *   sélectionne le mappage (Autostar #497/#495/#494, Autostar II ou
 *   LX200 classique) : composition des rangées, étiquettes secondaires,
 *   comportement des chiffres et touches dédiées (FOCUS/RÉTICULE/SPEED
 *   du LX200) s'adaptent sans réglage. Si le firmware est muet ou
 *   inconnu, le modèle choisi dans Connexion/Réglages est conservé.
 *
 *   [ LCD 2×16 ]              <- LcdPanel, alimenté par le modèle de menus
 *   [badge FW + SYNCHRO]      <- état du firmware + synchro temps réel
 *   …rangées du mappage…      <- ENTER/MODE/GO TO, croix, pavé 0-9,
 *                                défilement + ? (ou clavier LX200)
 *
 * Synchronisation temps réel avec la raquette réelle — mode MIROIR :
 * quand la synchro est ACTIVE (par défaut à la connexion), le LCD affiche
 * EN CONTINU le même écran d'observation que la raquette physique (AD/DEC
 * relues toutes les 500 ms, alt/az toutes les 2 s) — la navigation locale
 * des menus n'est qu'un aperçu temporaire qui rend la main à l'écran
 * miroir après 5 s sans touche. Les appuis SUR LA RAQUETTE PHYSIQUE sont
 * répercutés : le mouvement constaté allume la croix virtuelle (directions
 * déduites des deltas AD/DEC), affiche ● PHYSIQUE et fait réapparaître
 * l'écran miroir aussitôt. Le bouton SYNCHRO sous l'écran permet de la
 * désactiver (retour au menu local) ou de la relancer (appui long quand
 * LIVE, appui direct quand elle est en erreur). Une pilule ■ STOP
 * apparaît pendant un mouvement. Le port série d'une raquette ne
 * transmettant pas ses touches de menu, les touches MODE/ENTER/défilement
 * pilotent le modèle de menus local, comme sur le matériel.
 */
import {useEffect, useMemo, useRef, useState} from 'react';
import {Pressable, Text, View, Vibration} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore} from '../store/settingsStore';
import {autostar, type Dir} from '../services/protocol/client';
import {handboxSync} from '../services/protocol/handboxSync';
import {useScopeStore, type HbHint} from '../store/scopeStore';
import {KEYMAPS, FW_SHORT, type KeyAct, type KeySpec} from '../services/protocol/keymaps';
import {LcdPanel} from './LcdPanel';
import {usePal} from './ui';
import {
  buildMenuTree, nodeAt, findPath,
  type MenuNode, type TrackMode,
} from '../services/autostarMenus';
import {type DisplayObject} from '../services/catalog';
import {raDegToHMS, decDegToDMS} from '../services/astro/time';

type Speed = 'guide' | 'center' | 'find' | 'slew';

/** Retour automatique à l'écran miroir après ce délai sans touche (menus). */
const MIRROR_RETURN_MS = 5000;

/** Ligne 2 du LCD quand la synchro est live sans position exploitable. */
const hintLcd = (hint: HbHint, t: {hb: {sync: Record<string, string>}}): string =>
  hint === 'init' ? t.hb.sync.lcdInit :
  hint === 'mute' ? t.hb.sync.lcdMute :
  t.hb.sync.waitPos;

/** Raccourcis vitesse des raquettes #494/#495/#497 (touches 1-9). */
const DIGIT_SPEED: Record<number, Speed> = {
  1: 'guide', 2: 'guide', 3: 'center', 4: 'center', 5: 'center',
  6: 'find', 7: 'find', 8: 'slew', 9: 'slew',
};

export function VirtualHandbox() {
  const t = useT();
  const c = usePal();
  const site = useSettingsStore((s) => s.site);
  const settingsModel = useSettingsStore((s) => s.model);
  const nightVision = useSettingsStore((s) => s.nightVision);
  const keySounds = useSettingsStore((s) => s.keySounds);
  const connStatus = useScopeStore((s) => s.connStatus);
  const raDeg = useScopeStore((s) => s.raDeg);
  const decDeg = useScopeStore((s) => s.decDeg);
  const speed = useScopeStore((s) => s.speed);
  const alignMode = useScopeStore((s) => s.alignMode);
  const hbSync = useScopeStore((s) => s.hbSync);
  const hbHint = useScopeStore((s) => s.hbHint);
  const hbMoving = useScopeStore((s) => s.hbMoving);
  const hbExternal = useScopeStore((s) => s.hbExternal);
  const hbDirs = useScopeStore((s) => s.hbDirs);
  const hasPos = useScopeStore((s) => s.hasPos);
  const altDeg = useScopeStore((s) => s.altDeg);
  const azDeg = useScopeStore((s) => s.azDeg);
  const fwModel = useScopeStore((s) => s.fwModel);
  const fwProduct = useScopeStore((s) => s.fwProduct);
  const fwVersion = useScopeStore((s) => s.fwVersion);

  /** Modèle actif : firmware détecté en priorité, modèle réglé en secours. */
  const model = fwModel ?? settingsModel;
  const keymap = KEYMAPS[model];
  const digitMode = keymap.digitMode;

  const [cursor, setCursor] = useState<number[]>([]);
  const [input, setInput] = useState('');
  const [msg, setMsg] = useState('');
  const [posView, setPosView] = useState<'radec' | 'altaz'>('radec');
  /** Aperçu temporaire des menus locaux quand la synchro est LIVE : sans
   *  touche pendant 5 s, l'écran miroir (AD/DEC de la raquette physique)
   *  reprend la main, pour que les 2 affichages restent identiques. */
  const [overlay, setOverlay] = useState(false);
  const overlayTimer = useRef<number | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => {
    timers.current.forEach((id) => clearTimeout(id));
    if (overlayTimer.current !== null) clearTimeout(overlayTimer.current);
  }, []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms) as unknown as number);
  };
  const armOverlay = () => {
    setOverlay(true);
    if (overlayTimer.current !== null) clearTimeout(overlayTimer.current);
    overlayTimer.current = setTimeout(
      () => setOverlay(false), MIRROR_RETURN_MS,
    ) as unknown as number;
  };
  /** La raquette physique bouge → l'écran miroir reprend la main aussitôt. */
  useEffect(() => {
    if (hbExternal) {
      setMsg('');
      setOverlay(false);
      if (overlayTimer.current !== null) {clearTimeout(overlayTimer.current); overlayTimer.current = null;}
    }
  }, [hbExternal]);
  /** Synchro (re)lancée → écran miroir immédiat. */
  useEffect(() => {
    if (hbSync === 'live') {setMsg(''); setOverlay(false);}
  }, [hbSync]);
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
    armOverlay();
    if (input) {jumpToInput(false); return;}
    if (!cursor.length) {setCursor([0]); return;}
    if (selected.children?.length) {setInput(''); setCursor([...cursor, 0]); return;}
    selected.onEnter?.();
  };
  const mode = () => {
    armOverlay();
    setInput('');
    setMsg('');
    setCursor(cursor.slice(0, -1));
  };
  const modeRoot = () => {armOverlay(); setInput(''); setMsg(''); setCursor([]);};
  const scroll = (delta: number) => {
    armOverlay();
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
    armOverlay();
    if (input) {jumpToInput(true); return;}
    if (!cursor.length) {showMsg(t.hb.msgs.selectTarget); return;}
    if (selected.onGoto) {selected.onGoto(); return;}
    if (selected.children?.length) {setCursor([...cursor, 0]); return;}
    showMsg(t.hb.msgs.selectTarget);
  };

  /** ENTER du LX200 classique : valider ET pointer l'objet sélectionné. */
  const enterGoto = () => {
    if (input) {jumpToInput(true); return;}
    if (!cursor.length) {showMsg(t.hb.msgs.selectTarget); return;}
    if (!selected.children?.length && selected.onGoto) {selected.onGoto(); return;}
    enter();
  };

  /** Touche SPEED du LX200 classique : cycle Guide→Center→Find→Slew. */
  const SPEED_ORDER: Speed[] = ['guide', 'center', 'find', 'slew'];
  const cycleSpeed = () => {
    const cur = useScopeStore.getState().speed;
    const next = SPEED_ORDER[(SPEED_ORDER.indexOf(cur) + 1) % SPEED_ORDER.length];
    applySpeed(next);
    const label = {guide: t.slew.guide, center: t.slew.center, find: t.slew.find, slew: t.slew.slew}[next];
    showMsg(`${t.slew.speed}: ${label}`, 1800);
  };

  /** Saisie de chiffres : saut direct à l'item n de la liste affichée. */
  const jumpToInput = (thenGoto: boolean) => {
    const n = parseInt(input, 10);
    setInput('');
    if (!n || n < 1 || n > siblings.length) {showMsg(t.hb.msgs.badIndex); return;}
    const target = [...cursor.slice(0, -1), n - 1];
    setCursor(target);
    armOverlay();
    if (thenGoto) {
      const node = nodeAt(root, target);
      node.onGoto?.();
    }
  };

  const typeDigit = (d: number) => {
    const numbered = !cursor.length ? false : (parent.numbered ?? false);
    if (!numbered) {nonDigitAction(d); return;}
    armOverlay();
    if (input.length < 3) setInput(input + String(d));
  };

  /** Étiquettes secondaires et raccourcis selon le mappage du firmware. */
  const nonDigitAction = (d: number) => {
    if (d === 0) {
      const nv = !nightVision;
      useSettingsStore.getState().setNightVision(nv);
      showMsg(nv ? t.hb.msgs.nightOn : t.hb.msgs.nightOff, 2000);
      return;
    }
    if (digitMode === 'menuJumps') {
      const jump = (key: string) => {
        const p = findPath(root, key);
        if (p) {armOverlay(); setCursor([...p, 0]); return true;}
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
    } else if (digitMode === 'speedShortcuts') {
      const s = DIGIT_SPEED[d];
      if (s) {
        applySpeed(s);
        const label = {guide: t.slew.guide, center: t.slew.center, find: t.slew.find, slew: t.slew.slew}[s];
        showMsg(`${t.slew.speed}: ${label}`, 2000);
      }
    }
    // 'plain' (LX200 classique) : hors liste, les chiffres ne font rien —
    // comme sur le handpad d'origine.
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
    autostar.setVirtualHold(d, true); // maintien virtuel ≠ mouvement physique
    autostar.startMove(d).catch(() => undefined);
  };
  const dirStop = (d: Dir) => {
    if (!activeDirs.current.has(d)) return;
    activeDirs.current.delete(d);
    if (connected) {
      autostar.setVirtualHold(d, false); // libère l'attribution immédiatement
      autostar.stopMove(d).catch(() => undefined);
    }
  };

  /* ---------- Affichage LCD (mode miroir de la raquette physique) ---------- */
  const mirrorActive = connected && hbSync === 'live' && !msg && !overlay;
  // directions constatées SUR LE MATÉRIEL (croix virtuelle allumée en retour)
  const NO_DIR: Record<Dir, boolean> = {n: false, s: false, e: false, w: false};
  const phys: Record<Dir, boolean> = connected && hbExternal ? (hbDirs ?? NO_DIR) : NO_DIR;
  const litDirs: Record<Dir, boolean> = {
    n: !!phys.n, s: !!phys.s, e: !!phys.e, w: !!phys.w,
  };
  const dirGlyph = (d: Dir) => ({n: '▲', s: '▼', e: '▶', w: '◀'} as Record<Dir, string>)[d];
  const physGlyphs = (['n', 's', 'e', 'w'] as Dir[]).filter((d) => litDirs[d]).map(dirGlyph).join('');
  let line1: string;
  let line2: string;
  if (msg) {
    line1 = msg.slice(0, 16);
    line2 = msg.slice(16, 32);
  } else if (mirrorActive && !hasPos) {
    // synchro live mais pas encore de position utilisable :
    // PAS de faux « RA 00:00:00 » — le diagnostic suit sous les pastilles
    line1 = 'SYNCHRO LIVE';
    line2 = hintLcd(hbHint, t).slice(0, 16);
  } else if (mirrorActive) {
    // Écran d'observation synchronisé : identique à la raquette physique
    line1 = `RA ${raDegToHMS(raDeg)}`;
    line2 = `DEC ${decDegToDMS(decDeg)}`;
  } else if (!cursor.length && connected && hbSync === 'live' && hasPos) {
    // aperçu menu terminé : dernière position connue maintenue à l'écran
    // (le diagnostic éventuel est détaillé par la ligne rouge sous les
    // pastilles)
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
  // — tirets tant qu'aucune position n'a été lue sur cette liaison
  const raDecText = !hasPos
    ? 'RA --:--:--  DEC --°--'
    : `${hbMoving ? '»' : ' '}${raDegToHMS(raDeg)}  ${decDegToDMS(decDeg)}`;
  const altAzText = altDeg !== null && azDeg !== null
    ? `ALT ${decDegToDMS(altDeg)}  AZ ${decDegToDMS(azDeg)}`
    : raDecText;
  const mirrorPrefix = physGlyphs ? `»»${physGlyphs} ` : '';
  const statusText = !connected
    ? 'RA --:--:--  DEC --°--'
    : mirrorActive
      ? mirrorPrefix + (posView === 'altaz' ? altAzText : raDecText)
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

  const ArrowKey = ({d, label, size = 56, lit = false}: {d: Dir; label: string; size?: number; lit?: boolean}) => (
    <Pressable
      onPressIn={() => dirStart(d)}
      onPressOut={() => dirStop(d)}
      style={({pressed}) => ({
        width: size, height: size, borderRadius: size / 2, justifyContent: 'center', alignItems: 'center',
        backgroundColor: pressed || lit ? c.btnActive : c.btnBg,
        borderWidth: pressed || lit ? 2.5 : 1.5,
        borderColor: pressed || lit ? c.amber : c.border,
        shadowColor: c.amber, shadowOpacity: lit ? 0.9 : 0, shadowRadius: 6,
      })}>
      {({pressed}) => (
        <Text style={{color: pressed || lit ? c.amber : c.text, fontSize: 22, fontWeight: '700'}}>{label}</Text>
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

  /* ---------- Rendu du mappage (keymaps.ts) ---------- */
  const keyLabel = (k: {label?: string; labelKey: string}) =>
    k.label ?? ((t.hb.keys as Record<string, string>)[k.labelKey] ?? k.labelKey);

  const runAct = (a: KeyAct, label: string) => {
    switch (a) {
      case 'enter': enter(); break;
      case 'enterGoto': enterGoto(); break;
      case 'mode': mode(); break;
      case 'goto': gotoKey(); break;
      case 'help': help(); break;
      case 'scrollUp': scroll(-1); break;
      case 'scrollDown': scroll(1); break;
      case 'speedCycle': cycleSpeed(); break;
      case 'reticlePlus': case 'reticleMinus':
        if (!connected) {showMsg(t.errors.notConnected, 1500); return;}
        autostar.reticleAdjust(a === 'reticlePlus' ? 1 : -1).catch(() => undefined);
        showMsg(label, 1200);
        break;
      default: break;
    }
  };

  /** Touches FOCUS : maintien = moteur, relâcher = stop (:F± / :FQ). */
  const HoldKey = ({label, inward}: {label: string; inward: boolean}) => (
    <Pressable
      onPressIn={() => {
        feedback();
        if (!connected) {showMsg(t.errors.notConnected, 1500); return;}
        autostar.focusStart(inward).catch(() => undefined);
      }}
      onPressOut={() => {if (connected) autostar.focusStop().catch(() => undefined);}}
      style={({pressed}) => ({
        flex: 1, height: 46, borderRadius: 10, justifyContent: 'center', alignItems: 'center',
        backgroundColor: pressed ? c.btnActive : c.btnBg, borderWidth: 1, borderColor: pressed ? c.amber : c.border, marginHorizontal: 3,
      })}>
      <Text style={{color: c.amber, fontWeight: '800', fontSize: 12, letterSpacing: 0.5}}>{label}</Text>
    </Pressable>
  );

  const renderKey = (k: KeySpec, key: string) => {
    switch (k.t) {
      case 'gap': return <View key={key} style={{flex: 1}} />;
      case 'spacer': return <View key={key} style={{width: k.w}} />;
      case 'dir': return <ArrowKey key={key} d={k.dir} label={k.label} lit={litDirs[k.dir]} />;
      case 'digit': return <NumKey key={key} digit={k.digit} sub={k.sub} />;
      case 'act': {
        const label = keyLabel(k);
        if (k.act === 'focusIn') return <HoldKey key={key} label={label} inward />;
        if (k.act === 'focusOut') return <HoldKey key={key} label={label} inward={false} />;
        return (
          <CmdKey key={key} label={label} onPress={() => runAct(k.act, label)}
            onLongPress={k.act === 'mode' ? modeRoot : undefined} />
        );
      }
      default: return null;
    }
  };

  /* ---------- Boutons de synchro temps réel et d'arrêt d'urgence ---------- */
  const pillBox = (bg: string, border: string) => ({
    height: 26, borderRadius: 13, justifyContent: 'center' as const, alignItems: 'center' as const,
    backgroundColor: bg, borderWidth: 1, borderColor: border, paddingHorizontal: 10, marginLeft: 8,
  });

  /** ■ STOP : coupe tout mouvement (:Q#) — visible uniquement en mouvement. */
  const StopPill = () => (
    <Pressable
      onPress={() => {feedback(); autostar.stopAll().catch(() => undefined); showMsg(t.common.stop, 1200);}}
      style={({pressed}) => pillBox(pressed ? c.btnActive : 'rgba(255,93,93,0.12)', 'rgba(255,93,93,0.55)')}>
      <Text style={{color: c.red, fontSize: 10, fontWeight: '800', letterSpacing: 0.5}}>■ {t.common.stop}</Text>
    </Pressable>
  );
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
            ● {t.hb.sync.live}
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

  /** ⟳ RELANCER : visible quand la liaison répond mais que la position ne
   *  vient pas (raquette (re)branchée, monture allumée en cours de route…) —
   *  la synchro reste LIVE et se rétablit aussi toute seule. */
  const RetryPill = () => (
    <Pressable
      onPress={() => {feedback(); handboxSync.restart(); showMsg(t.hb.sync.restarted, 2200);}}
      style={({pressed}) => pillBox(pressed ? c.btnActive : 'rgba(255,93,93,0.12)', 'rgba(255,93,93,0.55)')}>
      <Text style={{color: c.red, fontSize: 10, fontWeight: '800', letterSpacing: 0.5}}>
        ⟳ {t.hb.sync.retry}
      </Text>
    </Pressable>
  );

  /* ---------- Badge firmware (mappage auto du clavier) ---------- */
  const fwShort = FW_SHORT[model];
  let fwLine: string | null = null;
  if (connected) {
    const prod = (fwProduct ?? '').trim();
    if (prod && prod !== '?') {
      fwLine = fwModel
        ? t.hb.fw.detected.replace('{0}', prod).replace('{1}', fwVersion ?? '?').replace('{2}', fwShort)
        : t.hb.fw.fallback.replace('{0}', prod).replace('{1}', fwVersion ?? '?').replace('{2}', fwShort);
    } else {
      fwLine = t.hb.fw.unknown.replace('{2}', fwShort);
    }
  }

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
        {connected && hbMoving ? <StopPill /> : null}
        {connected && hbExternal ? (
          <View style={pillBox('rgba(255,170,60,0.14)', 'rgba(255,170,60,0.6)')}>
            <Text style={{color: c.amber, fontSize: 10, fontWeight: '800', letterSpacing: 0.5}}>
              ● {t.hb.sync.phys}
            </Text>
          </View>
        ) : null}
        <SyncPill />
        {connected && hbSync === 'live' && hbHint === 'mute' ? <RetryPill /> : null}
      </View>
      {connected && hbSync === 'live' && hbHint === 'mute' ? (
        <Text numberOfLines={3}
          style={{color: c.red, fontSize: 10, lineHeight: 14, textAlign: 'center', marginTop: 4}}>
          {t.hb.sync.errNoPos}
        </Text>
      ) : null}
      {connected && hbSync === 'live' && hbHint === 'init' ? (
        <Text numberOfLines={3}
          style={{color: c.amber, fontSize: 10, lineHeight: 14, textAlign: 'center', marginTop: 4}}>
          {t.hb.sync.errInit}
        </Text>
      ) : null}
      {fwLine ? (
        <Text numberOfLines={1}
          style={{color: c.textFaint, fontSize: 9.5, textAlign: 'center', marginTop: 4, letterSpacing: 0.3}}>
          {fwLine}
        </Text>
      ) : null}

      {/* Clavier — rangées issues du mappage du firmware détecté */}
      {keymap.rows.map((row, ri) => (
        <View
          key={`${model}-${ri}`}
          style={{
            flexDirection: 'row',
            marginTop: ri === 0 ? 10 : (row.center ? 8 : 2),
            justifyContent: row.center ? 'center' : 'flex-start',
            alignItems: row.center ? 'center' : 'stretch',
          }}>
          {row.keys.map((k, ki) => renderKey(k, `${ki}`))}
        </View>
      ))}

      <Text style={{color: c.textFaint, fontSize: 10, textAlign: 'center', marginTop: 10, lineHeight: 15}}>
        {t.hb.keypadHelp}
      </Text>
    </View>
  );
}
