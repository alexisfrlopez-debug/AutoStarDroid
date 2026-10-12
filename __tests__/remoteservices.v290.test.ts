/**
 * v2.9.0 — Onglet Services distants : catalogue des plateformes, script de
 * connexion automatique (chaîne injectée WebView), store des comptes/session.
 * Modules 100 % purs — aucune dépendance native (règle Hermes bridge).
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {
  REMOTE_SERVICES, CATEGORY_ORDER, findService,
} from '../src/services/remote/servicesCatalog';
import {
  buildAutoLoginScript, AUTO_LOGIN_MAX_TRIES, AUTO_LOGIN_RETRY_MS,
} from '../src/services/remote/autoLogin';
import {useServicesStore} from '../src/store/servicesStore';

const CATS = ['live', 'public', 'pro'];

describe('catalogue services distants v2.9.0', () => {
  it('propose au moins 8 services répartis sur les 3 familles', () => {
    expect(REMOTE_SERVICES.length).toBeGreaterThanOrEqual(8);
    for (const cat of CATS) {
      expect(REMOTE_SERVICES.some((x) => x.category === cat)).toBe(true);
    }
    expect(CATEGORY_ORDER).toEqual(CATS);
  });

  it('identifiants uniques et URLs https partout', () => {
    const ids = REMOTE_SERVICES.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of REMOTE_SERVICES) {
      const urls = [s.site, s.loginUrl, ...s.quickLinks.map((q) => q.url)];
      for (const u of urls) {
        expect(u.startsWith('https://')).toBe(true);
      }
    }
  });

  it('contenu bilingue complet (résumé + fonctionnalités) pour chaque service', () => {
    for (const s of REMOTE_SERVICES) {
      expect(s.summaryFr.length).toBeGreaterThan(80);
      expect(s.summaryEn.length).toBeGreaterThan(80);
      expect(s.featuresFr.length).toBeGreaterThanOrEqual(4);
      expect(s.featuresEn.length).toBe(s.featuresFr.length);
      expect(s.featuresFr.every((f) => f.length > 10)).toBe(true);
      expect(s.featuresEn.every((f) => f.length > 10)).toBe(true);
      expect(s.operator.length).toBeGreaterThan(3);
      expect(s.quickLinks.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('les familles correspondent à la demande (VTP/Slooh live, Telescope.org/MicroObservatory publics, iTelescope/Skynet pro)', () => {
    const vtp = findService('vtp')!;
    expect(vtp.category).toBe('live');
    expect(vtp.free).toBe(true);
    expect(vtp.realtime).toBe(true);
    expect(vtp.video).toBe('live');
    expect(vtp.needsAccount).toBe(false);

    const slooh = findService('slooh')!;
    expect(slooh.category).toBe('live');
    expect(slooh.free).toBe(false);
    expect(slooh.video).toBe('live');

    const micro = findService('microobservatory')!;
    expect(micro.category).toBe('public');
    expect(micro.free).toBe(true);
    expect(micro.realtime).toBe(false);
    expect(micro.video).toBe('images');

    const itel = findService('itelescope')!;
    expect(itel.category).toBe('pro');
    expect(itel.free).toBe(false);
    expect(itel.realtime).toBe(true);

    const skynet = findService('skynet')!;
    expect(skynet.category).toBe('pro');
    expect(skynet.free).toBe(true);
  });

  it('findService : null sûr', () => {
    expect(findService(null)).toBeNull();
    expect(findService('inconnu')).toBeNull();
  });
});

describe('connexion automatique v2.9.0 (script injecté WebView)', () => {
  it('produit une CHAÎNE JS — aucune fonction transmise au natif (règle Hermes)', () => {
    const s = buildAutoLoginScript('user@test.io', 'p@ss', true);
    expect(typeof s).toBe('string');
  });

  it('échappe les identifiants (guillemets, backslash, retour ligne)', () => {
    const user = 'u"q\\z\nx';
    const pass = 'p\'q"r\\s\nt';
    const s = buildAutoLoginScript(user, pass, true);
    expect(s).toContain(JSON.stringify(user));
    expect(s).toContain(JSON.stringify(pass));
    expect(s.trim().endsWith('})();')).toBe(true);
  });

  it('cherche identifiant + mot de passe et émet input/change (compat React)', () => {
    const s = buildAutoLoginScript('u', 'p', false);
    expect(s).toContain('input[type=password]');
    expect(s).toContain('input[type=email]');
    expect(s).toContain("new Event('input'");
    expect(s).toContain("new Event('change'");
  });

  it('soumet le formulaire seulement si autoSubmit', () => {
    const withSubmit = buildAutoLoginScript('u', 'p', true);
    expect(withSubmit).toContain('.click()');
    expect(withSubmit).toContain("closest('form')");
    expect(buildAutoLoginScript('u', 'p', false)).not.toContain('.click()');
  });

  it('recherche répétée bornée (formulaires lents)', () => {
    const s = buildAutoLoginScript('u', 'p', false);
    expect(s).toContain(`tries < ${AUTO_LOGIN_MAX_TRIES}`);
    expect(AUTO_LOGIN_RETRY_MS).toBeGreaterThanOrEqual(200);
  });
});

describe('store services v2.9.0', () => {
  beforeEach(() => {
    const st = useServicesStore.getState();
    st.closeSession();
    for (const id of Object.keys(st.creds)) st.clearCreds(id);
  });

  it("identifiants par service : enregistrement puis oubli", () => {
    const st = useServicesStore.getState();
    st.setCreds('slooh', {login: 'astro', password: 'secret', autoLogin: true});
    expect(useServicesStore.getState().creds.slooh).toEqual({
      login: 'astro', password: 'secret', autoLogin: true,
    });
    useServicesStore.getState().clearCreds('slooh');
    expect(useServicesStore.getState().creds.slooh).toBeUndefined();
  });

  it("session : ouverture, changement d'URL, fermeture", () => {
    const st = useServicesStore.getState();
    st.openSession('vtp', 'https://www.virtualtelescope.eu/wp-login.php', 'login');
    let sess = useServicesStore.getState().session!;
    expect(sess.serviceId).toBe('vtp');
    expect(sess.phase).toBe('login');
    expect(useServicesStore.getState().lastServiceId).toBe('vtp');
    useServicesStore.getState().setSessionUrl('https://www.virtualtelescope.eu/webtv/', 'session');
    sess = useServicesStore.getState().session!;
    expect(sess.url).toContain('webtv');
    expect(sess.phase).toBe('session');
    useServicesStore.getState().closeSession();
    expect(useServicesStore.getState().session).toBeNull();
  });

  it('setSessionUrl sans session : sans effet', () => {
    useServicesStore.getState().setSessionUrl('https://exemple.org');
    expect(useServicesStore.getState().session).toBeNull();
  });

  it('sélection du dernier service mémorisée', () => {
    useServicesStore.getState().selectService('skynet');
    expect(useServicesStore.getState().lastServiceId).toBe('skynet');
  });
});
