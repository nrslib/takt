import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const provider = process.env.TAKT_E2E_PROVIDER;
const providerEnabled = provider != null && provider !== 'mock';
const providerIt = providerEnabled ? it : it.skip;

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: runtime.prepare with provider', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    mkdirSync(join(repo.path, 'scripts'), { recursive: true });

    writeFileSync(
      join(repo.path, 'gradlew'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [ -z "${GRADLE_USER_HOME:-}" ]; then echo "GRADLE_USER_HOME is required"; exit 2; fi',
        'if [ -z "${TMPDIR:-}" ]; then echo "TMPDIR is required"; exit 3; fi',
        'mkdir -p "$GRADLE_USER_HOME"',
        'mkdir -p "$TMPDIR"',
        'echo "ok" > "$GRADLE_USER_HOME/gradle-ok.txt"',
        'echo "ok" > "$TMPDIR/gradle-tmp-ok.txt"',
        'echo "BUILD SUCCESSFUL"',
      ].join('\n'),
      'utf-8',
    );
    chmodSync(join(repo.path, 'gradlew'), 0o755);

    writeFileSync(
      join(repo.path, 'scripts/check-node-env.js'),
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const cache = process.env.npm_config_cache;",
        "if (!cache) { console.error('npm_config_cache is required'); process.exit(2); }",
        "fs.mkdirSync(cache, { recursive: true });",
        "fs.writeFileSync(path.join(cache, 'npm-ok.txt'), 'ok');",
        "console.log('node-env-ok');",
      ].join('\n'),
      'utf-8',
    );

    writeFileSync(
      join(repo.path, 'package.json'),
      JSON.stringify({
        name: 'runtime-e2e',
        private: true,
        version: '1.0.0',
        scripts: {
          test: 'node scripts/check-node-env.js',
        },
      }, null, 2),
      'utf-8',
    );

    writeFileSync(
      join(repo.path, 'runtime-e2e-piece.yaml'),
      [
        'name: runtime-e2e',
        'description: Runtime env injection verification piece',
        'max_movements: 3',
        'initial_movement: execute',
        'movements:',
        '  - name: execute',
        '    edit: false',
        '    persona: ../fixtures/agents/test-coder.md',
        '    allowed_tools:',
        '      - Read',
        '      - Bash',
        '    required_permission_mode: edit',
        '    instruction_template: |',
        '      {task}',
        '    rules:',
        '      - condition: Task completed',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  providerIt('should apply runtime.prepare from config.yaml during provider execution', () => {
    updateIsolatedConfig(isolatedEnv.taktDir, {
      runtime: {
        prepare: ['gradle', 'node'],
      },
    });

    const piecePath = join(repo.path, 'runtime-e2e-piece.yaml');
    const result = runTakt({
      args: [
        '--task',
        [
          'Run `./gradlew test` and `npm test` in the repository root.',
          'If both commands succeed, respond exactly with: Task completed',
        ].join(' '),
        '--piece', piecePath,
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const runtimeRoot = join(repo.path, '.runtime');
    const envFile = join(runtimeRoot, 'env.sh');
    expect(existsSync(runtimeRoot)).toBe(true);
    expect(existsSync(join(runtimeRoot, 'tmp'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'cache'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'config'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'state'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'gradle'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'npm'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'gradle', 'gradle-ok.txt'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'npm', 'npm-ok.txt'))).toBe(true);
    expect(existsSync(envFile)).toBe(true);

    const envContent = readFileSync(envFile, 'utf-8');
    expect(envContent).toContain('export TMPDIR=');
    expect(envContent).toContain('export GRADLE_USER_HOME=');
    expect(envContent).toContain('export npm_config_cache=');
  }, 240_000);

  providerIt('should reproduce missing runtime env failure when runtime.prepare is unset', () => {
    const piecePath = join(repo.path, 'runtime-e2e-piece.yaml');
    const result = runTakt({
      args: [
        '--task',
        [
          'Run `./gradlew test` and `npm test` in the repository root without setting or overriding environment variables.',
          'If both commands succeed, respond exactly with: Task completed',
        ].join(' '),
        '--piece', piecePath,
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    const combined = `${result.stdout}\n${result.stderr}`;

    expect(combined).toContain('GRADLE_USER_HOME is required');

    const runtimeRoot = join(repo.path, '.runtime');
    expect(existsSync(join(runtimeRoot, 'env.sh'))).toBe(false);
  }, 240_000);
});
