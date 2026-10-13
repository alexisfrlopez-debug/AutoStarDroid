/**
 * Tests v2.9.5 — décision de centrage de la carte du ciel (skyCenter).
 *
 * Retour terrain v2.9.4 : « la carte du ciel semble figée. je peux la faire
 * glisser, selectionner un objet, lancer le goto mais elle revient ensuite
 * dans sa position initiale et ne suit pas le chercheur alors que le
 * telescope semble pointer au bon endroit après le goto ».
 *
 * Deux défauts corrigés :
 *  1. le pan manuel gagnait JUSQU'AU GOTO SUIVANT — plus aucun suivi ;
 *  2. au GOTO, la carte sautait sur la position PÉRIMÉE du télescope
 *     (= « revient dans sa position initiale ») au lieu d'aller sur la cible.
 */
import {
  skyCenter, SKY_SCOPE_FRESH_MS, SKY_TARGET_HOLD_MS,
} from '../src/services/astro/skyview';

const M = (altDeg: number, azDeg: number) => ({altDeg, azDeg});
const base = (over: Partial<Parameters<typeof skyCenter>[0]> = {}) => ({
  follow: true,
  manual: null,
  gotoRunning: false,
  target: null as {altDeg: number; azDeg: number} | null,
  targetRecent: false,
  scope: null as {altDeg: number; azDeg: number} | null,
  scopeFresh: false,
  phone: null as {altDeg: number; azDeg: number} | null,
  fallback: M(35, 180),
  ...over,
});

describe('skyCenter (v2.9.5) — la carte suit le télescope ET le glisser marche', () => {
  it('constantes : fraîcheur 8 s, cible retenue 3 min', () => {
    expect(SKY_SCOPE_FRESH_MS).toBe(8000);
    expect(SKY_TARGET_HOLD_MS).toBe(180000);
  });

  it('suivi live : télescope FRAIS → la carte colle au télescope (1 Hz)', () => {
    const c = skyCenter(base({scope: M(42, 123), scopeFresh: true}));
    expect(c.src).toBe('scope');
    expect(c.altDeg).toBe(42);
    expect(c.azDeg).toBe(123);
  });

  it('EXPLORATION : le glisser coupe le suivi — la carte reste où posée (v2.9.4 corrigé dans l\u2019autre sens)', () => {
    const c = skyCenter(base({
      follow: false, manual: M(20, 300),
      scope: M(42, 123), scopeFresh: true, // même frais, le pan gagne
    }));
    expect(c.src).toBe('manual');
    expect(c.altDeg).toBe(20);
  });

  it('GOTO en cours → la carte part sur la CIBLE, pas sur la vieille position du télescope', () => {
    const c = skyCenter(base({
      gotoRunning: true,
      target: M(55, 210),
      scope: M(10, 40), scopeFresh: true, // position périmée ou pas : la cible prime
    }));
    expect(c.src).toBe('target');
    expect(c.altDeg).toBe(55);
    expect(c.azDeg).toBe(210);
  });

  it('slew direct muet : télescope PÉRIMÉ + cible récente → la carte attend sur la cible', () => {
    const c = skyCenter(base({
      target: M(55, 210), targetRecent: true,
      scope: M(10, 40), scopeFresh: false, // :MS parti, raquette muette pendant le slew
    }));
    expect(c.src).toBe('target');
  });

  it('cible PÉRIMÉE (3 min) + télescope périmé → retombée sur la dernière position connue', () => {
    const c = skyCenter(base({
      target: M(55, 210), targetRecent: false,
      scope: M(10, 40), scopeFresh: false,
    }));
    expect(c.src).toBe('scope');
  });

  it('hors GOTO, le télescope frais PRIME sur une cible récente (le suivi ne se coupe pas tout seul)', () => {
    const c = skyCenter(base({
      target: M(55, 210), targetRecent: true,
      scope: M(10, 40), scopeFresh: true,
    }));
    expect(c.src).toBe('scope');
  });

  it('déconnecté + cible récente (objet « Définir ») → centrage sur la cible choisie', () => {
    const c = skyCenter(base({target: M(30, 90), targetRecent: true}));
    expect(c.src).toBe('target');
  });

  it('repli téléphone (visée du tube par capteurs) puis défaut', () => {
    expect(skyCenter(base({phone: M(25, 11)})).src).toBe('phone');
    expect(skyCenter(base()).src).toBe('phone');
    expect(skyCenter(base()).altDeg).toBe(35);
    expect(skyCenter(base()).azDeg).toBe(180);
  });

  it('exploration + rien d\u2019autre : le pan posé à la main reste le centre', () => {
    const c = skyCenter(base({follow: false, manual: M(12, 200)}));
    expect(c.src).toBe('manual');
    expect(c.altDeg).toBe(12);
  });

  it('suivi reprise : follow=true + manual=null après « Recentrer » → télescope frais', () => {
    const c = skyCenter(base({
      manual: null, // Recentrer : setManual(null) + setFollow(true)
      scope: M(42, 123), scopeFresh: true,
    }));
    expect(c.src).toBe('scope');
  });
});
