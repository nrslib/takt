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
    "try { run(); } catch (err) { log.info('prefetch failed', { branch }); }",
    "try { run(); } catch (err) { const errorMessage = 'static'; log.error(errorMessage); }",
    "try { run(); } catch (err) { err = 'static'; log.error('failed'); }",
    "try { run(); } catch (err) { { const err = 'static'; consume(err); } log.error('failed'); }",
    "try { run(); } catch (err) { log.error('outer failed'); try { cleanup(); } catch (inner) { log.debug(inner); } }",
  ])('reports a direct log when the caught error is never read: %s', (code) => {
    expect(lint(code)).toEqual([
      expect.objectContaining({ ruleId: 'takt/catch-log-includes-error', messageId: 'missingError' }),
    ]);
  });

  it.each([
    "try { run(); } catch {}",
    "try { run(); } catch (err) { log.error('failed', { error: getErrorMessage(err) }); }",
    "try { run(); } catch (err) { log.warn('failed'); throw err; }",
    "function f() { try { run(); } catch (err) { log.warn('failed'); return err; } }",
    "try { run(); } catch ({ message }) { log.error(message); }",
    "try { run(); } catch (err) { let msg = err; for (msg of values) { log.error(msg); } }",
    "try { run(); } catch (err) { let msg; switch (kind) { case 1: msg = String(err); break; default: msg = err.message; } log.error(msg); }",
    "try { run(); } catch (err) { if (retry) log.warn('retrying'); }",
    "try { run(); } catch { try { cleanup(); } catch (inner) { log.debug(inner); } }",
  ])('leaves logs requiring data-flow analysis alone: %s', (code) => {
    expect(lint(code)).toEqual([]);
  });
});
