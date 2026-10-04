import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectConfig } from '../infra/config/project/projectConfig.js';
import { getProjectConfigDir } from '../infra/config/paths.js';
import { resolveTaskSpecForExecution } from '../features/tasks/execute/taskSpecContext.js';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';

const temporaryRoots = new Set<string>();
let taktEnvSnapshot: TaktEnvSnapshot;

beforeEach(() => {
  taktEnvSnapshot = clearTaktEnv();
});

afterEach(() => {
  restoreTaktEnv(taktEnvSnapshot);
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

/** Create and track an isolated project with a config directory for removed-runtime-option tests. */
function createTempProjectDir(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-deepseek-runtime-mode-test-'));
  temporaryRoots.add(projectDir);
  fs.mkdirSync(getProjectConfigDir(projectDir), { recursive: true });
  return projectDir;
}

/** Write the supplied YAML project config into the fixture config directory. */
function writeProjectConfig(projectDir: string, content: string): void {
  fs.writeFileSync(path.join(getProjectConfigDir(projectDir), 'config.yaml'), content, 'utf-8');
}

describe('DeepSeek runtime_mode input classification', () => {
  it('rejects an unquoted runtime_mode key in project provider options', () => {
    const projectDir = createTempProjectDir();
    writeProjectConfig(projectDir, [
      'provider_options:',
      '  deepseek_harness:',
      '    runtime_mode: node',
    ].join('\n'));

    expect(() => loadProjectConfig(projectDir)).toThrow(/runtime_mode/iu);
  });

  it('rejects a quoted runtime_mode key in project provider options', () => {
    const projectDir = createTempProjectDir();
    writeProjectConfig(projectDir, [
      'provider_options:',
      '  deepseek_harness:',
      '    "runtime_mode": node',
    ].join('\n'));

    expect(() => loadProjectConfig(projectDir)).toThrow(/runtime_mode/iu);
  });

  it('keeps runtime_mode examples in task content separate from project provider settings', () => {
    const projectDir = createTempProjectDir();
    const taskDir = '.takt/tasks/runtime-mode-examples';
    const taskBody = [
      '# Task examples',
      '',
      '# TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_RUNTIME_MODE=node',
      '# runtime_mode: node',
      'The quoted example is "runtime_mode: node".',
      '',
      'literal: |',
      '  runtime_mode: node',
      'folded: >',
      '  runtime_mode: node',
      '',
      '```yaml',
      'runtime_mode: node',
      '```',
      '~~~yaml',
      'runtime_mode: node',
      '~~~',
      '```yaml',
      'runtime_mode: node',
    ].join('\n');
    fs.mkdirSync(path.join(projectDir, taskDir), { recursive: true });
    writeProjectConfig(projectDir, 'provider: deepseek-harness\n');
    fs.writeFileSync(path.join(projectDir, taskDir, 'order.md'), taskBody, 'utf-8');

    expect(loadProjectConfig(projectDir).provider).toBe('deepseek-harness');
    const taskSpec = resolveTaskSpecForExecution(
      projectDir,
      projectDir,
      taskDir,
      '20261002-runtime-mode-task-content',
    );
    expect(taskSpec.orderContent).toBe(taskBody);
  });
});
