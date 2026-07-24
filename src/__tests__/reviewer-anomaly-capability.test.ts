import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getReviewerAnomalyDefinitionCapability,
  getWorkflowOpaqueRef,
  transferReviewerAnomalyDefinitionCapability,
} from '../core/workflow/reviewer-anomaly-capability.js';
import {
  issueReviewerAnomalyDefinitionCapability,
  issueWorkflowOpaqueRef,
} from '../core/workflow/reviewer-anomaly-capability-storage.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { getBuiltinWorkflowsDir } from '../infra/config/paths.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import {
  collectValidatedWorkflowEntries,
  type WorkflowDirEntry,
} from '../infra/config/loaders/workflowDiscovery.js';
import { inspectWorkflowFile } from '../infra/config/loaders/workflowDoctor.js';
import { loadWorkflow, getBuiltinWorkflow } from '../infra/config/loaders/workflowResolver.js';
import { loadWorkflowFileWithResolutionOptions } from '../infra/config/loaders/workflowResolvedLoader.js';
import type { WorkflowTrustSource } from '../infra/config/loaders/workflowTrustSource.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfigCore.js';

const WORKFLOW_NAME = 'merge-readiness-finding-contract-final-gate';

describe('reviewer anomaly resolver-issued capability', () => {
  let cwd: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-reviewer-capability-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = join(cwd, 'global-config');
    mkdirSync(process.env.TAKT_CONFIG_DIR, { recursive: true });
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    invalidateGlobalConfigCache();
    rmSync(cwd, { recursive: true, force: true });
  });

  function builtinPath(locale: 'ja' | 'en'): string {
    return join(getBuiltinWorkflowsDir(locale), `${WORKFLOW_NAME}.yaml`);
  }

  function customWorkflowPath(): string {
    const path = join(cwd, 'custom-final-gate.yaml');
    copyFileSync(builtinPath('ja'), path);
    return path;
  }

  it.each(['ja', 'en'] as const)('%s builtin の実パスからだけ definition capability を発行する', (locale) => {
    const workflow = loadWorkflowFileWithResolutionOptions(builtinPath(locale), {
      projectCwd: cwd,
      lookupCwd: cwd,
      source: 'builtin',
    });
    const capability = getReviewerAnomalyDefinitionCapability(workflow);

    expect(capability).toMatchObject({
      kind: 'reviewer_anomaly_acknowledgement',
      approvalSteps: ['merge-readiness-review', 'supervise'],
    });
    expect(capability?.workflowRef).toMatch(/^builtin:sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability?.approvalSteps)).toBe(true);
  });

  it.each([
    'project',
    'worktree',
    'user',
    'repertoire',
    'external',
    'inline',
  ] satisfies WorkflowTrustSource[])('%s source の attestation 要求を明示拒否する', (source) => {
    expect(() => loadWorkflowFileWithResolutionOptions(customWorkflowPath(), {
      projectCwd: cwd,
      lookupCwd: cwd,
      source,
    })).toThrow(new RegExp(`untrusted source "${source}"`));
  });

  it('builtin source の root 外偽装と trustInfo/sourcePath 偽装を拒否する', () => {
    const customPath = customWorkflowPath();
    expect(() => loadWorkflowFileWithResolutionOptions(customPath, {
      projectCwd: cwd,
      lookupCwd: cwd,
      source: 'builtin',
    })).toThrow(/requires a file inside a builtin workflow root/);

    expect(() => loadWorkflowFromFile(customPath, cwd, {
      trustInfo: {
        source: 'builtin',
        sourcePath: customPath,
        isProjectTrustRoot: false,
        isProjectWorkflowRoot: false,
      },
    })).toThrow(/does not match a real builtin workflow file/);
  });

  it('custom discovery と doctor は attestation workflow を有効候補として扱わない', () => {
    const path = customWorkflowPath();
    const builtinEntry: WorkflowDirEntry = {
      name: WORKFLOW_NAME,
      path: builtinPath('ja'),
      source: 'builtin',
    };
    const entry: WorkflowDirEntry = {
      name: WORKFLOW_NAME,
      path,
      source: 'project',
    };
    const warnings: string[] = [];

    expect(collectValidatedWorkflowEntries([builtinEntry, entry], cwd, {
      onWarning: (warning) => warnings.push(warning),
    })).toEqual([]);
    expect(warnings.join('\n')).toContain('untrusted source "project"');
    expect(inspectWorkflowFile(path, cwd, { source: 'project' }).diagnostics)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('untrusted source "project"'),
        }),
      ]));
  });

  it('project shadow/eject は builtin へ fallback せず、disabled builtin は解決されない', () => {
    const projectWorkflowDir = join(cwd, '.takt', 'workflows');
    mkdirSync(projectWorkflowDir, { recursive: true });
    copyFileSync(builtinPath('ja'), join(projectWorkflowDir, `${WORKFLOW_NAME}.yaml`));

    expect(() => loadWorkflow(WORKFLOW_NAME, cwd)).toThrow(/untrusted source "project"/);

    rmSync(join(projectWorkflowDir, `${WORKFLOW_NAME}.yaml`));
    writeFileSync(
      join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'),
      `language: ja\ndisabled_builtins:\n  - ${WORKFLOW_NAME}\n`,
    );
    invalidateGlobalConfigCache();
    expect(getBuiltinWorkflow(WORKFLOW_NAME, cwd)).toBeNull();
  });

  it('実 loader が発行した definition capability は通常 spread で伝播しない', () => {
    const workflow = loadWorkflowFileWithResolutionOptions(builtinPath('ja'), {
      projectCwd: cwd,
      lookupCwd: cwd,
      source: 'builtin',
    });
    const definition = getReviewerAnomalyDefinitionCapability(workflow)!;
    const spreadWorkflow = { ...workflow };
    expect(getReviewerAnomalyDefinitionCapability(spreadWorkflow)).toBeUndefined();
    expect(definition.workflowRef).toMatch(/^builtin:sha256:[a-f0-9]{64}$/);
  });

  it('公開 builtin の全 Symbol descriptor を custom config へ反射コピーしても権限を得られない', () => {
    const builtin = getBuiltinWorkflow(WORKFLOW_NAME, cwd);
    if (builtin === null) {
      throw new Error('Expected public builtin workflow');
    }
    const custom: typeof builtin = {
      ...builtin,
      name: 'custom-reflection-copy',
    };

    for (const symbol of Object.getOwnPropertySymbols(builtin)) {
      const descriptor = Object.getOwnPropertyDescriptor(builtin, symbol);
      if (descriptor !== undefined) {
        Object.defineProperty(custom, symbol, descriptor);
      }
    }

    expect(getReviewerAnomalyDefinitionCapability(custom)).toBeUndefined();
    expect(getWorkflowOpaqueRef(custom)).toBeUndefined();
  });

  it.each([
    {
      label: 'name',
      mutate: (workflow: WorkflowConfig) => {
        workflow.name = 'mutated-final-gate';
      },
    },
    {
      label: 'approval step persona',
      mutate: (workflow: WorkflowConfig) => {
        workflow.steps[0]!.persona = 'mutated-persona';
      },
    },
    {
      label: 'approval step instruction',
      mutate: (workflow: WorkflowConfig) => {
        workflow.steps[0]!.instruction = 'Mutated instruction';
      },
    },
    {
      label: 'nested approval rule',
      mutate: (workflow: WorkflowConfig) => {
        workflow.steps[0]!.rules![0]!.next = 'ABORT';
      },
    },
    {
      label: 'nested attestation',
      mutate: (workflow: WorkflowConfig) => {
        workflow.subworkflow!.attestation!.approvalSteps[0] = 'supervise';
      },
    },
    {
      label: 'steps array',
      mutate: (workflow: WorkflowConfig) => {
        workflow.steps.push({
          name: 'injected-step',
          persona: 'injected',
          personaDisplayName: 'Injected',
          instruction: 'Injected instruction',
          rules: [],
        });
      },
    },
    {
      label: 'max steps',
      mutate: (workflow: WorkflowConfig) => {
        workflow.maxSteps = 1;
      },
    },
  ])('発行後に同一オブジェクトの $label を変更すると capability を失う', ({ mutate }) => {
    const workflow = getBuiltinWorkflow(WORKFLOW_NAME, cwd);
    if (workflow === null) {
      throw new Error('Expected public builtin workflow');
    }
    const transferTarget = structuredClone(workflow);

    mutate(workflow);

    expect(() => getReviewerAnomalyDefinitionCapability(workflow))
      .toThrow(/workflow content changed after issuance/);
    expect(() => transferReviewerAnomalyDefinitionCapability(workflow, transferTarget))
      .toThrow(/workflow content changed after issuance/);
    expect(getReviewerAnomalyDefinitionCapability(transferTarget)).toBeUndefined();
    expect(getWorkflowOpaqueRef(transferTarget)).toBeUndefined();
  });

  it('検証済み source から正規 clone へは target 内容に再封印して capability を移せる', () => {
    const workflow = getBuiltinWorkflow(WORKFLOW_NAME, cwd);
    if (workflow === null) {
      throw new Error('Expected public builtin workflow');
    }
    const target: WorkflowConfig = {
      ...workflow,
      maxSteps: workflow.maxSteps + 1,
    };
    const workflowRef = getWorkflowOpaqueRef(workflow);

    transferReviewerAnomalyDefinitionCapability(workflow, target);

    expect(getWorkflowOpaqueRef(target)).toBe(workflowRef);
    expect(getReviewerAnomalyDefinitionCapability(target)).toMatchObject({
      kind: 'reviewer_anomaly_acknowledgement',
      approvalSteps: ['merge-readiness-review', 'supervise'],
    });
    target.steps[0]!.instruction = 'Mutated after transfer';
    expect(() => getReviewerAnomalyDefinitionCapability(target))
      .toThrow(/workflow content changed after issuance/);
  });

  it('source の opaque ref が不正なら definition capability 検証後も target へ発行しない', () => {
    const workflow = getBuiltinWorkflow(WORKFLOW_NAME, cwd);
    if (workflow === null) {
      throw new Error('Expected public builtin workflow');
    }
    const source = structuredClone(workflow);
    issueWorkflowOpaqueRef(source, 'builtin:sha256:opaque-before-mutation');
    source.maxSteps += 1;
    issueReviewerAnomalyDefinitionCapability(source, {
      kind: 'reviewer_anomaly_acknowledgement',
      approvalSteps: ['merge-readiness-review', 'supervise'],
      workflowRef: 'builtin:sha256:opaque-before-mutation',
    });
    const target = structuredClone(source);

    expect(() => transferReviewerAnomalyDefinitionCapability(source, target))
      .toThrow(/workflow content changed after issuance/);
    expect(getWorkflowOpaqueRef(target)).toBeUndefined();
    expect(getReviewerAnomalyDefinitionCapability(target)).toBeUndefined();
  });

  it('source の definition capability が不正なら有効な opaque ref を target へ先行発行しない', () => {
    const workflow = getBuiltinWorkflow(WORKFLOW_NAME, cwd);
    if (workflow === null) {
      throw new Error('Expected public builtin workflow');
    }
    const source = structuredClone(workflow);
    issueReviewerAnomalyDefinitionCapability(source, {
      kind: 'reviewer_anomaly_acknowledgement',
      approvalSteps: ['merge-readiness-review', 'supervise'],
      workflowRef: 'builtin:sha256:opaque-after-mutation',
    });
    source.maxSteps += 1;
    issueWorkflowOpaqueRef(source, 'builtin:sha256:opaque-after-mutation');
    const target = structuredClone(source);

    expect(() => transferReviewerAnomalyDefinitionCapability(source, target))
      .toThrow(/workflow content changed after issuance/);
    expect(getWorkflowOpaqueRef(target)).toBeUndefined();
    expect(getReviewerAnomalyDefinitionCapability(target)).toBeUndefined();
  });
});
