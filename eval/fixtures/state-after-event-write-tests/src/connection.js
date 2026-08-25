export function createConnection(initialStatus) {
  return {
    reconnect(_nextStatus) {},
    readStatus() {
      return initialStatus;
    },
  };
}
