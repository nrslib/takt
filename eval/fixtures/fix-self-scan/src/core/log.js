// Minimal leveled logger used across the tool.
const LEVELS = ['debug', 'info', 'warn', 'error'];

export function createLogger(minLevel = 'info') {
  const threshold = LEVELS.indexOf(minLevel);
  if (threshold < 0) throw new Error(`unrecognized log level: ${minLevel}`);
  const lines = [];
  const log = (level, message) => {
    if (LEVELS.indexOf(level) >= threshold) lines.push(`[${level}] ${message}`);
    return log;
  };
  return {
    debug: (m) => log('debug', m),
    info: (m) => log('info', m),
    warn: (m) => log('warn', m),
    error: (m) => log('error', m),
    lines: () => [...lines],
  };
}
