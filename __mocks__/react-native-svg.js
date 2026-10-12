/** Mock Jest de react-native-svg — composants rendus comme View neutres. */
const React = require('react');

const make = (name) => {
  const C = (props) => React.createElement(name, props, props.children);
  C.displayName = name;
  return C;
};

const Svg = make('Svg');

module.exports = {
  __esModule: true,
  default: Svg,
  Svg,
  Circle: make('Circle'),
  Ellipse: make('Ellipse'),
  Line: make('Line'),
  Rect: make('Rect'),
  Path: make('Path'),
  G: make('G'),
  Text: make('Text'),
  Defs: make('Defs'),
  RadialGradient: make('RadialGradient'),
  LinearGradient: make('LinearGradient'),
  Stop: make('Stop'),
  Polygon: make('Polygon'),
  Polyline: make('Polyline'),
};
