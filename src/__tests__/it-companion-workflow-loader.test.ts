import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { inspectWorkflowFile } from '../infra/config/loaders/workflowDoctor.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

function workflowYaml(companionName: string): string {
  return [
    'name: companion-loader',
    'initial_step: implement',
    'max_steps: 4',
    'steps:',
    '  - name: implement',
    '    instruction: implement',
    `    companion: [${companionName}]`,
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '  - name: needs-fix',
    '    instruction: fix',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '',
  ].join('\n');
}

function callableWorkflowYaml(): string {
  return [
    'name: callable-companion-loader',
    'subworkflow:',
    '  callable: true',
    '  params:',
    '    implementation_companions:',
    '      type: companion_ref[]',
    'steps:',
    '  - name: implement',
    '    instruction: implement',
    '    companion:',
    '      $param: implementation_companions',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '  - name: needs-fix',
    '    instruction: fix',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '',
  ].join('\n');
}

describe('CT-COMP-02 workflow loader and doctor integration', () => {
  let root: string;
  let projectDir: string;
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-companion-workflow-loader-'));
    projectDir = join(root, 'project');
    configDir = join(root, 'user');
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = configDir;
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('should resolve and snapshot a project companion definition during workflow load', () => {
    const workflowPath = join(projectDir, '.takt', 'workflows', 'companion.yaml');
    const definitionPath = join(projectDir, '.takt', 'companions', 'security-reviewer.yaml');
    mkdirSync(join(projectDir, '.takt', 'companions'), { recursive: true });
    writeFileSync(workflowPath, workflowYaml('security-reviewer'), 'utf-8');
    writeFileSync(definitionPath, [
      'name: security-reviewer',
      'description: security review',
      'interval_ms: 15000',
      '',
    ].join('\n'), 'utf-8');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);

    expect(workflow.companions?.['security-reviewer']).toMatchObject({
      name: 'security-reviewer',
      description: 'security review',
      intervalMs: 15_000,
      sourcePath: definitionPath,
    });
    expect(workflow.companions?.['security-reviewer']?.instruction.length).toBeGreaterThan(0);
  });

  it('should fail workflow loading immediately for an undefined companion reference', () => {
    const workflowPath = join(projectDir, '.takt', 'workflows', 'missing.yaml');
    writeFileSync(workflowPath, workflowYaml('missing-reviewer'), 'utf-8');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir))
      .toThrow(/missing-reviewer/);
  });

  it('should fail callable workflow loading immediately for an undefined companion parameter value', () => {
    const workflowPath = join(projectDir, '.takt', 'workflows', 'missing-callable.yaml');
    writeFileSync(workflowPath, callableWorkflowYaml(), 'utf-8');

    expect(() => loadWorkflowFromFile(workflowPath, projectDir, {
      callableArgs: { implementation_companions: ['missing-reviewer'] },
    })).toThrow(/missing-reviewer/);
  });

  it('should report an undefined companion reference through workflow doctor', () => {
    const workflowPath = join(projectDir, '.takt', 'workflows', 'missing.yaml');
    writeFileSync(workflowPath, workflowYaml('missing-reviewer'), 'utf-8');

    const messages = inspectWorkflowFile(workflowPath, projectDir).diagnostics
      .map(({ message }) => message);

    expect(messages).toContainEqual(expect.stringMatching(/missing-reviewer/));
  });
});
