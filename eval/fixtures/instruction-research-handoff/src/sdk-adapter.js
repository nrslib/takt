export function createClient(context, transport) {
  if (typeof transport !== 'function') {
    throw new TypeError('transport must be a function');
  }

  return {
    request(input) {
      return transport({ context, input });
    },
  };
}
