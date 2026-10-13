/**
 * GOTO « RELAIS » en boucle fermée (v2.5.0 — cause racine « le goto ne
 * fonctionne toujours pas quand il est lancé autrement que par la raquette »).
 *
 * Sur certaines raquettes (DS/Autostar #49x sur liaison série lente), la
 * séquence directe :Sr/:Sd/:MS échoue (refus/mutisme) ALORS QUE les lectures
 * de position :Gr#/:Gd# et les commandes moteur :Mn#:Ms#:Me#:Mw# + vitesses
 * :RG#:RC#:RM#:RS# fonctionnent parfaitement (c'est le socle utilisé depuis
 * v1.x par les flèches, le suivi et le réglage fin — éprouvé chez
 * l'utilisateur). Le relais exploite EXCLUSIVEMENT ce socle :
 *
 *   lire position → rester d'arc → impulsion moteurs à la bonne vitesse →
 *   relire → corriger le sens si l'erreur a grandi → recommencer jusqu'à la
 *   cible (tolérance ~7′) ou garde (stalle / durée).
 *
 * Toutes les fonctions sont PURES (testées) : la boucle elle-même vit dans
 * AutostarClient.gotoRaDecRelay (client.ts) et n'utilise que des Promise.
 */

export type RelaySpeed = 'slew' | 'find' | 'center';

/** Signes moteurs : +1 = :Me augmente l'AD et :Mn augmente la DEC. */
export interface RelaySigns {ra: 1 | -1; dec: 1 | -1}

/** Taux sur le ciel par vitesse (deg/s) — mesurés au calibrage si dispo,
 *  sinon preset de monture, sinon taux théoriques.
 *  (pas de palier « guide » : le taux sidéral rendrait la fin de course
 *  interminable — le relais termine au taux center, précision ~7′ visée). */
export interface RelayRates {slew: number; find: number; center: number}

export interface RelayInput {
  /** Position courante (deg). */
  raDeg: number;
  decDeg: number;
  /** Cible (deg). */
  targetRaDeg: number;
  targetDecDeg: number;
  signs: RelaySigns;
  rates: RelayRates;
  /** Plafond de durée d'une impulsion (s) — anti-dérive si lecture perdue. */
  maxPulseS: number;
}

export interface RelayDirs {raDir: 'e' | 'w' | null; decDir: 'n' | 's' | null}

export interface RelayDecision {
  /** Cible atteinte (arc restant sous la tolérance). */
  done: boolean;
  /** Vitesse à sélectionner avant l'impulsion. */
  speed: RelaySpeed;
  /** Durée proposée PAR AXE (s) — 0 si l'axe est immobile. Chaque axe est
   *  arrêté à SA durée : les axes avancent en parallèle à la vitesse commune
   *  de la monture, mais pas forcément aussi longtemps. */
  raS: number;
  decS: number;
  /** Directions à commander (axes participant à CE pas). Un axe dont le
   *  reste est trop court pour la vitesse courante est REPORTÉ au pas
   *  suivant (il serait sinon dépassé de beaucoup — impulsion minimum). */
  dirs: RelayDirs;
  /** Restes d'arc (deg, signés) — pour le journal et le suivi d'évolution. */
  remainRaDeg: number;
  remainDecDeg: number;
}

/** Sous ce reste d'arc TOTAL (deg) la cible est atteinte (~7′ d'arc). */
export const RELAY_TOLERANCE_DEG = 0.12;
/** Passage slew → find en dessous de ce reste (deg). AVANT v2.9.3 le relais
 *  passait DIRECTEMENT au taux center (0,05°/s !) sous 2,5° — les derniers
 *  degrés rampaient pendant ~45 s, et une cible d'entrée < 2,5° rampait de
 *  bout en bout (« le goto est toujours lent quand il se lance »). */
export const RELAY_FIND_AT_DEG = 2.0;
/** Passage find → center en dessous de ce reste (deg) — la course lente ne
 *  concerne plus que la fraction finale (< ~8 s au taux center d'un DS). */
