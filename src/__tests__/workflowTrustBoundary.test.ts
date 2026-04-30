import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as workflowTrustBoundary from '../infra/config/loaders/workflowTrustBoundary.js';
import { loadWorkflowByIdentifier } from '../infra/config/index.js';
import { attachWorkflowTrustInfo } from '../infra/config/loaders/workflowSourceMetadata.js';

describe('workflowTrustBoundary', () => {
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

  it('should keep project path helper private', () => {
    expect(workflowTrustBoundary).not.toHaveProperty('isProjectWorkflowPath');
  });

  it('should keep workflow_call named lookup policy private', () => {
    expect(workflowTrustBoundary).not.toHaveProperty('getWorkflowCallNamedLookupSources');
  });

  it('should keep load-time project workflow trust boundary private', () => {
    expect(workflowTrustBoundary).not.toHaveProperty('validateProjectWorkflowTrustBoundary');
    expect(workflowTrustBoundary).not.toHaveProperty('validateProjectWorkflowTrustBoundaryForSteps');
  });

  it('rejects privileged child when project parent is outside workflows root', () => {
    const childWorkflowPath = join(projectDir, '.takt', 'workflows', 'privileged-child.yaml');
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    writeFileSync(childWorkflowPath, `name: privileged-child
subworkflow:
  callable: true
initial_step: route_context
max_steps: 3
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`, 'utf-8');

    const childWorkflow = loadWorkflowByIdentifier('privileged-child', projectDir);
    expect(childWorkflow).not.toBeNull();

    expect(() => workflowTrustBoundary.validateWorkflowCallTrustBoundary(
      {
        source: 'project',
        sourcePath: join(projectDir, 'outside-parent.yaml'),
        isProjectTrustRoot: true,
        isProjectWorkflowRoot: false,
      },
      childWorkflow!,
      'delegate',
      projectDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "privileged-child" across trust boundary',
    );
  });

  it('rejects runtime.prepare child when non-project parent calls project workflow root child', () => {
    const childWorkflow = attachWorkflowTrustInfo({
      name: 'project-child',
      subworkflow: { callable: true },
      runtime: {
        prepare: ['node'],
      },
      steps: [
        {
          name: 'review',
          kind: 'agent',
          persona: 'reviewer',
          personaDisplayName: 'reviewer',
          instruction: 'Review the task',
          passPreviousResponse: true,
        },
      ],
      initialStep: 'review',
      maxSteps: 3,
    }, {
      source: 'project',
      sourcePath: join(projectDir, '.takt', 'workflows', 'project-child.yaml'),
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: true,
    });

    expect(() => workflowTrustBoundary.validateWorkflowCallTrustBoundary(
      {
        source: 'external',
        sourcePath: join(externalDir, 'external-parent.yaml'),
        isProjectTrustRoot: false,
        isProjectWorkflowRoot: false,
      },
      childWorkflow,
      'delegate',
      projectDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "project-child" across trust boundary',
    );
  });

  it('rejects runtime.prepare child loaded through parser when worktree parent crosses trust boundary', () => {
    const worktreeDir = join(projectDir, '.takt', 'worktrees', 'feature-branch');
    const childWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'project-child.yaml');
    mkdirSync(join(worktreeDir, '.takt', 'workflows'), { recursive: true });
    writeFileSync(childWorkflowPath, `name: project-child
subworkflow:
  callable: true
workflow_config:
  runtime:
    prepare:
      - node
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review the task
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const childWorkflow = loadWorkflowByIdentifier('./.takt/workflows/project-child.yaml', projectDir, { lookupCwd: worktreeDir });
    expect(childWorkflow).not.toBeNull();

    expect(() => workflowTrustBoundary.validateWorkflowCallTrustBoundary(
      {
        source: 'project',
        sourcePath: join(projectDir, '.takt', 'workflows', 'parent.yaml'),
        isProjectTrustRoot: true,
        isProjectWorkflowRoot: true,
      },
      childWorkflow!,
      'delegate',
      projectDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "project-child" across trust boundary',
    );
  });

  it('rejects runtime.prepare child when project workflow root parent calls external child', () => {
    const childWorkflow = attachWorkflowTrustInfo({
      name: 'external-child',
      subworkflow: { callable: true },
      runtime: {
        prepare: ['node'],
      },
      steps: [
        {
          name: 'review',
          kind: 'agent',
          persona: 'reviewer',
          personaDisplayName: 'reviewer',
          instruction: 'Review the task',
          passPreviousResponse: true,
        },
      ],
      initialStep: 'review',
      maxSteps: 3,
    }, {
      source: 'external',
      sourcePath: join(externalDir, 'external-child.yaml'),
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });

    expect(() => workflowTrustBoundary.validateWorkflowCallTrustBoundary(
      {
        source: 'project',
        sourcePath: join(projectDir, '.takt', 'workflows', 'parent.yaml'),
        isProjectTrustRoot: true,
        isProjectWorkflowRoot: true,
      },
      childWorkflow,
      'delegate',
      projectDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "external-child" across trust boundary',
    );
  });

  it('rejects child workflow with allow_git_commit in parallel sub-step across trust boundary', () => {
    const childWorkflow = attachWorkflowTrustInfo({
      name: 'external-child',
      subworkflow: { callable: true },
      steps: [
        {
          name: 'review',
          kind: 'agent',
          persona: 'reviewer',
          personaDisplayName: 'reviewer',
          instruction: 'Review the task',
          passPreviousResponse: true,
          parallel: [
            {
              name: 'commit-worker',
              kind: 'agent',
              persona: 'reviewer',
              personaDisplayName: 'reviewer',
              instruction: 'Commit the result',
              allowGitCommit: true,
              passPreviousResponse: false,
            },
          ],
        },
      ],
      initialStep: 'review',
      maxSteps: 3,
    }, {
      source: 'external',
      sourcePath: join(externalDir, 'external-child.yaml'),
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });

    expect(() => workflowTrustBoundary.validateWorkflowCallTrustBoundary(
      {
        source: 'project',
        sourcePath: join(projectDir, '.takt', 'workflows', 'parent.yaml'),
        isProjectTrustRoot: true,
        isProjectWorkflowRoot: true,
      },
      childWorkflow,
      'delegate',
      projectDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "external-child" across trust boundary',
    );
  });
});
