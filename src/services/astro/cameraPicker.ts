/**
 * SÉLECTION DE CAMÉRA PAR TYPE (v2.8.1 — « je veux pouvoir sélectionner
 * caméra interne ou externe, et selon ce qui est choisi un menu déroulant
 * qui affiche toutes les caméras disponibles selon le choix — si plusieurs
 * caméras, front/rear/grand angle/IR etc. selon les options du téléphone »).
 *
 * Pur et testable (aucun module natif) : découpage interne/externe,
 * libellé traduit par rôle du capteur, choix automatique par défaut.
 */
import type {CameraDeviceInfo} from '../phone/astroCamera';

export type CamType = 'internal' | 'external';

/** Libellés i18n requis pour composer le nom d'une caméra interne. */
export interface CamRoleLabels {
  /** « Arrière » / « Rear » */
  rear: string;
  /** « Frontale » / « Front » */
  front: string;
  /** « principale » / « main » */
  main: string;
  /** « grand-angle » / « wide-angle » */
  wide: string;
  /** « téléobjectif » / « telephoto » */
  tele: string;
  /** « profondeur / IR » / « depth / IR » */
  depth: string;
  /** « Externe (UVC) » — utilisé si le libellé natif manque. */
  external: string;
}

/** Découpe la liste par type : externe = UVC USB-host OU capteur HAL
 *  externe ; interne = le reste (arrière, avant, profondeur). L'ordre du
 *  catalogue est conservé (UVC d'abord, puis focale croissante implicite
 *  de l'énumération Camera2). */
export function splitByType(devices: CameraDeviceInfo[]): {
  internal: CameraDeviceInfo[];
  external: CameraDeviceInfo[];
} {
  const internal: CameraDeviceInfo[] = [];
  const external: CameraDeviceInfo[] = [];
  for (const d of devices) {
    if (d.external || d.source === 'uvc' || d.facing === 'external') external.push(d);
    else internal.push(d);
  }
  return {internal, external};
}

/** Libellé affiché dans le menu déroulant — le rôle du capteur est traduit
 *  côté JS (le natif ne renvoie qu'un code) ; les UVC gardent leur libellé
 *  matériel (« UVC — SVBONY (0A12:1234) »). */
export function deviceLabel(d: CameraDeviceInfo, L: CamRoleLabels): string {
  if (d.source === 'uvc' || d.facing === 'external') {
    return d.label || L.external;
  }
  const roleWord =
    d.role === 'wide' ? L.wide :
    d.role === 'tele' ? L.tele :
    d.role === 'depth' ? L.depth : L.main;
  const side = d.facing === 'front' ? L.front : L.rear;
  // avant principale : « Frontale » suffit ; les autres : « Arrière — grand-angle »
  if (d.facing === 'front' && d.role === 'main') return side;
  return `${side} — ${roleWord}`;
}

/** Type par défaut : externe dès qu'une caméra externe existe (la cible
 *  principale est la caméra astro UVC) ; sinon interne. */
export function defaultType(devices: CameraDeviceInfo[]): CamType {
  return devices.some((d) => d.external || d.source === 'uvc' || d.facing === 'external')
    ? 'external' : 'internal';
}

/** Garde le type demandé si des caméras existent, sinon bascule. */
export function coerceType(want: CamType, devices: CameraDeviceInfo[]): CamType {
  const {internal, external} = splitByType(devices);
  if (want === 'external') return external.length > 0 ? 'external' : 'internal';
  return internal.length > 0 ? 'internal' : (external.length > 0 ? 'external' : 'internal');
}

/** Le choix courant reste-t-il dans la liste du type affiché ? */
export function selectionValid(cameraId: string | null, shown: CameraDeviceInfo[]): boolean {
  if (!cameraId) return false;
  return shown.some((d) => d.id === cameraId);
}
