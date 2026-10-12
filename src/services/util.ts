/** Utilitaires partagés (v2.6.0 — fin de la duplication sleep ×7). */

/** Attente non bloquante — unique définition de l'app (7 copies supprimées). */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Normalisation d'angle [0, 360). */
export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;
