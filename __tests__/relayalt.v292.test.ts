/**
 * Tests v2.9.2 — gardes de BUTÉE du relais GOTO (relayAltBlocked) + statut
 * 'aborted' du GOTO (bouton ARRÊTER global, gotoErrorText silencieux).
 *
 * Contexte terrain v2.9.1 : « le telescope monte jusqu'à la butée (rapidement
 * cette fois) et cherche à continuer de monter sans respecter la butée » et
 * « j'ai aucun moyen de l'arrêter » — ces gardes verrouillent le comportement
 * attendu du relais (refus de cible hors course, arrêt continu, annulation).
 */
import {relayAltBlocked, RELAY_ALT_MARGIN_DEG} from '../src/services/astro/gotorelay';
import {gotoErrorText, type GotoErrorTexts} from '../src/services/protocol/driver';

const TXT: GotoErrorTexts = {
  belowHorizon: 'sous l\'horizon',
  empty: 'introuvable',
  gotoNoLink: 'liaison perdue',
  gotoMute: 'raquette muette',
  refused: 'refusé',
  relayPartial: 'partiel',
};

describe('relayAltBlocked (v2.9.2 — butées de monture)', () => {
  const MIN = 8, MAX = 88; // preset ETX

  it('accepte toute la course autorisée (marge incluse)', () => {
    expect(relayAltBlocked(45, MIN, MAX)).toBeNull();
    expect(relayAltBlocked(10, MIN, MAX)).toBeNull();
    expect(relayAltBlocked(78, MIN, MAX)).toBeNull();
  });

  it('bloque au-dessus de la butée haute − marge', () => {
    expect(relayAltBlocked(MAX - RELAY_ALT_MARGIN_DEG + 0.5, MIN, MAX)).toBe('high');
    expect(relayAltBlocked(90, MIN, MAX)).toBe('high');
  });

  it('bloque sous la butée basse + marge', () => {
    expect(relayAltBlocked(MIN + RELAY_ALT_MARGIN_DEG - 1, MIN, MAX)).toBe('low');
    expect(relayAltBlocked(2, MIN, MAX)).toBe('low');
  });

  it('la marge est de 2° (garde anti-dépassement)', () => {
    expect(RELAY_ALT_MARGIN_DEG).toBe(2);
  });

  it('monture à course complète (DS-114 : 0…88)', () => {
    expect(relayAltBlocked(3, 0, 88)).toBeNull();   // alt 3 > 0 + 2 → NON : 3 < 2 ? Non — 3 ≥ 2 → autorisé
    expect(relayAltBlocked(1, 0, 88)).toBe('low');
    expect(relayAltBlocked(86.5, 0, 88)).toBe('high');
    expect(relayAltBlocked(40, 0, 88)).toBeNull();
  });
});

describe('gotoErrorText — statut aborted (v2.9.2)', () => {
  it('l\'arrêt utilisateur n\'est PAS une erreur (message vide)', () => {
    expect(gotoErrorText('aborted', TXT)).toBe('');
  });

  it('ok reste silencieux, les vraies erreurs gardent leur message', () => {
    expect(gotoErrorText('ok', TXT)).toBe('');
    expect(gotoErrorText('relayPartial', TXT)).toBe('partiel');
    expect(gotoErrorText('refused', TXT)).toBe('refusé');
  });
});
