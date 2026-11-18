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
    "try { run(); } catch { const errorMessage = 'extraction failed'; log.error('failed after creation', { error: errorMessage, url }); }",
    "try { run(); } catch (err) { if (isAbort(err)) { throw err; } log.info('continuing', { error: getErrorMessage(err) }); }",
    "try { run(); } catch (err) { throw err; }",
    "try { run(); } catch { /* best-effort cleanup */ }",
    "try { run(); } catch (err) { return { success: false, error: getErrorMessage(err) }; }",
    "try { run(); } catch (err) { const errorMessage = getErrorMessage(err); log.error('failed', { outcome: 'failed' }); return { success: false, message: `Failed: ${errorMessage}` }; }",
  ])('accepts code that surfaces or deliberately handles the error: %s', (code) => {
    const messages = lint(code);
    expect(messages.some((message) => message.fatal)).toBe(false);
    expect(messages.filter((message) => message.severity === 2)).toEqual([]);
  });
});
