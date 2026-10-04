import { watchSettings } from './settingsWatcher.js';

function createLimiter(rateLimit) {
  let requestCount = 0;

  return {
    allow() {
      if (requestCount >= rateLimit) return false;
      requestCount += 1;
      return true;
    },
  };
}

export function createService({ settings, log }) {
  const limiter = createLimiter(settings.rateLimit);
  watchSettings(settings, log);

  return {
    allowRequest() {
      return limiter.allow();
    },
  };
}
