/**
 * Behavior gate: the plan's pinned contracts hold after the fix — validation
 * rejects empty provider names, CLI override behavior is preserved, the
 * session honors env overrides with cli > env > config precedence, the
 * summary and renderer report effective values with the pinned signatures,
 * the CLI entry wires one override set to both surfaces, and the fixture
 * test suite passes.
 */
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { loadModule, workDir, fail, pass } from './fix-self-scan-lib.mjs';

// Fresh object per check so a module that mutates its input cannot
// contaminate later probes.
const baseConfig = () => ({ provider: 'alpha', model: 'alpha-large' });

export default async function assertPlannedBehavior() {
  const problems = [];
  const check = (label, actual, expected) => {
    if (!isDeepStrictEqual(actual, expected)) {
      problems.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  try {
    const { validateProviderName } = await loadModule('src/core/validate.js');
    check('empty provider rejected', validateProviderName(''), {
      ok: false,
      reason: 'provider must be a non-empty string',
    });
    check('whitespace provider rejected', validateProviderName('   ').ok, false);
    check('plain provider accepted', validateProviderName('alpha'), { ok: true });

    const { applyCliOverride } = await loadModule('src/app/override.js');
    const pair = (result) => [result.provider, result.model];
    check('cli passthrough', pair(applyCliOverride(baseConfig(), {})), ['alpha', 'alpha-large']);
    check('cli provider switch discards model', pair(applyCliOverride(baseConfig(), { provider: 'beta' })), [
      'beta',
      undefined,
    ]);
    check('same-provider override keeps the model', pair(applyCliOverride(baseConfig(), { provider: 'alpha' })), [
      'alpha',
      'alpha-large',
    ]);
    check('blank cli flag is absent', pair(applyCliOverride(baseConfig(), { provider: '  ' })), [
      'alpha',
      'alpha-large',
    ]);

    const { initSession } = await loadModule('src/app/session.js');
    const envOnly = initSession(baseConfig(), {}, { provider: 'beta' });
    check('env-only override applies and discards model', [envOnly.provider, envOnly.model], ['beta', undefined]);
    const cliBeatsEnv = initSession(baseConfig(), { provider: 'gamma', model: 'gamma-mini' }, { provider: 'beta' });
    check('cli beats env', [cliBeatsEnv.provider, cliBeatsEnv.model], ['gamma', 'gamma-mini']);
    check('resumable preserved', envOnly.resumable, true);

    const { buildRunSummary } = await loadModule('src/core/summary.js');
    const summary = buildRunSummary(baseConfig(), { env: { provider: 'beta' }, cli: {} }, [
      { key: 'provider', origin: 'env' },
      { key: 'model', origin: 'default' },
    ]);
    check('summary effective provider', [summary.provider, summary.model], ['beta', undefined]);
    check(
      'summary labels',
      summary.sources,
      [
        { key: 'provider', label: 'override' },
        { key: 'model', label: 'default' },
      ],
    );

    const { renderSummary } = await loadModule('src/app/render.js');
    const rendered = renderSummary(baseConfig(), { env: {}, cli: { model: 'alpha-mini' } }, [
      { key: 'provider', origin: 'global' },
    ]);
    check('rendered lines', rendered.split('\n'), [
      'provider: alpha (model: alpha-mini)',
      'provider: global',
    ]);

    const { runCli } = await loadModule('src/cli/main.js');
    const cliResult = runCli(baseConfig(), { provider: ' beta ' }, [{ key: 'provider', origin: 'cli' }], {});
    check('cli wiring: session sees the flag', cliResult.session.provider, 'beta');
    check('cli wiring: summary first line matches the session', cliResult.summaryText.split('\n')[0], 'provider: beta');
  } catch (error) {
    return fail(`planned contract could not be exercised: ${error.message}`);
  }

  const tests = spawnSync('npm', ['test'], { cwd: workDir, encoding: 'utf8', timeout: 120_000 });
  if (tests.status !== 0) {
    problems.push(`fixture test suite failed:\n${(tests.stdout ?? '') + (tests.stderr ?? '')}`.slice(0, 1500));
  }

  if (problems.length > 0) {
    return fail(problems.join('\n'));
  }
  return pass('pinned contracts hold and the fixture test suite passes');
}
