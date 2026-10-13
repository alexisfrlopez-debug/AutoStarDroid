/** Écran Réglages : données raquette, sync téléphone→raquette, site, langue, vision nocturne. */
import {useState} from 'react';
import {ScrollView, Text, View, Alert} from 'react-native';
import {useT} from '../i18n';
import {useSettingsStore, SiteInfo} from '../store/settingsStore';
import {useScopeStore} from '../store/scopeStore';
import {autostar} from '../services/protocol/client';
import {getPhonePosition, GpsError} from '../services/phone/gps';
import {setDemoSite} from '../services/connection/demo';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, Card, Input, Title, Toggle, usePal} from '../components/ui';

export function SetupScreen() {
  const t = useT();
  const c = usePal();
  const site = useSettingsStore((s) => s.site);
  const setSite = useSettingsStore((s) => s.setSite);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const nightVision = useSettingsStore((s) => s.nightVision);
  const setNightVision = useSettingsStore((s) => s.setNightVision);
  const keySounds = useSettingsStore((s) => s.keySounds);
  const setKeySounds = useSettingsStore((s) => s.setKeySounds);
  const autoSyncScope = useSettingsStore((s) => s.autoSyncScope);
  const setAutoSyncScope = useSettingsStore((s) => s.setAutoSyncScope);
  const connStatus = useScopeStore((s) => s.connStatus);
  const scopeTime = useScopeStore((s) => s.scopeTime);
  const scopeDate = useScopeStore((s) => s.scopeDate);
  const setScopeTime = useScopeStore((s) => s.setScopeTime);
  const setScopeDate = useScopeStore((s) => s.setScopeDate);
  const [scopeInfo, setScopeInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [latTxt, setLatTxt] = useState(String(site.latDeg.toFixed(4)));
  const [lonTxt, setLonTxt] = useState(String(site.lonDeg.toFixed(4)));
  const [nameTxt, setNameTxt] = useState(site.name);

  const connected = connStatus === 'connected';

  const readFromScope = async () => {
    setBusy(true);
    setScopeInfo(t.setup.scopeRead);
    try {
      const d = await autostar.readScopeData();
      // L'horloge raquette (affichée en haut de l'écran) est mise à jour ici
      setScopeTime(d.time);
      setScopeDate(d.date);
      setScopeInfo(
        `${t.setup.date} : ${d.date}   ${t.setup.time} : ${d.time}   ${t.setup.tz} : ${d.tz}\n` +
        `${t.setup.lat} : ${d.latDeg?.toFixed(3) ?? '—'}   ${t.setup.lon} : ${d.lonDeg?.toFixed(3) ?? '—'}`,
      );
    } catch (e) {
      setScopeInfo(`${t.common.error} : ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const getGps = async () => {
    setBusy(true);
    try {
      const p = await getPhonePosition();
      const s: SiteInfo = {name: nameTxt || 'GPS', latDeg: p.latDeg, lonDeg: p.lonDeg, elevM: p.elevM};
      setSite(s);
      setLatTxt(p.latDeg.toFixed(4));
      setLonTxt(p.lonDeg.toFixed(4));
      setDemoSite(p.latDeg, p.lonDeg);
    } catch (e) {
      // chaque cause a SON message (v2.1.2) : permission / services OFF / délai
      const code = e instanceof GpsError ? e.code : 'unavailable';
      Alert.alert(t.common.error, t.setup[`gps${code.charAt(0).toUpperCase()}${code.slice(1)}` as 'gpsPerm' | 'gpsOff' | 'gpsTimeout' | 'gpsUnavailable'] ?? String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const syncPhone = async () => {
    const lat = parseFloat(latTxt.replace(',', '.'));
    const lon = parseFloat(lonTxt.replace(',', '.'));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      Alert.alert(t.common.error, `${t.setup.lat} / ${t.setup.lon} ?`);
      return;
    }
    setBusy(true);
    try {
      setSite({name: nameTxt || site.name, latDeg: lat, lonDeg: lon, elevM: site.elevM});
      setDemoSite(lat, lon);
      await autostar.pushPhoneData(lat, lon);
      Alert.alert(t.common.success, t.setup.synced);
    } catch (e) {
      Alert.alert(t.common.error, (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{flex: 1, backgroundColor: c.bg}} contentContainerStyle={{padding: 12, paddingBottom: 40}}>
      <StatusHeader />

      <Card style={{marginTop: 8}}>
        <Title text={t.setup.scopeData} />
        <Text style={{color: c.text, fontFamily: 'monospace', fontSize: 14}}>
          {t.setup.time} : {scopeTime}   {t.setup.date} : {scopeDate}
        </Text>
        {scopeInfo ? <Text style={{color: c.textDim, fontFamily: 'monospace', fontSize: 12, marginTop: 6}}>{scopeInfo}</Text> : null}
        <Btn label={t.setup.readFromScope} onPress={readFromScope} disabled={!connected || busy}
          variant="ghost" style={{marginTop: 10}} />
      </Card>

      <Card style={{marginTop: 12}}>
        <Title text={t.setup.phoneData} />
        <Input label={t.setup.siteName} value={nameTxt} onChangeText={setNameTxt} placeholder="Ex : Balcon du Puy" />
        <Input label={`${t.setup.lat} (+N / -S)`} value={latTxt} onChangeText={setLatTxt} keyboardType="numbers-and-punctuation" />
        <Input label={`${t.setup.lon} (+E / -W)`} value={lonTxt} onChangeText={setLonTxt} keyboardType="numbers-and-punctuation" />
        <View style={{flexDirection: 'row'}}>
          <Btn label={t.setup.gps} onPress={getGps} disabled={busy} style={{flex: 1, marginRight: 6}} />
          <Btn label={t.setup.syncPhone} onPress={syncPhone} disabled={!connected || busy}
            variant="primary" style={{flex: 1.6, marginLeft: 6}} />
        </View>
        <View style={{marginTop: 10}}>
          <Toggle label={t.setup.autoSync} value={autoSyncScope} onChange={setAutoSyncScope} />
          <Text style={{color: c.textFaint, fontSize: 11, marginTop: 2}}>{t.setup.autoSyncDesc}</Text>
        </View>
      </Card>

      <Card style={{marginTop: 12}}>
        <Title text={t.appName} />
        <Toggle label={t.setup.night} value={nightVision} onChange={setNightVision} />
        <Toggle label={t.setup.sounds} value={keySounds} onChange={setKeySounds} />
        <View style={{marginTop: 8}}>
          <Toggle label="English" value={language === 'en'} onChange={(v) => setLanguage(v ? 'en' : 'fr')} />
        </View>
        <Text style={{color: c.textFaint, fontSize: 12, marginTop: 4}}>
          {language === 'en' ? 'Switch to French / English' : 'Passer en français / anglais'}
        </Text>
      </Card>

      <Card style={{marginTop: 12}}>
        <Title text={t.setup.about} />
        <Text style={{color: c.textDim, fontSize: 13, lineHeight: 19}}>
          AutoStar Droid v2.9.5 — émulation complète de la raquette Meade Autostar II
          et des Autostar #49x, liaisons Wi-Fi, Bluetooth SPP, USB-série (câble Meade
          #505/#507, FTDI, PL2303, CP210x, CH340), GOTO avec catalogues
          Messier/NGC/étoiles/planètes, carte du ciel interactive (vue chercheur,
          noms cliquables GOTO/Sync, montage du téléphone sur le tube),
          caméra astronomique UVC USB-host + interne avec réglages manuels,
          sélecteurs de résolution/framerate/cadence et filtres de lumière
          (trame noire, flat, pixels chauds, anti-pollution) sur les acquisitions,
          autoguidage par l'image et acquisition automatique, onglet Montures
          (catalogue multi-marques Meade/Celestron/Sky-Watcher/iOptron et plus,
          saisie manuelle), contrôle croisé GOTO télémétrie/moteurs,
          alignement télémétrique (gyroscope/boussole), diagnostic moteur complet
          adapté à la monture, mise à jour automatique de la raquette (date, heure,
          site) à la connexion et reconnexion automatique USB/Bluetooth.
        </Text>
      </Card>
    </ScrollView>
  );
}
