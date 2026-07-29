import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowEngine } from '../core/workflow/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import {
  captureConfigErrorMessage,
  isolateStepFragmentTestConfig,
  writeStepFragmentTestFile as write,
} from './helpers/step-fragment-test-helpers.js';

function validate(path: string, projectDir: string): string {
  return captureConfigErrorMessage(() => {
    new WorkflowEngine(loadWorkflowFromFile(path, projectDir), projectDir, 'test task', {
      projectCwd: projectDir,
    });
  });
}

describe('workflow step fragment validator provenance', () => {
  let projectDir: string;
  let restoreConfig: () => void;

  beforeEach(() => {
    restoreConfig = isolateStepFragmentTestConfig('takt-step-validator-provenance-config-');
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-validator-provenance-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    restoreConfig();
  });

  it('attributes an aggregate rule placement error to the fragment that provides the invalid rule', () => {
    const rulePath = write(projectDir, '.takt/steps/rules.yaml', [
      'instruction: review',
      'rules:',
      '  - condition: all("approved")',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    write(projectDir, '.takt/steps/outer.yaml', 'uses: rules\npersona: reviewer\n');
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - uses: outer',
      '    name: review',
      '',
    ].join('\n'));

    const message = validate(workflowPath, projectDir);

    expect(message).toContain('aggregate conditions');
    expect(message).toContain('step fragment "rules"');
    expect(message).toContain(rulePath);
    expect(message).not.toContain('step fragment "outer"');
  });

  it.each([
    {
      name: 'top-level step',
      step: '  - uses: outer\n    name: review',
      fragment: 'instruction: review\nrules:\n  - condition: approved\n    appendix: first\n    next: COMPLETE\n  - condition: approved\n    appendix: second\n    next: COMPLETE\n',
    },
    {
      name: 'parallel sub-step',
      step: '  - name: reviewers\n    parallel:\n      - uses: outer\n        name: review',
      fragment: 'instruction: review\nrules:\n  - condition: approved\n    appendix: first\n    next: COMPLETE\n  - condition: approved\n    appendix: second\n    next: COMPLETE\n',
    },
  ])('attributes a semantic appendix conflict in a $name to the fragment rule', ({ step, fragment }) => {
    const rulePath = write(projectDir, '.takt/steps/rules.yaml', fragment);
    write(projectDir, '.takt/steps/outer.yaml', 'uses: rules\npersona: reviewer\n');
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      step,
      '',
    ].join('\n'));

    const message = validate(workflowPath, projectDir);

    expect(message).toContain('Rules sharing semantic label "approved" must use the same appendix');
    expect(message).toContain('step fragment "rules"');
    expect(message).toContain(rulePath);
    expect(message).not.toContain('step fragment "outer"');
  });

  it.each([
    {
      name: 'top-level step',
      initialStep: 'review',
      step: '  - uses: review\n    name: review\n    rules:\n      - condition: all("approved")\n        next: COMPLETE',
    },
    {
      name: 'parallel sub-step',
      initialStep: 'reviewers',
      step: '  - name: reviewers\n    parallel:\n      - uses: review\n        name: review\n        rules:\n          - condition: all("approved")\n            next: COMPLETE',
    },
  ])('retains fragment context while identifying a caller rule override as workflow-defined in a $name', ({ initialStep, step }) => {
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'rules:',
      '  - condition: approved',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      `initial_step: ${initialStep}`,
      'max_steps: 1',
      'steps:',
      step,
      '',
    ].join('\n'));

    const message = validate(workflowPath, projectDir);

    expect(message).toContain('aggregate conditions');
    expect(message).toContain(workflowPath);
    expect(message).toContain('step uses fragment "review"');
    expect(message).toContain(fragmentPath);
    expect(message).toContain('defined by the workflow');
  });
});
