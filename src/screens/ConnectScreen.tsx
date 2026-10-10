/** Écran Connexion : modèle + 4 liaisons (Wi-Fi/BT/USB/Démo) + détection du firmware. */
import {useEffect, useState} from 'react';
import {Platform, PermissionsAndroid, ScrollView, View, Text, TouchableOpacity} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore, ScopeModelId} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {autostar} from '../services/protocol/client';
import {UsbSerialNative, UsbDeviceInfo, BluetoothSppNative} from '../services/connection';
import {PROFILES} from '../services/protocol/profiles';
import {FW_SHORT} from '../services/protocol/keymaps';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, Card, Input, Segmented, Title, usePal} from '../components/ui';

/** Capacités affichées pour la configuration active (ordre du profil). */
const CAP_KEYS = ['serial', 'setDateTime', 'setSite', 'alignCmds', 'focus', 'pec', 'home', 'gps'] as const;

type TransportTab = 'wifi' | 'bluetooth' | 'usb' | 'demo';

/** Demande les permissions Bluetooth runtime (Android 12+) ; true si OK. */
async function ensureBtPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 31) return true;
  try {
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    ]);
    return Object.values(results).every(
      (r) => r === PermissionsAndroid.RESULTS.GRANTED,
    );
  } catch (_) {
    return false;
  }
}

