/** Configuration Jest — repro local des crashs JS (écran Raquette). */
module.exports = {
  preset: './node_modules/react-native/jest-preset.js',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^react-native-tcp-socket$': '<rootDir>/__mocks__/react-native-tcp-socket.js',
    '^@react-native-community/geolocation$': '<rootDir>/__mocks__/@react-native-community_geolocation.js',
    '^react-native-svg$': '<rootDir>/__mocks__/react-native-svg.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-tcp-socket|@react-navigation|react-native-screens|react-native-safe-area-context|@react-native-async-storage)/)',
  ],
};
