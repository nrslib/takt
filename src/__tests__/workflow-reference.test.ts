import { dirname, join } from 'node:path';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkflowFromFile, loadWorkflowFromFileForDiscovery } from '../infra/config/loaders/workflowFileLoader.js';
import { withResourcesDirOverride } from '../infra/resources/index.js';
import { resolveWorkflowTrustInfo } from '../infra/config/loaders/workflowTrustSource.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import {
  buildWorkflowResumePointEntry,
  buildWorkflowRestartPointEntry,
  getWorkflowReference,
  workflowEntriesMatch,
  workflowEntryMatchesWorkflow,
  workflowRestartEntryMatchesWorkflow,
} from '../core/workflow/workflow-reference.js';
import { trimResumePointStackForWorkflow } from '../core/workflow/run/resume-point.js';
import type { WorkflowConfig, WorkflowResumePoint, WorkflowStep } from '../core/models/types.js';

const tempDirs = new Set<string>();
const identityWorkflowYaml = [
  'name: default', 'initial_step: implement', 'steps:',
  '  - name: implement', '    instruction: Implement v1',
].join('\n');

function writeIdentityWorkflow(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

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
  it('uses the same canonical root for symlinked builtin installations', () => {
    const projectDir = createProjectDir();
    const root = join(projectDir, 'builtins');
    const linkedRoot = join(projectDir, 'linked-builtins');
    const relativePath = 'ja/workflows/default.yaml';
    writeIdentityWorkflow(join(root, relativePath), identityWorkflowYaml);
    symlinkSync(root, linkedRoot, 'dir');
    const original = withResourcesDirOverride(root, () => loadWorkflowFromFile(join(root, relativePath), projectDir));
    const linked = withResourcesDirOverride(linkedRoot, () => loadWorkflowFromFile(join(linkedRoot, relativePath), projectDir));

    expect(getWorkflowReference(linked)).toBe(getWorkflowReference(original));
  });

  it('does not use the facet resource root to identify a builtin workflow', () => {
    const projectDir = createProjectDir();
    const root = join(projectDir, 'builtins');
    const filePath = join(root, 'ja/workflows/default.yaml');
    writeIdentityWorkflow(filePath, identityWorkflowYaml);
    const refs = ['facets-a', 'facets-b'].map((directory) => withResourcesDirOverride(root, () => (
      getWorkflowReference(loadWorkflowFromFile(filePath, projectDir, { resourceRoot: join(projectDir, directory) }))
    )));

    expect(refs[0]).toBe(refs[1]);
  });

  it('rejects a builtin source outside the canonical builtin root', () => {
    const projectDir = createProjectDir();
    const root = join(projectDir, 'builtins');
    mkdirSync(root);
    const filePath = join(projectDir, 'outside', 'default.yaml');
    writeIdentityWorkflow(filePath, identityWorkflowYaml);
    const trustInfo = resolveWorkflowTrustInfo({ filePath, projectCwd: projectDir, source: 'builtin' });

    expect(() => withResourcesDirOverride(root, () => loadWorkflowFromFile(filePath, projectDir, { trustInfo }))).toThrow();
  });

  it.each([
    { mode: 'runtime', load: loadWorkflowFromFile },
    { mode: 'discovery', load: loadWorkflowFromFileForDiscovery },
  ])('should identify the same builtin across installation roots in $mode mode', ({ load }) => {
    const projectDir = createProjectDir();
    const refs = ['install-a', 'install-b'].map((installation) => {
      const root = join(projectDir, installation, 'builtins');
      const filePath = join(root, 'ja', 'workflows', 'default.yaml');
      writeIdentityWorkflow(filePath, identityWorkflowYaml);
      return withResourcesDirOverride(root, () => getWorkflowReference(load(filePath, projectDir)));
    });

    expect(refs[0]).toBe(refs[1]);
  });

  it.each(['en/workflows/default.yaml', 'ja/workflows/nested/default.yaml'])('should distinguish builtin logical locations from ja/workflows/default.yaml: %s', (otherPath) => {
    const projectDir = createProjectDir();
    const root = join(projectDir, 'builtins');
    const refs = ['ja/workflows/default.yaml', otherPath].map((relativePath) => {
      const filePath = join(root, relativePath);
      writeIdentityWorkflow(filePath, identityWorkflowYaml);
      return withResourcesDirOverride(root, () => getWorkflowReference(loadWorkflowFromFile(filePath, projectDir)));
    });

    expect(refs[0]).not.toBe(refs[1]);
  });

  it('should reject a builtin checkpoint after an instruction-only change at the same path', () => {
    const projectDir = createProjectDir();
    const root = join(projectDir, 'builtins');
    const filePath = join(root, 'ja', 'workflows', 'default.yaml');
    writeIdentityWorkflow(filePath, identityWorkflowYaml);
    const original = withResourcesDirOverride(root, () => loadWorkflowFromFile(filePath, projectDir));
    const resumePoint: WorkflowResumePoint = {
      version: 2, stack: [buildWorkflowResumePointEntry(original, 'implement', 'agent', 1)],
      iteration: 2, elapsed_ms: 100, workflow_call_invocations: {}, workflow_step_participations: {},
    };
    writeIdentityWorkflow(filePath, identityWorkflowYaml.replace('Implement v1', 'Implement v2'));
    const current = withResourcesDirOverride(root, () => loadWorkflowFromFile(filePath, projectDir));

    expect(workflowEntryMatchesWorkflow(resumePoint.stack[0]!, current)).toBe(false);
    expect(trimResumePointStackForWorkflow({ workflow: current, resumePoint, resolveWorkflowCall: () => null })).toBeUndefined();
  });

  it.each(['project', 'user'] as const)('should preserve the absolute-path identity for %s workflows across content changes', (source) => {
    const projectDir = createProjectDir();
    const filePath = source === 'project'
      ? join(projectDir, '.takt', 'workflows', 'default.yaml')
      : join(process.env.TAKT_CONFIG_DIR!, 'workflows', 'default.yaml');
    writeIdentityWorkflow(filePath, identityWorkflowYaml);
    const original = loadWorkflowFromFile(filePath, projectDir);
    writeIdentityWorkflow(filePath, identityWorkflowYaml.replace('Implement v1', 'Implement v2'));
    const current = loadWorkflowFromFile(filePath, projectDir);
    const expected = `${source}:sha256:${createHash('sha256').update(realpathSync(filePath)).digest('hex')}`;

    expect(getWorkflowReference(original)).toBe(expected);
    expect(getWorkflowReference(current)).toBe(expected);
  });

  it.each(['project', 'user'] as const)('should distinguish identical %s workflows at different absolute paths', (source) => {
    const projectDir = createProjectDir();
    const refs = ['root-a', 'root-b'].map((root) => {
      const filePath = join(projectDir, root, '.takt', 'workflows', 'default.yaml');
      writeIdentityWorkflow(filePath, identityWorkflowYaml);
      const trustInfo = resolveWorkflowTrustInfo({ filePath, projectCwd: projectDir, source });
      return getWorkflowReference(loadWorkflowFromFile(filePath, projectDir, { trustInfo }));
    });

    expect(refs[0]).not.toBe(refs[1]);
  });

  it('should retain terminal call shortening for callers that do not request callee validation', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'parent', initial_step: 'delegate', steps: [{ name: 'delegate', call: 'child' }],
    }, '/tmp/project');
    const point: WorkflowResumePoint = {
      version: 2,
      stack: [
        buildWorkflowResumePointEntry(workflow, 'delegate', 'workflow_call', 1, undefined, 1),
        { workflow: 'child', workflow_ref: 'child', step: 'removed', kind: 'agent', occurrence: 1 },
      ],
      iteration: 7, elapsed_ms: 100, workflow_call_invocations: {}, workflow_step_participations: {},
    };

    expect(trimResumePointStackForWorkflow({ workflow, resumePoint: point, resolveWorkflowCall: () => null }))
      .toEqual({ ...point, stack: [point.stack[0]!] });
    expect(trimResumePointStackForWorkflow({
      workflow, resumePoint: point, resolveWorkflowCall: () => null, validateTerminalWorkflowCall: true,
    })).toBeUndefined();
  });

  it.each(['agent', 'system', 'parallel'] as const)('should retain a terminal %s frame with callee validation enabled', (kind) => {
    const agent: WorkflowStep = { name: 'review', kind: 'agent', personaDisplayName: 'review', instruction: 'Review' };
    const step: WorkflowStep = kind === 'system'
      ? { name: 'review', kind, personaDisplayName: 'review', instruction: '', effects: [{ type: 'merge_pr', pr: 42 }] }
      : kind === 'parallel'
        ? { name: 'review', kind: 'agent', personaDisplayName: 'review', instruction: '', parallel: [{ ...agent, name: 'child' }] }
        : agent;
    const workflow: WorkflowConfig = { name: 'parent', initialStep: 'review', maxSteps: 10, steps: [step] };
    const point: WorkflowResumePoint = {
      version: 2, stack: [buildWorkflowResumePointEntry(workflow, 'review', kind, 1)],
      iteration: 7, elapsed_ms: 100, workflow_call_invocations: {}, workflow_step_participations: {},
    };

    expect(trimResumePointStackForWorkflow({
      workflow, resumePoint: point, resolveWorkflowCall: () => { throw new Error('Not a call'); },
      validateTerminalWorkflowCall: true,
    })).toEqual(point);
  });

  it.each(['fixed', 'pool'] as const)('should retain a dynamic parallel %s checkpoint with callee validation enabled', (target) => {
    const agent: WorkflowStep = { name: 'fixed', kind: 'agent', personaDisplayName: 'review', instruction: 'Review' };
    const workflow: WorkflowConfig = {
      name: 'parent', initialStep: 'reviewers', maxSteps: 10,
      steps: [{ name: 'reviewers', kind: 'agent', personaDisplayName: 'reviewers', instruction: '',
        parallel: { kind: 'dynamic', fixed: [agent], pool: [{ ...agent, name: 'pool', description: 'Review' }], selection: { mode: 'replace' } },
      }],
    };
    const point: WorkflowResumePoint = {
      version: 2,
      stack: [
        buildWorkflowResumePointEntry(workflow, 'reviewers', 'parallel', 1),
        buildWorkflowResumePointEntry(workflow, target, 'agent', 1),
      ],
      iteration: 7, elapsed_ms: 100, workflow_call_invocations: {}, workflow_step_participations: {},
    };

    expect(trimResumePointStackForWorkflow({
      workflow, resumePoint: point, resolveWorkflowCall: () => null, validateTerminalWorkflowCall: true,
    })).toEqual(point);
  });

  it('should keep a saved resume frame valid when only the instruction changes at the same workflow path', () => {
    const projectDir = createProjectDir();
    const workflowPath = join(projectDir, '.takt', 'workflows', 'default.yaml');
    mkdirSync(dirname(workflowPath), { recursive: true });
    const yaml = [
      'name: default', 'initial_step: reviewers', 'steps:',
      '  - name: reviewers', '    persona: reviewer', '    instruction: Original review',
    ].join('\n');
    writeFileSync(workflowPath, yaml, 'utf-8');
    const original = loadWorkflowFromFile(workflowPath, projectDir);
    const resumePoint = {
      version: 2 as const,
      stack: [buildWorkflowResumePointEntry(original, 'reviewers', 'agent', 1)],
      iteration: 2, elapsed_ms: 100,
      workflow_call_invocations: {}, workflow_step_participations: {},
    };

    writeFileSync(workflowPath, yaml.replace('Original review', 'Updated review'), 'utf-8');
    const current = loadWorkflowFromFile(workflowPath, projectDir);

    expect(trimResumePointStackForWorkflow({
      workflow: current, resumePoint, resolveWorkflowCall: () => null,
    })).toEqual(resumePoint);
  });

  it('should store the canonical ref when a restart entry uses the workflow name', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'default',
      initial_step: 'review',
      steps: [{ name: 'review', persona: 'reviewer', instruction: 'Review' }],
    }, '/tmp/project');

    expect(buildWorkflowRestartPointEntry(workflow, 'review', 'agent')).toEqual({
      workflow: 'default',
      workflow_ref: 'default',
      step: 'review',
      kind: 'agent',
    });
  });

  it('should distinguish restart identity when opaque refs differ for the same workflow name', () => {
    const workflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'shared',
      initial_step: 'review',
      steps: [{ name: 'review', persona: 'reviewer', instruction: 'Review' }],
    }, '/tmp/project'), 'project:shared-a');

    expect(workflowRestartEntryMatchesWorkflow({
      workflow: 'shared',
      workflow_ref: 'project:shared-a',
      step: 'review',
      kind: 'agent',
    }, workflow)).toBe(true);
    expect(workflowRestartEntryMatchesWorkflow({
      workflow: 'shared',
      workflow_ref: 'project:shared-b',
      step: 'review',
      kind: 'agent',
    }, workflow)).toBe(false);
  });

  it('agent entry の step iteration 差分を workflow_call instance として比較しない', () => {
    expect(workflowEntriesMatch(
      {
        workflow: 'parent',
        workflow_ref: 'parent',
        step: 'reviewers',
        kind: 'agent',
        occurrence: 1,
        step_iterations: { reviewers: 1 },
      },
      {
        workflow: 'parent',
        workflow_ref: 'parent',
        step: 'reviewers',
        kind: 'agent',
        occurrence: 1,
        step_iterations: { reviewers: 2 },
      },
    )).toBe(true);
  });
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
      version: 2 as const,
      stack: [
        buildWorkflowResumePointEntry(sourceWorkflow, 'reviewers', 'parallel', 4),
        buildWorkflowResumePointEntry(sourceWorkflow, 'delegate', 'workflow_call', 2),
        buildWorkflowResumePointEntry(childWorkflow, 'review', 'agent', 1),
      ],
      iteration: 7,
      elapsed_ms: 183245,
      workflow_call_invocations: {},
      workflow_step_participations: {},
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

    expect(workflowRef).toMatch(/^project:sha256:[0-9a-f]{64}$/);
    expect(workflowRef).not.toContain(workflowPath);
    expect(entry.workflow_ref).toBe(workflowRef);
  });
});