export function ConnectScreen() {
  const t = useT();
  const c = usePal();
  const model = useSettingsStore((s) => s.model);
  const setModel = useSettingsStore((s) => s.setModel);
  const lastWifi = useSettingsStore((s) => s.lastWifi);
  const setLastWifi = useSettingsStore((s) => s.setLastWifi);
  const lastBt = useSettingsStore((s) => s.lastBtAddress);
  const setLastBt = useSettingsStore((s) => s.setLastBtAddress);
  const lastUsb = useSettingsStore((s) => s.lastUsbDevice);
  const setLastUsb = useSettingsStore((s) => s.setLastUsbDevice);

  const connStatus = useScopeStore((s) => s.connStatus);
  const transportType = useScopeStore((s) => s.transportType);
  const fwProduct = useScopeStore((s) => s.fwProduct);
  const fwVersion = useScopeStore((s) => s.fwVersion);
  const fwModel = useScopeStore((s) => s.fwModel);
  const [tab, setTab] = useState<TransportTab>('wifi');
  const [host, setHost] = useState(lastWifi.host);
  const [port, setPort] = useState(String(lastWifi.port));
  const [btDevices, setBtDevices] = useState<Array<{name: string; address: string}>>([]);
  const [usbDevices, setUsbDevices] = useState<UsbDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [fwDetecting, setFwDetecting] = useState(false);
  const [err, setErr] = useState('');
  const connected = connStatus === 'connected';
  /** Configuration active : firmware détecté en priorité, choix de l'onglet en secours. */
  const activeModel: ScopeModelId = fwModel ?? model;

  /** Re-lance la détection du firmware sur la liaison courante. */
  const redetect = async () => {
    setFwDetecting(true);
    await autostar.detectFirmware();
    setFwDetecting(false);
  };

  useEffect(() => {
    if (tab === 'bluetooth') refreshBt();
    if (tab === 'usb') refreshUsb();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const refreshBt = async () => {
    if (!(await ensureBtPermissions())) {
      setErr(t.connect.btPermDenied);
      setBtDevices([]);
      return;
    }
    try {
      setBtDevices(await BluetoothSppNative.listBondedDevices());
    } catch (_) {
      // BT éteint, permission absente ou module indisponible : liste vide
      setBtDevices([]);
    }
  };
  const refreshUsb = async () => setUsbDevices(await UsbSerialNative.listDevices());

  const doConnect = async () => {
    if (tab === 'bluetooth' && !lastBt) {
      setErr(t.connect.btPickFirst);
      return;
    }
    if (tab === 'bluetooth' && !(await ensureBtPermissions())) {
      setErr(t.connect.btPermDenied);
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const opts =
        tab === 'wifi' ? {wifi: {host: host.trim(), port: parseInt(port, 10) || 4030}} :
        tab === 'bluetooth' ? {bluetooth: {address: lastBt}} :
        tab === 'usb' ? {usb: {deviceName: lastUsb, baud: 9600}} :
        {demo: {}};
      await autostar.connect(tab, opts, model);
      if (tab === 'wifi') setLastWifi({host: host.trim(), port: parseInt(port, 10) || 4030});
      // firmware : lu en arrière-plan par autostar.detectFirmware() → store
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doDisconnect = async () => {
    setBusy(true);
    await autostar.disconnect();
    setBusy(false);
  };

  const modelKeys: ScopeModelId[] = ['autostar2', 'autostar497', 'autostar495', 'autostar494', 'lx200'];

  return (
    <ScrollView style={{flex: 1, backgroundColor: c.bg}} contentContainerStyle={{padding: 12, paddingBottom: 40}}>
      <StatusHeader />
      <Card style={{marginTop: 8}}>
        <Title text={t.connect.model} />
        <Text style={{color: c.textFaint, fontSize: 11, marginBottom: 6, lineHeight: 15}}>
          {t.connect.modelHint}
        </Text>
        {modelKeys.map((m) => {
          const p = PROFILES[m];
          return (
            <TouchableOpacity key={m} onPress={() => setModel(m)}
              style={{flexDirection: 'row', alignItems: 'center', paddingVertical: 8}}>
              <View style={{
                width: 18, height: 18, borderRadius: 9, borderWidth: 2,
                borderColor: model === m ? c.amber : c.textFaint,
                alignItems: 'center', justifyContent: 'center', marginRight: 10,
              }}>
                {model === m ? <View style={{width: 8, height: 8, borderRadius: 4, backgroundColor: c.amber}} /> : null}
              </View>
              <View style={{flex: 1}}>
                <View style={{flexDirection: 'row', alignItems: 'center'}}>
                  <Text style={{color: c.text, fontSize: 15, fontWeight: '600'}}>{t.models[m]}</Text>
                  {fwModel === m ? (
                    <View style={{
                      marginLeft: 8, borderRadius: 6, borderWidth: 1,
                      backgroundColor: 'rgba(63,214,140,0.12)', borderColor: 'rgba(63,214,140,0.5)',
                      paddingHorizontal: 6, paddingVertical: 1,
                    }}>
                      <Text style={{color: c.green, fontSize: 9, fontWeight: '800', letterSpacing: 0.6}}>
                        {t.connect.fwAutoBadge}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text style={{color: c.textDim, fontSize: 11, marginTop: 1}}>{p.hints}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </Card>

      <Card style={{marginTop: 12}}>
        <Title text={t.connect.transport} />
        <Segmented<TransportTab>
          value={tab}
          onChange={setTab}
          options={[
            {key: 'wifi', label: t.connect.wifi},
            {key: 'bluetooth', label: t.connect.bt},
            {key: 'usb', label: t.connect.usb},
            {key: 'demo', label: t.connect.demo},
          ]}
        />

        {tab === 'wifi' && (
          <View style={{marginTop: 12}}>
            <Text style={{color: c.textDim, fontSize: 12, marginBottom: 10}}>{t.connect.wifiHelp}</Text>
            <Input label={t.connect.host} value={host} onChangeText={setHost}
              keyboardType="numeric" placeholder="192.168.4.1" autoCapitalize="none" />
            <Input label={t.connect.port} value={port} onChangeText={setPort}
              keyboardType="numeric" placeholder="4030" />
            <Text style={{color: c.textFaint, fontSize: 11, marginBottom: 8}}>{t.connect.defaultPort}</Text>
          </View>
        )}

        {tab === 'bluetooth' && (
          <View style={{marginTop: 12}}>
            <Text style={{color: c.textDim, fontSize: 12, marginBottom: 10}}>{t.connect.btHelp}</Text>
            <Btn label={t.connect.btScan} onPress={refreshBt} variant="ghost" />
            {btDevices.length === 0 ? (
              <Text style={{color: c.textFaint, fontSize: 13, marginTop: 8}}>{t.connect.btNone}</Text>
            ) : (
              btDevices.map((d) => (
                <TouchableOpacity key={d.address} onPress={() => setLastBt(d.address)}
                  style={{
                    flexDirection: 'row', justifyContent: 'space-between', padding: 10, marginTop: 8,
                    borderRadius: 10, borderWidth: 1,
                    backgroundColor: lastBt === d.address ? c.btnActive : c.bgPanel2,
                    borderColor: lastBt === d.address ? c.amber : c.border,
                  }}>
                  <Text style={{color: c.text}}>{d.name}</Text>
                  <Text style={{color: c.textDim, fontFamily: 'monospace', fontSize: 12}}>{d.address}</Text>
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        {tab === 'usb' && (
          <View style={{marginTop: 12}}>
            <Text style={{color: c.textDim, fontSize: 12, marginBottom: 10}}>{t.connect.usbHelp}</Text>
            <Btn label={t.connect.usbList} onPress={refreshUsb} variant="ghost" />
            {usbDevices.length === 0 ? (
              <Text style={{color: c.textFaint, fontSize: 13, marginTop: 8}}>{t.connect.usbNone}</Text>
            ) : (
              usbDevices.map((d) => (
                <TouchableOpacity key={d.deviceName} onPress={async () => {
                  const ok = await UsbSerialNative.requestPermission(d.deviceName);
                  setErr(ok ? '' : t.connect.usbPerm);
                  setLastUsb(d.deviceName);
                }}
                  style={{
                    padding: 10, marginTop: 8, borderRadius: 10, borderWidth: 1,
                    backgroundColor: lastUsb === d.deviceName ? c.btnActive : c.bgPanel2,
                    borderColor: lastUsb === d.deviceName ? c.amber : c.border,
                  }}>
                  <Text style={{color: c.text}}>{d.deviceName} — {d.brand} ({d.driver})</Text>
                  <Text style={{color: c.textDim, fontSize: 11, fontFamily: 'monospace'}}>
                    VID:PID {d.vendorHex}:{d.productHex}
                  </Text>
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        {tab === 'demo' && (
          <Text style={{color: c.textDim, fontSize: 12, marginTop: 12}}>{t.connect.demoHelp}</Text>
        )}

        <View style={{flexDirection: 'row', marginTop: 14}}>
          {!connected ? (
            <Btn label={busy ? t.connect.handshake : t.connect.connect} onPress={doConnect} disabled={busy}
              variant="primary" style={{flex: 1}} />
          ) : (
            <Btn label={t.connect.disconnect} onPress={doDisconnect} disabled={busy || transportType === null}
              variant="danger" style={{flex: 1}} />
          )}
        </View>
        {err ? <Text style={{color: c.red, marginTop: 8}}>{t.common.error} : {err}</Text> : null}
      </Card>

      {/* Micrologiciel détecté via la liaison → configuration optimale appliquée */}
      {connected ? (
        <Card style={{marginTop: 12}}>
          <Title text={t.connect.fwTitle} />
          {fwProduct ? (
            <View>
              <Text style={{color: c.text, fontSize: 15, fontWeight: '700', fontFamily: 'monospace'}}>
                {fwProduct.trim()} — v{fwVersion ?? '?'}
              </Text>
              <Text style={{color: fwModel ? c.green : c.textDim, fontSize: 12, marginTop: 5, lineHeight: 17}}>
                {fwModel
                  ? t.connect.fwOptimal.replace('{0}', t.models[fwModel])
                  : t.connect.fwFallback.replace('{0}', t.models[model])}
              </Text>
              <Text style={{
                color: c.textFaint, fontSize: 10, marginTop: 12, marginBottom: 4,
                textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: '700',
              }}>
                {t.connect.fwConfig} : {FW_SHORT[activeModel]}
              </Text>
              <View style={{flexDirection: 'row', flexWrap: 'wrap'}}>
                {CAP_KEYS.filter((k) => PROFILES[activeModel].supports[k]).map((k) => (
                  <View key={k} style={{
                    borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.bgPanel2,
                    paddingHorizontal: 8, paddingVertical: 3, marginRight: 6, marginBottom: 6,
                  }}>
                    <Text style={{color: c.textDim, fontSize: 10.5, fontWeight: '600'}}>{t.connect.caps[k]}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : (
            <Text style={{color: c.textDim, fontSize: 12, lineHeight: 17}}>{t.connect.fwNotRead}</Text>
          )}
          <Btn label={fwDetecting ? t.connect.fwDetecting : t.connect.fwRedetect}
            onPress={redetect} disabled={fwDetecting} variant="ghost" style={{marginTop: 10}} />
        </Card>
      ) : null}
    </ScrollView>
  );
}
