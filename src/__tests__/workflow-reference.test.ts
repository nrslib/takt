import { dirname, join } from 'node:path';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { loadWorkflowFileWithResolutionOptions } from '../infra/config/loaders/workflowResolvedLoader.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import {
  attachWorkflowOpaqueRef,
  getAttachedWorkflowTrustInfo,
  getWorkflowSourcePath,
} from '../infra/config/loaders/workflowSourceMetadata.js';
import {
  buildWorkflowResumePointEntry,
  buildWorkflowRestartPointEntry,
  getWorkflowReference,
  workflowEntriesMatch,
  workflowEntryMatchesWorkflow,
  workflowRestartEntryMatchesWorkflow,
} from '../core/workflow/workflow-reference.js';
import { trimResumePointStackForWorkflow } from '../core/workflow/run/resume-point.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';

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
  it('Restart entry は workflow 名と同じ canonical ref も明示して保存する', () => {
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

  it('Restart identity は workflow 名が同じでも別 opaque ref を拒否する', () => {
    const workflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'shared',
      initial_step: 'review',
      steps: [{ name: 'review', persona: 'reviewer', instruction: 'Review' }],
    }, '/tmp/project'), 'project:shared-a');

    expect(workflowRestartEntryMatchesWorkflow({
      workflow: 'shared',
      workflow_ref: 'project:shared-b',
      step: 'review',
      kind: 'agent',
    }, workflow)).toBe(false);
  });

  it('Resume entry は旧データの workflow_ref 欠落時に workflow 名で照合する', () => {
    const workflow = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'shared',
      initial_step: 'review',
      steps: [{ name: 'review', persona: 'reviewer', instruction: 'Review' }],
    }, '/tmp/project'), 'project:shared-a');

    expect(workflowEntryMatchesWorkflow({
      workflow: 'shared',
      step: 'review',
      kind: 'agent',
    }, workflow)).toBe(true);
  });

  it('agent entry の step iteration 差分を workflow_call instance として比較しない', () => {
    expect(workflowEntriesMatch(
      {
        workflow: 'parent',
        step: 'reviewers',
        kind: 'agent',
        step_iterations: { reviewers: 1 },
      },
      {
        workflow: 'parent',
        step: 'reviewers',
        kind: 'agent',
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
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call', undefined, 1),
        buildWorkflowResumePointEntry(childWorkflow, 'review', 'agent'),
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
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call', undefined, 1),
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
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call', undefined, 1),
        buildWorkflowResumePointEntry(childWorkflow, 'review', 'agent'),
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
        buildWorkflowResumePointEntry(otherParentWorkflow, 'delegate', 'workflow_call', undefined, 1),
      ],
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

  it('loader は symlink 経路でも実体と同じ workflow 境界を使用する', () => {
    const projectDir = createProjectDir();
    const workflowPath = join(projectDir, '.takt', 'workflows', 'child.yaml');
    const personaPath = join(dirname(workflowPath), 'reviewer.md');
    const aliasPath = join(projectDir, 'child-alias.yaml');
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(personaPath, '# Reviewer', 'utf-8');
    writeFileSync(workflowPath, `name: child
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: ./reviewer.md
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    symlinkSync(workflowPath, aliasPath);

    const workflowFromPath = loadWorkflowFromFile(workflowPath, projectDir);
    const workflowFromAlias = loadWorkflowFromFile(aliasPath, projectDir);
    const resolvedFromPath = loadWorkflowFileWithResolutionOptions(workflowPath, {
      lookupCwd: projectDir,
      projectCwd: projectDir,
    });
    const resolvedFromAlias = loadWorkflowFileWithResolutionOptions(aliasPath, {
      lookupCwd: projectDir,
      projectCwd: projectDir,
    });

    expect(getWorkflowReference(workflowFromAlias)).toBe(getWorkflowReference(workflowFromPath));
    expect(getWorkflowSourcePath(workflowFromAlias)).toBe(getWorkflowSourcePath(workflowFromPath));
    expect(getAttachedWorkflowTrustInfo(workflowFromAlias)).toEqual(getAttachedWorkflowTrustInfo(workflowFromPath));
    expect(workflowFromAlias.steps[0]?.personaPath).toBe(workflowFromPath.steps[0]?.personaPath);
    expect(getWorkflowReference(resolvedFromAlias)).toBe(getWorkflowReference(resolvedFromPath));
    expect(getWorkflowSourcePath(resolvedFromAlias)).toBe(getWorkflowSourcePath(resolvedFromPath));
    expect(getAttachedWorkflowTrustInfo(resolvedFromAlias)).toEqual(getAttachedWorkflowTrustInfo(resolvedFromPath));
    expect(resolvedFromAlias.steps[0]?.personaPath).toBe(resolvedFromPath.steps[0]?.personaPath);
  });

  it('repertoire の祖先 symlink 経路でも package facet と canonical identity を両立する', () => {
    const projectDir = createProjectDir();
    const realConfigDir = join(projectDir, 'config-real');
    const aliasConfigDir = join(projectDir, 'config-alias');
    const realPackageDir = join(realConfigDir, 'repertoire', '@nrslib', 'pkg');
    const realWorkflowPath = join(realPackageDir, 'workflows', 'child.yaml');
    const aliasWorkflowPath = join(aliasConfigDir, 'repertoire', '@nrslib', 'pkg', 'workflows', 'child.yaml');
    const previousConfigDir = process.env.TAKT_CONFIG_DIR;
    mkdirSync(dirname(realWorkflowPath), { recursive: true });
    mkdirSync(join(realPackageDir, 'facets', 'instructions'), { recursive: true });
    writeFileSync(join(realPackageDir, 'facets', 'instructions', 'package-only.md'), 'Package instruction', 'utf-8');
    writeFileSync(join(dirname(realWorkflowPath), 'reviewer.md'), '# Reviewer', 'utf-8');
    writeFileSync(realWorkflowPath, `name: child
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: ./reviewer.md
    instruction: package-only
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    symlinkSync(realConfigDir, aliasConfigDir, 'dir');

    process.env.TAKT_CONFIG_DIR = aliasConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    try {
      const workflowFromAlias = loadWorkflowFileWithResolutionOptions(aliasWorkflowPath, {
        lookupCwd: projectDir,
        projectCwd: projectDir,
        source: 'repertoire',
      });
      const workflowFromCanonicalPath = loadWorkflowFileWithResolutionOptions(realWorkflowPath, {
        lookupCwd: projectDir,
        projectCwd: projectDir,
        source: 'repertoire',
      });

      expect(workflowFromAlias.steps[0]?.instruction).toBe('Package instruction');
      expect(workflowFromCanonicalPath.steps[0]?.instruction).toBe('Package instruction');
      expect(getWorkflowReference(workflowFromAlias)).toBe(getWorkflowReference(workflowFromCanonicalPath));
      expect(getWorkflowSourcePath(workflowFromAlias)).toBe(realpathSync(realWorkflowPath));
      expect(getWorkflowSourcePath(workflowFromAlias)).toBe(getWorkflowSourcePath(workflowFromCanonicalPath));
      expect(getAttachedWorkflowTrustInfo(workflowFromAlias)).toEqual(
        getAttachedWorkflowTrustInfo(workflowFromCanonicalPath),
      );
    } finally {
      if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
      else process.env.TAKT_CONFIG_DIR = previousConfigDir;
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
    }
  });
});
