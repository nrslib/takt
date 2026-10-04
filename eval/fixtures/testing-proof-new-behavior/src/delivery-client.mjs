export function createDeliveryClient(send, initialRoute, onRetired) {
  let route = initialRoute;
  function disconnect() {
    route = null;
  }
  return {
    disconnect,
    async deliver(draft) {
      try {
        return await send({draft, route});
      } catch (error) {
        if (error.code === 'ROUTE_RETIRED') {
          disconnect();
          onRetired();
        }
        throw error;
      }
    },
  };
}
