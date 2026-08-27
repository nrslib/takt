export function createSettings(rateLimit) {
  let currentRateLimit = rateLimit;
  const listeners = [];

  return {
    get rateLimit() {
      return currentRateLimit;
    },
    set rateLimit(nextRateLimit) {
      currentRateLimit = nextRateLimit;
    },
    on(event, listener) {
      if (event !== 'change') throw new Error(`Unsupported event: ${event}`);
      listeners.push(listener);
    },
    emit(event) {
      if (event !== 'change') throw new Error(`Unsupported event: ${event}`);
      for (const listener of listeners) listener();
    },
  };
}
