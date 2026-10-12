/**
 * ÉCRAN SERVICES DISTANTS (v2.9.0, session PLEIN ÉCRAN v2.9.2) :
 *  - MENU DÉROULANT des services regroupés par famille (expérience en direct,
 *    observatoires publics gratuits, réseaux professionnels/éducatifs) ;
 *  - ENCADRÉ RÉCAPITULATIF du service choisi : opérateur, accès, mode,
 *    vidéo, présentation, fonctionnalités, site ;
 *  - COMPTE : identifiants mémorisés par service + connexion automatique
 *    (remplissage du formulaire via script injecté — chaîne pure, règle
 *    Hermes bridge). v2.9.2 : l'option « Créer un compte » disparaît —
 *    l'inscription se fait sur le site du service, l'app garde la gestion
 *    des identifiants ;
 *  - SESSION (v2.9.2) : PLEIN ÉCRAN — la WebView occupe tout l'écran sous
 *    la barre de raccourcis, donc elle défile NATIVEMENT (la v2.9.0 l' UM
 *    emboîtait à hauteur fixe dans la ScrollView de l'écran : sur Android
 *    la page web ne défilait PAS dans son encadré). Vidéo, pilotage et
 *    files d'attente du service dans l'onglet, rechargement, déconnexion.
 */
import {useState} from 'react';
import {View, Text, ScrollView, TouchableOpacity} from 'react-native';
import {WebView} from 'react-native-webview';
import {useT, useI18n} from '../i18n';
import {useServicesStore, type RemoteSession} from '../store/servicesStore';
import {
  REMOTE_SERVICES, CATEGORY_ORDER, findService,
  type RemoteCategory, type RemoteService,
} from '../services/remote/servicesCatalog';
import {buildAutoLoginScript} from '../services/remote/autoLogin';
import {Dropdown, type DropdownOption} from '../components/Dropdown';
import {StatusHeader} from '../components/StatusHeader';
import {Btn, Card, Input, Title, Toggle, usePal} from '../components/ui';

/** Étiquette i18n d'une famille de services. */
function catLabel(t: ReturnType<typeof useT>, cat: RemoteCategory): string {
  switch (cat) {
    case 'live': return t.sv.catLive;
    case 'public': return t.sv.catPublic;
    default: return t.sv.catPro;
  }
}

function Badge({text, accent, c}: {text: string; accent: string; c: ReturnType<typeof usePal>}) {
  return (
    <View style={{
      backgroundColor: c.bgPanel2, borderRadius: 8, borderWidth: 1, borderColor: c.border,
      paddingHorizontal: 8, paddingVertical: 3, marginRight: 6, marginTop: 6,
    }}>
      <Text style={{color: accent, fontSize: 11, fontWeight: '700'}}>{text}</Text>
    </View>
  );
}

function InfoBox({svc, t, c, lang}: {svc: RemoteService; t: ReturnType<typeof useT>; c: ReturnType<typeof usePal>; lang: string}) {
  const features = lang === 'en' ? svc.featuresEn : svc.featuresFr;
  const summary = lang === 'en' ? svc.summaryEn : svc.summaryFr;
  return (
    <View style={{
      borderRadius: 12, borderWidth: 1, borderColor: c.amberDim, backgroundColor: c.bgPanel2,
      padding: 12, marginTop: 10,
    }}>
      <Text style={{color: c.text, fontSize: 16, fontWeight: '700'}}>{svc.name}</Text>
      <Text style={{color: c.textDim, fontSize: 12, marginTop: 2}}>
        {t.sv.operator} {svc.operator}
      </Text>
      <View style={{flexDirection: 'row', flexWrap: 'wrap'}}>
        <Badge text={svc.free ? t.sv.badgeFree : t.sv.badgePaid} accent={svc.free ? c.green : c.orange} c={c} />
        <Badge text={svc.realtime ? t.sv.badgeRealtime : t.sv.badgeQueue} accent={svc.realtime ? c.blue : c.textDim} c={c} />
        {svc.video === 'live' ? (
          <Badge text={t.sv.badgeVideoLive} accent={c.red} c={c} />
        ) : svc.video === 'images' ? (
          <Badge text={t.sv.badgeVideoImages} accent={c.blue} c={c} />
        ) : null}
      </View>
      <Text style={{color: c.textDim, fontSize: 12, fontWeight: '700', marginTop: 10, marginBottom: 3}}>
        {t.sv.summary}
      </Text>
      <Text style={{color: c.text, fontSize: 13, lineHeight: 19}}>{summary}</Text>
      <Text style={{color: c.textDim, fontSize: 12, fontWeight: '700', marginTop: 10, marginBottom: 3}}>
        {t.sv.features}
      </Text>
      {features.map((f, i) => (
        <View key={i} style={{flexDirection: 'row', marginBottom: 4, paddingRight: 4}}>
          <Text style={{color: c.amber, fontSize: 13, marginRight: 7}}>•</Text>
          <Text style={{color: c.text, fontSize: 13, lineHeight: 18, flex: 1}}>{f}</Text>
        </View>
      ))}
      <Text style={{color: c.textFaint, fontSize: 11, marginTop: 8}}>{svc.site}</Text>
    </View>
  );
}

