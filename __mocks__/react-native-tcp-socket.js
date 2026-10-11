/** Mock minimal de react-native-tcp-socket pour les tests de rendu. */
const TcpSocket = {
  createConnection: () => ({
    on: () => undefined,
    write: () => undefined,
    destroy: () => undefined,
    end: () => undefined,
    setNoDelay: () => undefined,
    setTimeout: () => undefined,
  }),
};

module.exports = TcpSocket;
module.exports.default = TcpSocket;
