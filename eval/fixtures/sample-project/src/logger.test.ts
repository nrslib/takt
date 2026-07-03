import { describe, expect, it, vi } from 'vitest';
import { Logger, type LogLevel } from './logger.js';

function captureStderr(): { written: string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return { written, restore: () => spy.mockRestore() };
}

describe('Logger', () => {
  it('writes messages at or above the minimum level', () => {
    const { written, restore } = captureStderr();
    const logger = new Logger('info');
    logger.log('warn', 'disk almost full');
    restore();
    expect(written).toEqual(['[warn] disk almost full\n']);
  });

  it('filters messages below the minimum level', () => {
    const { written, restore } = captureStderr();
    const logger = new Logger('warn');
    logger.log('info', 'started');
    logger.debug('noise');
    restore();
    expect(written).toEqual([]);
  });

  it.each<LogLevel>(['debug', 'info', 'warn', 'error'])(
    'writes %s messages when minimum level is debug',
    (level) => {
      const { written, restore } = captureStderr();
      const logger = new Logger('debug');
      logger.log(level, 'msg');
      restore();
      expect(written).toEqual([`[${level}] msg\n`]);
    },
  );

  it('exposes level shorthands that delegate to log', () => {
    const { written, restore } = captureStderr();
    const logger = new Logger('debug');
    logger.debug('a');
    logger.error('b');
    restore();
    expect(written).toEqual(['[debug] a\n', '[error] b\n']);
  });
});
