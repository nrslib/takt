import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import {
  buildWorkflowResumePointEntry,
  getWorkflowReference,
  workflowEntryMatchesWorkflow,
} from '../core/workflow/workflow-reference.js';
import { trimResumePointStackForWorkflow } from '../core/workflow/run/resume-point.js';

const tempDirs = new Set<string>();

function createProjectDir(): string {
  const projectDir = join(tmpdir(), `takt-workflow-ref-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(projectDir, { recursive: true });
  tempDirs.add(projectDir);
  return projectDir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('workflow-reference', () => {
  it('core は非公開 metadata の opaque ref で resume_point を解決する', () => {
    const workflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'shared/workflow',
      initial_step: 'review',
      max_steps: 3,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    }, '/tmp/project'), 'project:sha256:child-b');
    const resumePoint = {
      version: 2 as const,
      stack: [
        {
          workflow: 'shared/workflow',
          workflow_ref: 'project:sha256:child-b',
          step: 'review',
          kind: 'agent' as const,
          occurrence: 1,
        },
      ],
      iteration: 7,
      elapsed_ms: 183245,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };

    expect(workflowEntryMatchesWorkflow(resumePoint.stack[0]!, workflow)).toBe(true);
    expect(getWorkflowReference(workflow)).toBe('project:sha256:child-b');
    expect(
      trimResumePointStackForWorkflow({
        workflow,
        resumePoint,
        resolveWorkflowCall: () => null,
      }),
    ).toEqual(resumePoint);
  });

  it('child workflow の resume_point は親 workflow_call prefix が一致するときだけ引き継ぐ', () => {
    const parentWorkflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
        name: 'default',
        initial_step: 'delegate',
        max_steps: 3,
        steps: [
          {
            name: 'delegate',
            call: 'takt/coding',
            rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
          },
        ],
      }, '/tmp/project'), 'project:sha256:parent-a');
    const childWorkflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
        name: 'takt/coding',
        subworkflow: { callable: true },
        initial_step: 'review',
        max_steps: 3,
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review',
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
      }, '/tmp/project'), 'project:sha256:child-a');
    const resumePoint = {
      version: 2 as const,
      stack: [
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call', 1, undefined, 1),
        buildWorkflowResumePointEntry(childWorkflow, 'review', 'agent', 1),
      ],
      iteration: 7,
      elapsed_ms: 183245,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };

    expect(trimResumePointStackForWorkflow({
      workflow: childWorkflow,
      resumePoint,
      resumeStackPrefix: [
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call', 1, undefined, 1),
      ],
      resolveWorkflowCall: () => null,
    })).toEqual(resumePoint);
  });

  it('child workflow の resume_point は親 workflow_call prefix の workflow_ref が違えば適用しない', () => {
    const parentWorkflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
        name: 'default',
        initial_step: 'delegate',
        max_steps: 3,
        steps: [
          {
            name: 'delegate',
            call: 'takt/coding',
            rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
          },
        ],
      }, '/tmp/project'), 'project:sha256:parent-a');
    const otherParentWorkflow = attachWorkflowOpaqueRef({
      ...parentWorkflow,
    }, 'project:sha256:parent-b');
    const childWorkflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
        name: 'takt/coding',
        subworkflow: { callable: true },
        initial_step: 'review',
        max_steps: 3,
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review',
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
      }, '/tmp/project'), 'project:sha256:child-a');
    const resumePoint = {
      version: 2 as const,
      stack: [
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call', 1, undefined, 1),
        buildWorkflowResumePointEntry(childWorkflow, 'review', 'agent', 1),
      ],
      iteration: 7,
      elapsed_ms: 183245,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };

    expect(trimResumePointStackForWorkflow({
      workflow: childWorkflow,
      resumePoint,
      resumeStackPrefix: [
        buildWorkflowResumePointEntry(otherParentWorkflow, 'delegate', 'workflow_call', 1, undefined, 1),
      ],
      resolveWorkflowCall: () => null,
    })).toBeUndefined();
  });

  it('同じ workflow_ref の parallel 親が通常 agent に変わった場合は深い suffix も親 frame も受理しない', () => {
    const workflowRef = 'project:sha256:stable-path-ref';
    const sourceWorkflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'default',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [{
        name: 'reviewers',
        instruction: 'Run delegated reviews',
        parallel: [{
          name: 'delegate',
          call: 'child',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        }],
        rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
      }],
    }, '/tmp/project'), workflowRef);
    const currentWorkflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'default',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [{
        name: 'reviewers',
        persona: 'reviewer',
        instruction: 'Run a normal review',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, '/tmp/project'), workflowRef);
    const childWorkflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'child',
      subworkflow: { callable: true },
      initial_step: 'review',
      max_steps: 3,
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, '/tmp/project'), 'project:sha256:child');
    const resumePoint = {
      version: 1 as const,
      stack: [
        buildWorkflowResumePointEntry(sourceWorkflow, 'reviewers', 'parallel', 4),
        buildWorkflowResumePointEntry(sourceWorkflow, 'delegate', 'workflow_call', 2),
        buildWorkflowResumePointEntry(childWorkflow, 'review', 'agent', 1),
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };

    expect(trimResumePointStackForWorkflow({
      workflow: currentWorkflow,
      resumePoint,
      resolveWorkflowCall: () => childWorkflow,
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
    const entry = buildWorkflowResumePointEntry(workflow, 'review', 'agent', 1);
    const workflowRef = getWorkflowReference(workflow);

    expect((workflow as Record<string, unknown>).workflowRef).toBeUndefined();
    expect(workflowRef).toMatch(/^project:sha256:[0-9a-f]{64}$/);
    expect(workflowRef).not.toContain(workflowPath);
    expect(entry.workflow_ref).toBe(workflowRef);
  });
});