export const RELAY_CENTER_AT_DEG = 0.4;
/** Amortissement : on commande 80 % de l'arc pour ne pas rerfresher. */
export const RELAY_DAMPING = 0.8;
/** Un reste sous ce seuil est considéré NUL (bruit de lecture ±). */
export const RELAY_DEADBAND_DEG = 0.02;
/** Durée d'impulsion minimale utile (s) — en dessous, la mécanique n'a pas
 *  le temps de démarrer et la lecture de position ne voit rien. */
export const RELAY_MIN_PULSE_S = 0.12;

/** Plus court delta AD signé (deg, raccord de 0 h dans ±180). */
export function raDeltaDeg(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Reste d'arc par axe (deg, signés) — AD en plus court chemin. */
export function relayRemainders(
  raDeg: number, decDeg: number, targetRaDeg: number, targetDecDeg: number,
): {remainRaDeg: number; remainDecDeg: number} {
  const remainRaDeg = Math.abs(raDeltaDeg(raDeg, targetRaDeg)) < RELAY_DEADBAND_DEG
    ? 0 : raDeltaDeg(raDeg, targetRaDeg);
  const remainDecDeg = Math.abs(targetDecDeg - decDeg) < RELAY_DEADBAND_DEG
    ? 0 : targetDecDeg - decDeg;
  return {remainRaDeg, remainDecDeg};
}

/** Vitesse du relais selon le reste d'arc le plus grand — TROIS paliers
 *  (v2.9.3) : slew (>2°), find (0,4…2°), center (<0,4°). */
export function relaySpeedFor(maxRemainAbsDeg: number): RelaySpeed {
  return maxRemainAbsDeg >= RELAY_FIND_AT_DEG ? 'slew'
    : maxRemainAbsDeg >= RELAY_CENTER_AT_DEG ? 'find' : 'center';
}

/**
 * Décision d'UNE itération du relais. La vitesse commune est fixée par le
 * reste le plus grand ; chaque axe participant reçoit SA durée (reste ×
 * amortissement ÷ taux) et les axes dont l'impulsion serait trop courte à
 * cette vitesse sont REPORTÉS (une impulsion minimum à vitesse slew ferait
 * dépasser la cible de plusieurs degrés).
 */
export function relayDecision(inp: RelayInput): RelayDecision {
  const {remainRaDeg, remainDecDeg} = relayRemainders(
    inp.raDeg, inp.decDeg, inp.targetRaDeg, inp.targetDecDeg);
  const absRa = Math.abs(remainRaDeg);
  const absDec = Math.abs(remainDecDeg);
  const maxRemain = Math.max(absRa, absDec);
  if (maxRemain <= RELAY_TOLERANCE_DEG) {
    return {done: true, speed: 'center', raS: 0, decS: 0, dirs: {raDir: null, decDir: null}, remainRaDeg, remainDecDeg};
  }
  let speed = relaySpeedFor(maxRemain);
  let rate = inp.rates[speed];
  let timeRa = absRa > 0 ? (absRa * RELAY_DAMPING) / rate : Infinity;
  let timeDec = absDec > 0 ? (absDec * RELAY_DAMPING) / rate : Infinity;
  let raDir: 'e' | 'w' | null = absRa > 0 && timeRa >= RELAY_MIN_PULSE_S
    ? (remainRaDeg * inp.signs.ra > 0 ? 'e' : 'w') : null;
  let decDir: 'n' | 's' | null = absDec > 0 && timeDec >= RELAY_MIN_PULSE_S
    ? (remainDecDeg * inp.signs.dec > 0 ? 'n' : 's') : null;
  // AUCUN axe ne participe à cette vitesse (restes minuscules) : on repasse
  // au taux CENTER — l'impulsion minimum y ne dépasse la cible que de
  // ~0,01° (36″), sans danger. Les durées sont alors resserrées sur les
  // restes réels, plafonnées comme toujours. La vitesse SIGNALÉE devient
  // aussi 'center' (v2.9.3) : la raquette doit être AU taux dont les
  // durées supposent — sinon les impulsions sous-tirent de 50×.
  if (raDir === null && decDir === null) {
    speed = 'center';
    rate = inp.rates.center;
    timeRa = absRa > 0 ? Math.max((absRa * RELAY_DAMPING) / rate, RELAY_MIN_PULSE_S) : 0;
    timeDec = absDec > 0 ? Math.max((absDec * RELAY_DAMPING) / rate, RELAY_MIN_PULSE_S) : 0;
    raDir = absRa > 0 ? (remainRaDeg * inp.signs.ra > 0 ? 'e' : 'w') : null;
    decDir = absDec > 0 ? (remainDecDeg * inp.signs.dec > 0 ? 'n' : 's') : null;
  }
  const raS = raDir === null ? 0 : Math.min(timeRa, inp.maxPulseS);
  const decS = decDir === null ? 0 : Math.min(timeDec, inp.maxPulseS);
  return {
    done: false,
    speed,
    raS, decS,
    dirs: {raDir, decDir},
    remainRaDeg,
    remainDecDeg,
  };
}

/**
 * Le signe d'un axe était-il MAUVAIS ? (l'erreur a grandi au lieu de se
 * réduire après une impulsion franche) — auto-apprentissage local du relais,
 * même philosophie que shouldFlipSign du suivi télémétrique.
 */
export function relaySignWasWrong(remainBeforeDeg: number, remainAfterDeg: number, movedDeg: number): boolean {
  if (movedDeg < 0.05) return false; // impulsion trop courte pour conclure
  return Math.abs(remainAfterDeg) > Math.abs(remainBeforeDeg) + 0.05;
}

/** Le mouvement est-il STALLÉ ? (impulsion commandée, position figée ×n) */
export function relayStalled(pulseCommanded: boolean, positionMovedDeg: number, consecutive: number): boolean {
  return pulseCommanded && positionMovedDeg < RELAY_DEADBAND_DEG && consecutive >= 3;
}

/**
 * Apprentissage ADAPTATIF du taux réel (v2.9.3) : après chaque impulsion,
 * taux observé = arc réellement parcouru ÷ durée commandée. L'hypothèse
 * (preset/calibrage) peut être fausse de ×10 — le preset ne fait que la
 * DURÉE des impulsions, pas la vitesse physique : une hypothèse trop haute
 * découpe le déplacement en micro-itérations, trop basse fait dépasser.
 * EMA 50 %, observation bornée à ±4× l'hypothèse (une lecture pendant
 * l'inertie ou un capteur farfelu ne détruit pas le calage). Arc trop
 * petit pour conclure (stalle, bruit) → on garde la valeur précédente.
 */
export function relayLearnRate(
  prev: number | null, movedDeg: number, pulseS: number, assumed: number,
): number {
  if (pulseS < RELAY_MIN_PULSE_S) return prev ?? assumed;
  if (movedDeg < RELAY_DEADBAND_DEG) return prev ?? assumed;
  const raw = movedDeg / pulseS;
  const obs = Math.min(assumed * 4, Math.max(assumed / 4, raw));
  const learned = prev == null ? obs : prev * 0.5 + obs * 0.5;
  return Math.min(15, Math.max(0.01, learned));
}

/* ------------------------------------------------------------------ */
/* Butées de monture (v2.9.2)                                          */
/* ------------------------------------------------------------------ */

/** Marge de sécurité autour des butées du preset (deg) — le relais ne
 *  pousse plus l'altitude au-delà de [min + marge, max − marge]. */
export const RELAY_ALT_MARGIN_DEG = 2;

/** L'altitude est-elle HORS de la course autorisée de la monture ?
 *  Renvoie 'high' (au-dessus de la butée haute), 'low' (sous la butée
 *  basse) ou null (course autorisée). Utilisé DEUX fois par le relais :
 *  au départ (cible refusée honnêtement) et EN CONTINU dans la boucle
 *  (un pointage erroné ne doit jamais enfoncer la monture dans sa butée —
 *  retour terrain v2.9.1 : « le télescope monte jusqu'à la butée et
 *  cherche à continuer de monter sans la respecter »). */
export function relayAltBlocked(
  altDeg: number, minAltDeg: number, maxAltDeg: number,
): 'high' | 'low' | null {
  if (altDeg > maxAltDeg - RELAY_ALT_MARGIN_DEG) return 'high';
  if (altDeg < minAltDeg + RELAY_ALT_MARGIN_DEG) return 'low';
  return null;
}