/** SESSION PLEIN ÉCRAN (v2.9.2) — la WebView N'EST PAS dans une ScrollView :
 *  elle remplit l'écran (flex: 1) et défile nativement, le conflit de
 *  gestes Android WebView/ScrollView disparaît. */
function SessionScreen({session, svc, t, c}: {session: RemoteSession; svc: RemoteService; t: ReturnType<typeof useT>; c: ReturnType<typeof usePal>}) {
  const creds = useServicesStore((st) => st.creds);
  const setSessionUrl = useServicesStore((st) => st.setSessionUrl);
  const closeSession = useServicesStore((st) => st.closeSession);
  const [reloadKey, setReloadKey] = useState(0);
  const [currentUrl, setCurrentUrl] = useState(session.url);
  const cred = creds[session.serviceId];
  const injected =
    session.phase === 'login' && cred?.autoLogin && cred.login && cred.password
      ? buildAutoLoginScript(cred.login, cred.password, true)
      : undefined;
  return (
    <View style={{flex: 1, backgroundColor: c.bg}}>
      <View style={{paddingHorizontal: 14, paddingTop: 6}}>
        <View style={{flexDirection: 'row', alignItems: 'center'}}>
          <View style={{flex: 1}}>
            <Text style={{color: c.text, fontSize: 15, fontWeight: '700'}} numberOfLines={1}>
              {svc.name}
            </Text>
            <Text style={{color: c.textDim, fontSize: 11}}>
              {t.sv.session} · {session.phase === 'login' ? t.sv.phaseLogin : t.sv.active}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setReloadKey((k) => k + 1)}
            style={{
              backgroundColor: c.btnBg, borderRadius: 8, borderWidth: 1, borderColor: c.border,
              paddingHorizontal: 12, paddingVertical: 7, marginRight: 8,
            }}>
            <Text style={{color: c.text, fontSize: 12, fontWeight: '600'}}>{t.sv.reload}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={closeSession}
            style={{
              backgroundColor: c.bgPanel2, borderRadius: 8, borderWidth: 1, borderColor: c.red,
              paddingHorizontal: 12, paddingVertical: 7,
            }}>
            <Text style={{color: c.red, fontSize: 12, fontWeight: '700'}}>{t.sv.logout}</Text>
          </TouchableOpacity>
        </View>
        {svc.quickLinks.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginTop: 8}}>
            {svc.quickLinks.map((q) => (
              <TouchableOpacity
                key={q.label}
                onPress={() => { setCurrentUrl(q.url); setSessionUrl(q.url, 'session'); setReloadKey((k) => k + 1); }}
                style={{
                  backgroundColor: c.btnBg, borderRadius: 8, borderWidth: 1, borderColor: c.border,
                  paddingHorizontal: 10, paddingVertical: 6, marginRight: 6, marginBottom: 4,
                }}>
                <Text style={{color: c.blue, fontSize: 12, fontWeight: '600'}}>{q.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}
      </View>
      <View style={{flex: 1, margin: 14, marginTop: 8, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: c.border}}>
        <WebView
          key={`${session.serviceId}-${currentUrl}-${reloadKey}`}
          source={{uri: currentUrl}}
          style={{flex: 1, backgroundColor: c.bg}}
          javaScriptEnabled
          domStorageEnabled
          mediaPlaybackRequiresUserAction={false}
          setSupportMultipleWindows={false}
          injectedJavaScript={injected}
          onNavigationStateChange={(nav) => {
            if (nav.url && nav.url !== currentUrl) {
              setCurrentUrl(nav.url);
              setSessionUrl(nav.url);
            }
          }}
        />
      </View>
      <View style={{paddingHorizontal: 14, paddingBottom: 8}}>
        <Text style={{color: c.textFaint, fontSize: 11}} numberOfLines={1}>{currentUrl}</Text>
        {injected ? (
          <Text style={{color: c.textDim, fontSize: 11, marginTop: 2}}>{t.sv.credsFilled}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function ServicesScreen() {
  const t = useT();
  const c = usePal();
  const lang = useI18n((st) => st.lang);
  const sv = t.sv;

  const creds = useServicesStore((st) => st.creds);
  const session = useServicesStore((st) => st.session);
  const lastServiceId = useServicesStore((st) => st.lastServiceId);
  const setCreds = useServicesStore((st) => st.setCreds);
  const clearCreds = useServicesStore((st) => st.clearCreds);
  const openSession = useServicesStore((st) => st.openSession);
  const selectService = useServicesStore((st) => st.selectService);

  const [selectedId, setSelectedId] = useState<string | null>(lastServiceId);
  const svc = findService(selectedId);
  const cred = selectedId ? creds[selectedId] ?? null : null;
  const [login, setLogin] = useState(cred?.login ?? '');
  const [pass, setPass] = useState(cred?.password ?? '');
  const [auto, setAuto] = useState(cred?.autoLogin ?? true);
  const [saved, setSaved] = useState(false);
  const [cleared, setCleared] = useState(false);

  // SESSION PLEIN ÉCRAN (v2.9.2) : quand une session est ouverte, elle
  // REMPLIT l'onglet — la WebView défile nativement.
  const sessionSvc = session ? findService(session.serviceId) : null;
  if (session && sessionSvc) {
    return <SessionScreen session={session} svc={sessionSvc} t={t} c={c} />;
  }

  const options: DropdownOption[] = [];
  for (const cat of CATEGORY_ORDER) {
    for (const s2 of REMOTE_SERVICES.filter((x) => x.category === cat)) {
      options.push({key: s2.id, label: s2.name, hint: catLabel(t, cat)});
    }
  }

  const onPick = (key: string) => {
    setSelectedId(key);
    selectService(key);
    const cr = creds[key];
    setLogin(cr?.login ?? '');
    setPass(cr?.password ?? '');
    setAuto(cr?.autoLogin ?? true);
    setSaved(false);
    setCleared(false);
  };

  const saveCred = () => {
    if (!selectedId) return;
    setCreds(selectedId, {login: login.trim(), password: pass, autoLogin: auto});
    setSaved(true);
    setCleared(false);
  };

  return (
    <View style={{flex: 1, backgroundColor: c.bg}}>
      <StatusHeader />
      <ScrollView contentContainerStyle={{padding: 14, paddingBottom: 40}}>
        <Card>
          <Title text={sv.title} />
          <Text style={{color: c.textDim, fontSize: 12, marginBottom: 4}}>{sv.subtitle}</Text>
          <Dropdown
            label={sv.service}
            value={selectedId}
            options={options}
            onChange={onPick}
            placeholder={sv.pickService}
          />
          {svc ? (
            <InfoBox svc={svc} t={t} c={c} lang={lang} />
          ) : (
            <Text style={{color: c.textFaint, fontSize: 13, marginTop: 10, lineHeight: 19}}>
              {sv.pickHint}
            </Text>
          )}
        </Card>

        {svc ? (
          <Card>
            <Title text={sv.account} />
            {!svc.needsAccount ? (
              <Text style={{color: c.green, fontSize: 12, marginBottom: 8}}>{sv.noAccountNeeded}</Text>
            ) : null}
            <Input
              label={sv.login}
              value={login}
              onChangeText={setLogin}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
            <Input
              label={sv.password}
              value={pass}
              onChangeText={setPass}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Toggle value={auto} onChange={setAuto} label={sv.autoLogin} />
            <Btn label={sv.save} onPress={saveCred} variant="primary" style={{marginTop: 8}} />
            {saved ? <Text style={{color: c.green, fontSize: 12, marginTop: 8}}>{sv.saved}</Text> : null}
            {cred ? (
              <TouchableOpacity onPress={() => { clearCreds(svc.id); setLogin(''); setPass(''); setCleared(true); setSaved(false); }} style={{marginTop: 10}}>
                <Text style={{color: c.red, fontSize: 12}}>{sv.forget}</Text>
              </TouchableOpacity>
            ) : null}
            {cleared ? <Text style={{color: c.textDim, fontSize: 12, marginTop: 6}}>{sv.forgot}</Text> : null}
            <Text style={{color: c.textFaint, fontSize: 11, marginTop: 10, lineHeight: 16}}>{sv.storageNote}</Text>
          </Card>
        ) : null}

        {svc ? (
          <Card>
            <Title text={sv.session} />
            <Text style={{color: c.textDim, fontSize: 12, marginBottom: 10, lineHeight: 18}}>{sv.sessionHint}</Text>
            <Btn label={sv.connect} onPress={() => openSession(svc.id, svc.loginUrl, 'login')} variant="primary" />
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}
