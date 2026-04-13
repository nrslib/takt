import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as workflowCallResolver from '../infra/config/loaders/workflowCallResolver.js';
import * as workflowLoader from '../infra/config/loaders/workflowLoader.js';
import * as workflowResolver from '../infra/config/loaders/workflowResolver.js';
import { getWorkflowSourcePath } from '../infra/config/loaders/workflowSourceMetadata.js';
import { getWorkflowTrustInfo } from '../infra/config/loaders/workflowTrustSource.js';

describe('workflowCallResolver module boundary', () => {
  let projectDir: string;
  let externalDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-project-'));
    externalDir = mkdtempSync(join(tmpdir(), 'takt-external-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  });

  it('keeps workflow_call resolution in the dedicated module while workflowLoader re-exports it', () => {
    expect(workflowResolver).not.toHaveProperty('resolveWorkflowCallTarget');
    expect(workflowCallResolver).toHaveProperty('resolveWorkflowCallTarget');
    expect(workflowLoader.resolveWorkflowCallTarget).toBe(workflowCallResolver.resolveWorkflowCallTarget);
  });

  it('prefers parent workflow metadata over fallback context for nested relative workflow_call resolution', () => {
    const rootWorkflowPath = join(externalDir, 'root.yaml');
    const childWorkflowPath = join(externalDir, 'child', 'child.yaml');
    const nestedWorkflowPath = join(externalDir, 'child', 'nested.yaml');
    const wrongNestedWorkflowPath = join(externalDir, 'nested.yaml');

    mkdirSync(dirname(childWorkflowPath), { recursive: true });

    writeFileSync(rootWorkflowPath, `name: external-root
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child/child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(childWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: delegate_nested
max_steps: 3
steps:
  - name: delegate_nested
    kind: workflow_call
    call: ./nested.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(nestedWorkflowPath, `name: nested-child
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: nested-reviewer
    instruction: "Nested child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeFileSync(wrongNestedWorkflowPath, `name: wrong-nested-child
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: wrong-reviewer
    instruction: "Wrong nested child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const rootWorkflow = workflowLoader.loadWorkflowByIdentifier(rootWorkflowPath, projectDir);
    expect(rootWorkflow).not.toBeNull();

    const childWorkflow = workflowLoader.loadWorkflowByIdentifier(childWorkflowPath, projectDir);
    expect(childWorkflow).not.toBeNull();
    expect(getWorkflowSourcePath(childWorkflow!)).toBe(childWorkflowPath);

    const resolvedNestedWorkflow = workflowCallResolver.resolveWorkflowCallTarget(
      childWorkflow!,
      './nested.yaml',
      'delegate_nested',
      projectDir,
      projectDir,
      {
        sourcePath: getWorkflowSourcePath(rootWorkflow!)!,
        trustInfo: getWorkflowTrustInfo(rootWorkflow!, projectDir),
      },
    );

    expect(resolvedNestedWorkflow).not.toBeNull();
    expect(resolvedNestedWorkflow?.name).toBe('nested-child');
  });
});
