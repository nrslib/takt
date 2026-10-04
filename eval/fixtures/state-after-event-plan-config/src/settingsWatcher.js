export function watchSettings(settings, log) {
  settings.on('change', () => {
    log(`rateLimit changed to ${settings.rateLimit}`);
  });
}
