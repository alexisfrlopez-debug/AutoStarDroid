/**
 * Thème « AutoStar Droid » — ambiance ciel profond nocturne.
 * Mode vision nocturne : palette rouge (préserve l'adaptation oculaire).
 */
export const C = {
  bg: '#05070D',
  bgPanel: '#0E1524',
  bgPanel2: '#131C2E',
  border: '#1F2A44',
  text: '#E6EDF7',
  textDim: '#8FA0BF',
  textFaint: '#5A6A8A',
  amber: '#E8B84B',
  amberDim: '#8F7430',
  blue: '#4FA3FF',
  green: '#3FD68C',
  red: '#FF5D5D',
  orange: '#FF9F45',
  lcdBg: '#0A1F14',
  lcdText: '#7CFFB2',
  btnBg: '#182338',
  btnActive: '#2A3A5C',
  danger: '#B3362B',
};

export const night = {
  bg: '#000000',
  bgPanel: '#1A0000',
  bgPanel2: '#240000',
  border: '#3A0000',
  text: '#FF4B4B',
  textDim: '#A11D1D',
  textFaint: '#5C1010',
  amber: '#FF3B30',
  amberDim: '#7A1D17',
  blue: '#FF3B30',
  green: '#FF3B30',
  red: '#FF3B30',
  orange: '#FF3B30',
  lcdBg: '#150000',
  lcdText: '#FF4B4B',
  btnBg: '#200000',
  btnActive: '#330000',
  danger: '#FF3B30',
};

export type Palette = typeof C;

export const theme = (nightVision: boolean): Palette => (nightVision ? night : C);

export const spacing = {xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32};
export const radius = {s: 8, m: 12, l: 18, round: 999};
