/** Données du téléphone : GPS + horloge (pour la mise à jour de la raquette). */
import Geolocation from '@react-native-community/geolocation';
import {PermissionsAndroid, Platform} from 'react-native';

export interface PhonePos {
  latDeg: number;
  lonDeg: number;
  elevM: number;
}

export async function requestLocationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    ]);
    return Object.values(res).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
  } catch (_) {
    return false;
  }
}

/** Position GPS du téléphone (précision moyenne, timeout 12 s). */
export async function getPhonePosition(): Promise<PhonePos> {
  const ok = await requestLocationPermission();
  if (!ok) throw new Error('Permission localisation refusée');
  return new Promise((resolve, reject) => {
    Geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latDeg: pos.coords.latitude,
          lonDeg: pos.coords.longitude,
          elevM: pos.coords.altitude ?? 0,
        }),
      (err) => reject(new Error(err.message || 'GPS indisponible')),
      {enableHighAccuracy: true, timeout: 12000, maximumAge: 30000},
    );
  });
}
