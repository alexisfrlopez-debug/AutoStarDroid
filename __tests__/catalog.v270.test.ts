/**
 * Tests v2.7.0 — CATALOGUE MONTURES & TÉLESCOPES (onglet « Montures ») :
 *  - intégrité du catalogue (ids uniques, presets/protocoles valides) ;
 *  - listes fournies pour CHAQUE marque (pas seulement Meade) ;
 *  - menus en cascade (marque → modèles) ;
 *  - résolution de configuration (catalogue, génériques, repli v2.6.0) ;
 *  - saisie manuelle (caractéristiques libres, butées surchargées).
 */
import {
  BRANDS, GENERIC_MODELS, findBrand, findModel, resolveMountConfig, activePreset,
  BRAND_OTHER, MODEL_NOT_LISTED,
} from '../src/services/mounts/catalog';
import {MOUNT_PRESETS} from '../src/services/astro/mounts';

const allModels = BRANDS.flatMap((b) => b.models).concat(GENERIC_MODELS);

describe('catalogue — intégrité', () => {
  it('ids de modèles uniques', () => {
    const ids = allModels.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('chaque modèle référence un preset mécanique EXISTANT', () => {
    for (const m of allModels) {
      expect(MOUNT_PRESETS[m.preset]).toBeDefined();
    }
  });

  it('chaque modèle référence une interface de raquette valide', () => {
    const valid = ['autostar2', 'autostar497', 'autostar495', 'autostar494', 'lx200'];
    for (const m of allModels) {
      expect(valid).toContain(m.interfaceId);
    }
  });

  it('les modèles sans moteurs ne sont jamais connectables', () => {
    for (const m of allModels) {
      if (!m.goto) {
        // soit pas de protocole, soit informationnel affiché — mais jamais
        // un preset « spécial » trompeur : generic/lx200 autorisés
        expect(m.protocol === null || m.preset === 'generic' || m.preset === 'lx200').toBe(true);
      }
    }
  });
});

describe('catalogue — listes fournies pour chaque marque', () => {
  it('Meade reste la plus riche (>= 30 modèles)', () => {
    const meade = findBrand('meade');
    expect(meade).not.toBeNull();
    expect(meade!.models.length).toBeGreaterThanOrEqual(30);
    // DS-114 présent (retour terrain v2.2.1)
    expect(meade!.models.some((m) => m.id === 'meade-ds114')).toBe(true);
  });

  it('Celestron, Sky-Watcher et iOptron sont aussi fournis (>= 15 chacun)', () => {
    expect(findBrand('celestron')!.models.length).toBeGreaterThanOrEqual(15);
    expect(findBrand('skywatcher')!.models.length).toBeGreaterThanOrEqual(15);
    expect(findBrand('ioptron')!.models.length).toBeGreaterThanOrEqual(15);
  });

  it('au moins 10 marques au catalogue, dont Orion/Losmandy/10Micron/AP/ZWO', () => {
    expect(BRANDS.length).toBeGreaterThanOrEqual(10);
    for (const id of ['orion', 'losmandy', 'tenmicron', 'astrophysics', 'zwo']) {
      expect(findBrand(id)).not.toBeNull();
    }
  });

  it('DS-114 et ETX-90 mappent la raquette #494/#497', () => {
    expect(findModel('meade', 'meade-ds114')!.interfaceId).toBe('autostar494');
    expect(findModel('meade', 'meade-etx90')!.interfaceId).toBe('autostar497');
  });

  it('NexStar 8SE → protocole celestron ; HEQ5 Pro → skywatcher ; CEM70 → ioptron', () => {
    expect(findModel('celestron', 'celestron-nexstar8se')!.protocol).toBe('celestron');
    expect(findModel('skywatcher', 'skywatcher-heq5-pro')!.protocol).toBe('skywatcher');
    expect(findModel('ioptron', 'ioptron-cem70')!.protocol).toBe('ioptron');
  });
});

describe('menus en cascade', () => {
  it('marque inconnue → null ; modèle hors marque → null', () => {
    expect(findBrand('nonexiste')).toBeNull();
    expect(findModel('meade', 'celestron-nexstar8se')).toBeNull();
  });

  it('modèle générique (sans marque) trouvable via other', () => {
    const g = findModel(BRAND_OTHER, 'other-gen-nexstar');
    expect(g).not.toBeNull();
    expect(g!.protocol).toBe('celestron');
  });

  it('chaque marque expose ses modèles avec un id préfixé par la marque', () => {
    for (const b of BRANDS) {
      for (const m of b.models) {
        expect(m.id.startsWith(`${b.id}-`)).toBe(true);
      }
    }
  });
});

describe('resolveMountConfig — sélection catalogue', () => {
  it('sélection catalogue → protocole + interface + preset du modèle', () => {
    const cfg = resolveMountConfig('celestron', 'celestron-nexstar8se', null);
    expect(cfg.brandLabel).toBe('Celestron');
    expect(cfg.modelLabel).toBe('NexStar 8SE');
    expect(cfg.driverPref).toBe('celestron');
    expect(cfg.interfaceId).toBe('autostar2');
    expect(cfg.preset).toBe('lx90');
    expect(cfg.custom).toBeNull();
  });

  it('rien de sélectionné → repli v2.6.0 (auto + générique)', () => {
    const cfg = resolveMountConfig(null, null, null);
    expect(cfg.driverPref).toBe('auto');
    expect(cfg.brandLabel).toBe('—');
    expect(cfg.modelLabel).toBe('—');
  });

  it('saisie manuelle active → caractéristiques saisies', () => {
    const custom = {
      label: 'Ma monture', protocol: 'skywatcher' as const, altaz: false,
      minAltDeg: 10, maxAltDeg: 85, preset: 'lx200' as const, active: true,
    };
    const cfg = resolveMountConfig(null, null, custom);
    expect(cfg.custom).toBe(custom);
    expect(cfg.modelLabel).toBe('Ma monture');
    expect(cfg.driverPref).toBe('skywatcher');
    expect(cfg.preset).toBe('lx200');
  });

  it('saisie manuelle inactive → ignorée (sélection catalogue fait foi)', () => {
    const custom = {
      label: 'ancienne saisie', protocol: 'meade' as const, altaz: true,
      minAltDeg: 0, maxAltDeg: 90, preset: 'generic' as const, active: false,
    };
    const cfg = resolveMountConfig('meade', 'meade-etx90', custom);
    expect(cfg.custom).toBeNull();
    expect(cfg.modelLabel).toBe('ETX-90 (RA/EC/AT/Observer)');
  });
});

describe('activePreset — presets mécaniques', () => {
  it('modèle catalogue → preset du modèle (NexStar 8SE → LX90)', () => {
    const p = activePreset('celestron', 'celestron-nexstar8se', null, null);
    expect(p.id).toBe('lx90');
    expect(p.label).toBe('LX90');
  });

  it('saisie manuelle → butées et type SURCHARGÉS', () => {
    const custom = {
      label: 'Custom EQ', protocol: 'meade' as const, altaz: false,
      minAltDeg: 15, maxAltDeg: 80, preset: 'etx90' as const, active: true,
    };
    const p = activePreset(null, null, custom, null);
    expect(p.minAltDeg).toBe(15);
    expect(p.maxAltDeg).toBe(80);
    expect(p.altaz).toBe(false);
    expect(p.label).toBe('Custom EQ');
    // taux du preset de référence conservés
    expect(p.expectedRates).toEqual(MOUNT_PRESETS.etx90.expectedRates);
  });

  it('rien de sélectionné + choix manuel historique → compatibilité v2.6.0', () => {
    // un utilisateur de v2.6.0 qui avait choisi DS-114 dans les puces
    const p = activePreset(null, null, null, null, 'ds114');
    expect(p.id).toBe('ds114');
  });

  it('rien de sélectionné + auto → déduit de la raquette détectée', () => {
    const p = activePreset(null, null, null, 'autostar497', 'auto');
    expect(p.id).toBe('etx125'); // suggestion ETX-125 pour #497 (v2.6.0)
  });
});
