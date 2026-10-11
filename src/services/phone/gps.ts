/** Données du téléphone : GPS + horloge (pour la mise à jour de la raquette). */
import Geolocation from '@react-native-community/geolocation';
import {PermissionsAndroid, Platform} from 'react-native';

export interface PhonePos {
  latDeg: number;
  lonDeg: number;
  elevM: number;
}

/** Cause d'échec d'une acquisition GPS — chaque cause a SON message
 *  (i18n côté écran, v2.1.2 : fini le « GPS indisponible » fourre-tout). */
export type GpsErrorCode = 'perm' | 'off' | 'timeout' | 'unavailable';

export class GpsError extends Error {
  code: GpsErrorCode;
  constructor(code: GpsErrorCode, msg?: string) {
    super(msg ?? code);
    this.name = 'GpsError';
    this.code = code;
  }
}

/** Demande la permission localisation. Résultat GRANULAIRE : Android 12+
 *  permet de n'accorder que la position « approximative » — c'est largement
 *  suffisant pour un site de télescope (précision ~25 m). Exiger la précision
 *  fine (ancien comportement) refusait une position pourtant obtenable :
 *  c'était la cause n°1 du « l'application n'arrive pas à obtenir la
 *  position GPS » dans l'onglet Réglages. */
export type PermResult = 'fine' | 'coarse' | 'denied';

export async function requestLocationPermission(): Promise<PermResult> {
  if (Platform.OS !== 'android') return 'fine';
  try {
    // Déjà accordée (session précédente) ? requestMultiple afficherait une
    // boîte de dialogue inutile — on vérifie d'abord l'état courant.
    const [fineNow, coarseNow] = await Promise.all([
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION),
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION),
    ]);
    if (fineNow) return 'fine';
    if (coarseNow) return 'coarse';
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    ]);
    const fine = res[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
    const coarse = res[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
    if (fine) return 'fine';
    if (coarse) return 'coarse';
    return 'denied';
  } catch (_) {
    return 'denied';
  }
}

/** Un appel getCurrentPosition promisifié. */
function positionOnce(
  highAccuracy: boolean,
  timeoutMs: number,
): Promise<PhonePos> {
  return new Promise((resolve, reject) => {
    Geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latDeg: pos.coords.latitude,
          lonDeg: pos.coords.longitude,
          elevM: pos.coords.altitude ?? 0,
        }),
      (err) => {
        // Codes PositionError : 1 = permission, 2 = indisponible, 3 = délai.
        const code: GpsErrorCode =
          (err as unknown as {code?: number}).code === 3 ? 'timeout'
          : (err as unknown as {code?: number}).code === 2 ? 'unavailable'
          : (err as unknown as {code?: number}).code === 1 ? 'perm'
          : 'unavailable';
        reject(new GpsError(code, err.message || code));
      },
      {enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: 60000},
    );
  });
}

/**
 * Position GPS du téléphone — stratégie à DEUX TENTATIVES (v2.1.2) :
 *  1. précision haute (GPS) : 18 s — un premier fix à froid met souvent
 *     plus de 12 s (l'ancien timeout unique) ;
 *  2. repli RÉSEAU (Wi-Fi/antennes, enableHighAccuracy=false) : 10 s —
 *     obtenu en quelques secondes MÊME EN INTÉRIEUR, précision largement
 *     suffisante pour le site d'observation (l'ancien comportement échouait
 *     dès que le GPS ne fixait pas : « position GPS indisponible »).
 */
export async function getPhonePosition(): Promise<PhonePos> {
  const perm = await requestLocationPermission();
  if (perm === 'denied') {
    throw new GpsError('perm', 'Permission localisation refusée');
  }
  try {
    return await positionOnce(true, 18000);
  } catch (eHigh) {
    // le GPS n'a pas fixé (intérieur, ciel obstrué, cold start) : repli réseau
    try {
      return await positionOnce(false, 10000);
    } catch (eLow) {
      const c = (eHigh as GpsError).code;
      if (c === 'perm') throw eHigh;
      // différencier « services localisation désactivés » du simple délai :
      // le repli réseau échoue AUSSI quand la localisation système est OFF
      const lowCode = (eLow as GpsError).code;
      throw new GpsError(
        lowCode === 'unavailable' && c === 'unavailable' ? 'off' : (c === 'timeout' || lowCode === 'timeout' ? 'timeout' : (lowCode as GpsErrorCode)),
        (eLow as Error).message,
      );
    }
  }
}
