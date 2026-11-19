import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { catchLintPlugin, catchRules } from '../../scripts/catch-lint-rules.mjs';

const linter = new Linter();
function lint(code: string) {
  return linter.verify(code, [{
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin, takt: catchLintPlugin },
    rules: catchRules,
  }], { filename: 'sample.ts' });
}

describe('catch log includes error rule', () => {
  it.each([
    "try { run(); } catch { log.debug('cleanup failed'); }",
    "try { run(); } catch { log.info('prefetch failed, continuing', { branch }); }",
    "try { run(); } catch (err) { log.info('prefetch failed, continuing', { branch }); }",
    "try { run(); } catch { log.debug('cleanup failed', { tempRef }); }",
    "try { run(); } catch (err) { log.error('failed', { error: 'static text' }); }",
    "try { run(); } catch (err) { log.error('failed'); return { success: false }; }",
    "try { run(); } catch { const errorMessage = 'extraction failed'; log.error('failed after creation', { error: errorMessage, url }); }",
    "try { run(); } catch (err) { const errorMessage = 'static'; log.error(errorMessage); }",
    "try { run(); } catch (err) { if (debug) return err; log.error('lost'); }",
    "try { run(); } catch (err) { if (recoverable) return err; log.error('failed'); return false; }",
    "try { run(); } catch (err) { if (debug) throw err; log.error('lost'); }",
    "try { run(); } catch (err) { if (debug) { log.error('lost'); return err; } }",
    "try { run(); } catch (err) { log.error('failed'); const message = getErrorMessage(err); }",
    "try { run(); } catch (err) { let detail = String(err); detail = 'failed'; log.error(detail); }",
    "try { run(); } catch (err) { let message = 'static'; const detail = message; message = String(err); log.error(detail); }",
    "try { run(); } catch (err) { let detail = 'static'; if (debug) detail = String(err); log.error(detail); }",
    "try { run(); } catch (err) { log.error('failed'); if (recoverable) return false; throw err; }",
    "try { run(); } catch (err) { let detail = 'static'; { const detail = String(err); } log.error(detail); }",
    "try { run(); } catch (err) { let message = String(err); if (retry) message = 'retrying'; log.error(message); }",
    "try { run(); } catch (err) { let detail = 'static'; for (let i = 0; i < 1; detail = String(err)) { log.error(detail); break; } }",
    "try { run(); } catch (err) { log.error('failed'); try { cleanup(); } catch (inner) { return false; } throw err; }",
    "try { run(); } catch (err) { const detail = debug ? String(err) : 'static'; log.error(detail); }",
    "try { run(); } catch (err) { err = 'static'; log.error(err); }",
    "try { run(); } catch (err) { log.error('failed', { error: verbose ? err : 'redacted' }); }",
    "try { run(); } catch (err) { let msg = ''; if (flag) { msg = String(err); } else { msg = 'static'; } log.error(msg); }",
    "try { run(); } catch (err) { let message = String(err); if (retry) message = 'retrying'; if (debug) log.error(message); }",
    "try { run(); } catch (err) { let message = String(err); message &&= 'failed'; log.error(message); }",
    "try { run(); } catch (err) { let message = ''; message ||= String(err); log.error(message); }",
    "try { run(); } catch (err) { let detail; [detail] = ['static', err]; log.error(detail); }",
    "try { run(); } catch (err) { const { a } = { a: 'static', b: err }; log.error(a); }",
    "try { run(); } catch (err) { let m = String(err); try { cleanup(); } catch { m = 'static'; } log.error(m); }",
    "while (retrying) { try { run(); } catch (err) { log.error('failed'); if (retry) continue; throw err; } }",
    "try { run(); } catch (err) { let m = 'static'; if (a) { if (b) m = String(err); } else { m = String(err); } log.error(m); }",
    "try { run(); } catch (err) { log.error({ error: 'static' } satisfies { error: unknown }); }",
    "try { run(); } catch (err) { let message = String(err); log.error('failed'); try { message = 'static'; cleanup(); } catch { return message; } throw err; }",
    "try { run(); } catch (err) { let message = String(err); for (let i = 0; i < 2; i++) { log.error(message); message = 'static'; } }",
  ])('rejects a catch log call that drops the caught error: %s', (code) => {
    const messages = lint(code);
    expect(messages.some((message) => message.fatal)).toBe(false);
    expect(messages.filter((message) => message.severity === 2).length).toBeGreaterThan(0);
  });

  it.each([
    "try { run(); } catch (err) { log.error('failed', { error: getErrorMessage(err) }); }",
    "try { run(); } catch (err) { log.error('failed', { error: err }); }",
    "try { run(); } catch (err) { const errorMessage = getErrorMessage(err); log.error('failed', { error: errorMessage }); }",
    "try { run(); } catch (err) { const message = getErrorMessage(err); log.error('failed', { error: message }); }",
    "try { run(); } catch (err) { const message = String(err); const safe = sanitizeSensitiveText(message); log.warn('failed', { message: safe }); }",
    "try { run(); } catch (err) { if (isAbort(err)) { throw err; } log.info('continuing', { error: getErrorMessage(err) }); }",
    "try { run(); } catch (err) { throw err; }",
    "try { run(); } catch { /* best-effort cleanup */ }",
    "try { run(); } catch (err) { return { success: false, error: getErrorMessage(err) }; }",
    "try { run(); } catch (err) { const errorMessage = getErrorMessage(err); log.error('failed', { outcome: 'failed' }); return { success: false, message: `Failed: ${errorMessage}` }; }",
    "try { run(); } catch (err) { log.warn('failed'); throw err; }",
    "try { run(); } catch (err) { try { cleanup(); } catch (cleanupErr) { log.debug(cleanupErr); } }",
    "try { run(); } catch (err) { lastError = err instanceof Error ? err.message : String(err); log.info('retrying', { error: lastError }); }",
    "try { run(); } catch (err) { let detail = String(err); detail = detail + '!'; log.error(detail); }",
    "try { run(); } catch (err) { const message = String(err); const detail = message; log.error(detail); }",
    "try { run(); } catch (err) { let detail = 'static'; if (debug) { detail = String(err); log.error(detail); } }",
    "try { run(); } catch (err) { log.error('failed'); if (must) throw err; return getErrorMessage(err); }",
    "try { run(); } catch (err) { { const detail = String(err); log.error(detail); } }",
    "try { run(); } catch (err) { let message = String(err); if (retry) message = getErrorMessage(err); log.error(message); }",
    "try { run(); } catch (err) { let message = String(err); message += ' (retrying)'; log.error(message); }",
    "try { run(); } catch (err) { if (err instanceof Error) { const { message } = err; log.error(message); } }",
    "try { run(); } catch (err) { log.error('failed'); try { cleanup(); } catch (inner) { throw err; } throw err; }",
    "try { run(); } catch (err) { const detail = debug ? String(err) : err.message; log.error(detail); }",
    "try { run(); } catch (err) { const m = String(err); err = 'static'; log.error(m); }",
    "try { run(); } catch (err) { log.error('failed', { error: verbose ? getErrorMessage(err) : err.message }); }",
    "try { run(); } catch (err) { let msg = ''; if (flag) { msg = String(err); } else { msg = err.message; } log.error(msg); }",
    "try { run(); } catch (err) { let message = String(err); message &&= err.message; log.error(message); }",
    "try { run(); } catch (err) { let detail; [detail] = [String(err)]; log.error(detail); }",
    "try { run(); } catch (err) { log.error('failed'); try { cleanup(); } catch (inner) { const detail = String(err); throw detail; } throw err; }",
    "try { run(); } catch (err) { log.error('failed'); while (retry) { break; } throw err; }",
    "try { run(); } catch (err) { let msg = ''; if (flag) { const detail = String(err); msg = detail; } else { msg = String(err); } log.error(msg); }",
    "try { run(); } catch (err) { log.error({ error: err } satisfies { error: unknown }); }",
    "try { run(); } catch (err) { let source = String(err); let message; if (flag) { message = source; source = 'cleared'; } else { message = String(err); } log.error(message, { source }); }",
    "try { run(); } catch (err) { const [prefix, ...details] = ['failed', 'context', String(err)]; log.error(prefix, details); }",
  ])('accepts code that surfaces or deliberately handles the error: %s', (code) => {
    const messages = lint(code);
    expect(messages.some((message) => message.fatal)).toBe(false);
    expect(messages.filter((message) => message.severity === 2)).toEqual([]);
  });

  it('reports only the outer log call when a nested catch handles its own error', () => {
    const messages = lint(
      "try { run(); } catch (err) { log.error('outer lost'); try { cleanup(); } catch (cleanupErr) { log.debug(cleanupErr); } }",
    );
    expect(messages.some((message) => message.fatal)).toBe(false);
    expect(messages.filter((message) => message.severity === 2).length).toBe(1);
  });
});
