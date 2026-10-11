/** Mock minimal de @react-native-community/geolocation pour tests de rendu. */
const Geolocation = {
  setRNConfiguration: () => undefined,
  requestAuthorization: () => undefined,
  getCurrentPosition: (_s: unknown, e: (x: unknown) => void) => e && e(new Error('mock')),
  watchPosition: () => 0,
  clearWatch: () => undefined,
  stopObserving: () => undefined,
  addListener: () => undefined,
  removeListeners: () => undefined,
};

module.exports = Geolocation;
module.exports.default = Geolocation;
