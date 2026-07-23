import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import type { WorkflowConfig } from '../core/models/index.js';
import {
  buildWorkflowResumePointEntry,
  getWorkflowReference,
  workflowEntryMatchesWorkflow,
} from '../core/workflow/workflow-reference.js';
import { getWorkflowOpaqueRef } from '../core/workflow/reviewer-anomaly-capability.js';
import { trimResumePointStackForWorkflow } from '../core/workflow/run/resume-point.js';

const tempDirs = new Set<string>();

function createProjectDir(): string {
  const projectDir = join(tmpdir(), `takt-workflow-ref-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(projectDir, { recursive: true });
  tempDirs.add(projectDir);
  return projectDir;
}

function loadTestWorkflow(
  projectDir: string,
  relativePath: string,
  yaml: string,
): WorkflowConfig {
  const workflowPath = join(projectDir, relativePath);
  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(workflowPath, yaml, 'utf-8');
  return loadWorkflowFromFile(workflowPath, projectDir);
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('workflow-reference', () => {
  it('core は非公開 metadata の opaque ref で resume_point を解決する', () => {
    const projectDir = createProjectDir();
    const workflow = loadTestWorkflow(
      projectDir,
      '.takt/workflows/shared-workflow.yaml',
      `name: shared/workflow
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`,
    );
    const workflowRef = getWorkflowReference(workflow);
    const resumePoint = {
      version: 1 as const,
      stack: [
        {
          workflow: 'shared/workflow',
          workflow_ref: workflowRef,
          step: 'review',
          kind: 'agent' as const,
        },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };

    expect(workflowEntryMatchesWorkflow(resumePoint.stack[0]!, workflow)).toBe(true);
    expect(workflowRef).toMatch(/^project:sha256:[0-9a-f]{64}$/);
    expect(
      trimResumePointStackForWorkflow({
        workflow,
        resumePoint,
        resolveWorkflowCall: () => null,
      }),
    ).toEqual(resumePoint);
  });

  it('child workflow の resume_point は親 workflow_call prefix が一致するときだけ引き継ぐ', () => {
    const projectDir = createProjectDir();
    const parentWorkflow = loadTestWorkflow(
      projectDir,
      '.takt/workflows/default.yaml',
      `name: default
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
`,
    );
    const childWorkflow = loadTestWorkflow(
      projectDir,
      '.takt/workflows/coding.yaml',
      `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`,
    );
    const resumePoint = {
      version: 1 as const,
      stack: [
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call'),
        buildWorkflowResumePointEntry(childWorkflow, 'review', 'agent'),
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };

    expect(trimResumePointStackForWorkflow({
      workflow: childWorkflow,
      resumePoint,
      resumeStackPrefix: [buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call')],
      resolveWorkflowCall: () => null,
    })).toEqual(resumePoint);
  });

  it('child workflow の resume_point は親 workflow_call prefix の workflow_ref が違えば適用しない', () => {
    const projectDir = createProjectDir();
    const parentYaml = `name: default
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
`;
    const parentWorkflow = loadTestWorkflow(
      projectDir,
      '.takt/workflows/default-a.yaml',
      parentYaml,
    );
    const otherParentWorkflow = loadTestWorkflow(
      projectDir,
      '.takt/workflows/default-b.yaml',
      parentYaml,
    );
    const childWorkflow = loadTestWorkflow(
      projectDir,
      '.takt/workflows/coding.yaml',
      `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`,
    );
    const resumePoint = {
      version: 1 as const,
      stack: [
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call'),
        buildWorkflowResumePointEntry(childWorkflow, 'review', 'agent'),
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };

    expect(trimResumePointStackForWorkflow({
      workflow: childWorkflow,
      resumePoint,
      resumeStackPrefix: [buildWorkflowResumePointEntry(otherParentWorkflow, 'delegate', 'workflow_call')],
      resolveWorkflowCall: () => null,
    })).toBeUndefined();
  });

  it('loader は workflow_ref に絶対パスではなく opaque ID を設定する', () => {
    const projectDir = createProjectDir();
    const workflowPath = join(projectDir, '.takt', 'workflows', 'child.yaml');
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, `name: child
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const entry = buildWorkflowResumePointEntry(workflow, 'review', 'agent');
    const workflowRef = getWorkflowReference(workflow);

    expect((workflow as Record<string, unknown>).workflowRef).toBeUndefined();
    expect(workflowRef).toMatch(/^project:sha256:[0-9a-f]{64}$/);
    expect(workflowRef).not.toContain(workflowPath);
    expect(entry.workflow_ref).toBe(workflowRef);
  });

  it.each([
    {
      label: 'nested object',
      mutate: (workflow: WorkflowConfig) => {
        workflow.steps[0]!.rules![0]!.next = 'ABORT';
      },
    },
    {
      label: 'steps array',
      mutate: (workflow: WorkflowConfig) => {
        workflow.steps.push({
          name: 'injected',
          persona: 'reviewer',
          personaDisplayName: 'Reviewer',
          instruction: 'Review',
          rules: [],
        });
      },
    },
  ])('opaque ref 発行後の $label 変更を参照 API が拒否する', ({ mutate }) => {
    const projectDir = createProjectDir();
    const workflow = loadTestWorkflow(
      projectDir,
      '.takt/workflows/mutable.yaml',
      `name: mutable
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`,
    );

    mutate(workflow);

    expect(() => getWorkflowOpaqueRef(workflow))
      .toThrow(/workflow content changed after issuance/);
    expect(() => getWorkflowReference(workflow))
      .toThrow(/workflow content changed after issuance/);
  });
});
