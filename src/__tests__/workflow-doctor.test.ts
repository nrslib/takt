import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { inspectWorkflowFile, resolveWorkflowDoctorTargets } from '../infra/config/loaders/workflowDoctor.js';
import { loadWorkflowFromFile, loadWorkflowFromFileForDiscovery } from '../infra/config/loaders/workflowFileLoader.js';
import { collectValidatedWorkflowEntries } from '../infra/config/loaders/workflowDiscovery.js';
import * as workflowResolver from '../infra/config/loaders/workflowResolver.js';
import { doctorWorkflowCommand } from '../features/workflowAuthoring/doctor.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { formatMissingReportReference } from '../core/workflow/instruction/report-reference.js';
import { getWorkflowSourcePath } from '../infra/config/loaders/workflowSourceMetadata.js';
import type { WorkflowConfig } from '../core/models/types.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

const mockSuccess = vi.fn();
const mockWarn = vi.fn();
const mockError = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

function setWorkflowFileType(filePath: string, regular: boolean): void {
  const canonicalPath = actualFs.realpathSync(filePath);
  vi.mocked(fs.statSync).mockImplementation((path, options) => {
    const stats = actualFs.statSync(path, options);
    if (stats === undefined) return stats;
    return String(path) === filePath || String(path) === canonicalPath
      ? Object.assign(stats, { isFile: () => regular })
      : stats;
  });
}

function observeWorkflowReads(filePath: string, regular: boolean) {
  const canonicalPath = actualFs.realpathSync(filePath);
  const reads = vi.fn();
  vi.mocked(fs.readFileSync).mockImplementation((path, options) => {
    if (String(path) === filePath || String(path) === canonicalPath) {
      reads();
      if (!regular) throw new Error('Test blocked content read of a non-regular workflow');
    }
    return actualFs.readFileSync(path, options);
  });
  return reads;
}

vi.mock('../shared/ui/index.js', () => ({
  success: (...args: unknown[]) => mockSuccess(...args),
  warn: (...args: unknown[]) => mockWarn(...args),
  error: (...args: unknown[]) => mockError(...args),
}));

function writeWorkflow(projectDir: string, relativePath: string, content: string): string {
  const filePath = join(projectDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeWorkflowRefComposer(projectDir: string): void {
  writeWorkflow(projectDir, '.takt/workflows/composer.yaml', `name: composer
subworkflow:
  callable: true
  params:
    target:
      type: workflow_ref
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call:
      $param: target
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
}

interface WorktreeRootCase {
  name: string;
  rootDirRelativePath: string;
  configContent?: string;
}

const worktreeRootCases: WorktreeRootCase[] = [
  {
    name: 'project .takt/worktrees root',
    rootDirRelativePath: '.takt/worktrees',
  },
  {
    name: 'sibling takt-worktrees root',
    rootDirRelativePath: '../takt-worktrees',
  },
  {
    name: 'configured global worktree_dir root',
    rootDirRelativePath: 'custom-worktrees',
    configContent: 'worktree_dir: custom-worktrees\n',
  },
];

function writeConfigForCase(rootCase: WorktreeRootCase): void {
  if (!rootCase.configContent) {
    return;
  }

  writeWorkflow(process.env.TAKT_CONFIG_DIR!, 'config.yaml', rootCase.configContent);
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
}

describe('workflow doctor', () => {
  let projectDir: string;
  // 共有 tmp 直下（../takt-worktrees）に作った branch dir の追跡リスト。
  // afterEach で「自分が作った dir だけ」を削除する（並走テストの dir には
  // 触れない）。
  let createdWorktreeDirs: string[] = [];
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    vi.mocked(fs.statSync).mockImplementation(actualFs.statSync);
    vi.mocked(fs.readFileSync).mockImplementation(actualFs.readFileSync);
    vi.mocked(fs.readdirSync).mockImplementation(actualFs.readdirSync);
    createdWorktreeDirs = [];
    projectDir = mkdtempSync(join(tmpdir(), 'takt-workflow-doctor-'));
    process.env.TAKT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'takt-workflow-doctor-global-'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockSuccess.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(() => {
    for (const dir of createdWorktreeDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(projectDir, { recursive: true, force: true });
    if (process.env.TAKT_CONFIG_DIR) {
      rmSync(process.env.TAKT_CONFIG_DIR, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
      return;
    }
    process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('reports no diagnostics for a valid workflow file', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/valid.yaml', `name: valid
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: COMPLETE
`);

    const report = inspectWorkflowFile(filePath, projectDir);

    expect(report.diagnostics).toEqual([]);
  });

  it.each([true, false])('checks file type before doctor reads workflow content (regular=%s)', (regular) => {
    const path = writeWorkflow(projectDir, '.takt/workflows/checked.yaml', `name: checked
initial_step: work
steps:
  - name: work
    rules:
      - condition: done
        next: COMPLETE
`);
    setWorkflowFileType(path, regular);
    const reads = observeWorkflowReads(path, regular);

    const report = inspectWorkflowFile(path, projectDir);

    if (regular) {
      expect(report.diagnostics).toEqual([]);
      expect(reads).toHaveBeenCalled();
    } else {
      expect(report.diagnostics).toEqual([expect.objectContaining({ level: 'error' })]);
      expect(reads).not.toHaveBeenCalled();
    }
  });

  it.each([loadWorkflowFromFile, loadWorkflowFromFileForDiscovery])('preserves workflow symlinks to regular files in %s', (load) => {
    const path = writeWorkflow(projectDir, 'target.yaml', `name: target
initial_step: work
steps:
  - name: work
    rules:
      - condition: done
        next: COMPLETE
`);
    const link = join(projectDir, 'link.yaml');
    symlinkSync(path, link);
    expect(load(link, projectDir).name).toBe('target');
    expect(inspectWorkflowFile(link, projectDir).diagnostics).toEqual([]);

    setWorkflowFileType(path, false);
    const reads = observeWorkflowReads(path, false);
    expect(() => load(link, projectDir)).toThrow();
    expect(inspectWorkflowFile(link, projectDir).diagnostics).toEqual([expect.objectContaining({ level: 'error' })]);
    expect(reads).not.toHaveBeenCalled();
  });

  it('does not reread a non-regular workflow as internal callable metadata after a candidate load fails', () => {
    const path = writeWorkflow(projectDir, 'candidate.yaml', 'subworkflow:\n  callable: true\n  visibility: internal\n');
    setWorkflowFileType(path, false);
    const reads = observeWorkflowReads(path, false);
    const warning = vi.fn();

    const entries = collectValidatedWorkflowEntries(
      [{ name: 'candidate', path, source: 'project' }], projectDir, { onWarning: warning },
    );

    expect(entries).toEqual([]);
    expect(warning).toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });

  it('reports missing resource references', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/missing-refs.yaml', `name: missing-refs
max_steps: 10
initial_step: step1
steps:
  - name: step1
    persona: missing-persona
    instruction: missing-instruction
    output_contracts:
      report:
        - name: summary.md
          format: missing-format
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('step "step1" persona references missing resource "missing-persona"');
    expect(messages).toContain('step "step1" instruction references missing resource "missing-instruction"');
    expect(messages).toContain('step "step1" output_contract format references missing resource "missing-format"');
  });

  it('reports missing team_leader persona references', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/missing-team-leader-refs.yaml', `name: missing-team-leader-refs
max_steps: 10
initial_step: step1
steps:
  - name: step1
    team_leader:
      persona: missing-team-leader
      part_persona: missing-worker
    instruction: decompose
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('step "step1" team_leader persona references missing resource "missing-team-leader"');
    expect(messages).toContain('step "step1" team_leader part_persona references missing resource "missing-worker"');
  });

  it('accepts team_leader inspect_tools through workflow doctor inspection', async () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/team-leader-inspect-tools.yaml', `name: team-leader-inspect-tools
max_steps: 10
initial_step: step1
steps:
  - name: step1
    team_leader:
      inspect_tools: [read, glob, grep]
    rules:
      - condition: done
        next: COMPLETE
`);

    expect(inspectWorkflowFile(filePath, projectDir).diagnostics).toEqual([]);
    await expect(doctorWorkflowCommand([filePath], projectDir)).resolves.toBeUndefined();

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('team-leader-inspect-tools.yaml'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('validates dynamic fixed/pool review tags, aggregate rules, and report references', async () => {
    writeWorkflow(projectDir, '.takt/config.yaml', 'provider: mock\n');
    writeWorkflow(
      projectDir,
      '.takt/facets/output-contracts/review-report.md',
      'Write the review result.',
    );
    const filePath = writeWorkflow(projectDir, '.takt/workflows/dynamic-doctor.yaml', `name: dynamic-doctor
max_steps: 2
initial_step: reviewers
steps:
  - name: reviewers
    parallel:
      fixed:
        - name: architecture
          tags: [review]
          instruction: review architecture
          output_contracts:
            report:
              - name: architecture.md
                format: review-report
          rules:
            - condition: approved
      pool:
        - name: security
          tags: [review]
          description: review security
          instruction: review security
          output_contracts:
            report:
              - name: security.md
                format: review-report
          rules:
            - condition: approved
      selection:
        mode: replace
    rules:
      - condition: all("approved")
        next: fix
  - name: fix
    instruction: use {report:architecture.md} and {report:security.md}
    rules:
      - condition: done
        next: COMPLETE
`);

    expect(inspectWorkflowFile(filePath, projectDir).diagnostics).toEqual([]);
    await expect(doctorWorkflowCommand([filePath], projectDir)).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('{report:security.md}'));
    expect(mockWarn).not.toHaveBeenCalledWith(expect.stringContaining('{report:architecture.md}'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('accepts a dynamic selector provider through the shared transport', async () => {
    writeWorkflow(projectDir, '.takt/config.yaml', [
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
      '    model: opencode/big-pickle',
    ].join('\n'));
    const filePath = writeWorkflow(projectDir, '.takt/workflows/dynamic-selector-provider.yaml', `name: dynamic-selector-provider
max_steps: 1
initial_step: reviewers
steps:
  - name: reviewers
    parallel:
      pool:
        - name: security
          description: review security
          instruction: review security
      selection:
        mode: replace
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).resolves.toBeUndefined();
    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('dynamic-selector-provider.yaml'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('uses the CLI selector override for runtime contract validation', async () => {
    writeWorkflow(projectDir, '.takt/config.yaml', [
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
      '    model: opencode/big-pickle',
    ].join('\n'));
    const filePath = writeWorkflow(projectDir, '.takt/workflows/dynamic-selector-override.yaml', `name: dynamic-selector-override
max_steps: 1
initial_step: reviewers
steps:
  - name: reviewers
    parallel:
      pool:
        - name: security
          description: review security
          instruction: review security
      selection:
        mode: replace
`);

    await expect(doctorWorkflowCommand(
      [filePath],
      projectDir,
      { provider: 'mock' },
    )).resolves.toBeUndefined();

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('dynamic-selector-override.yaml'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('skips disabled companion provider resolution while validating companion declarations', async () => {
    writeWorkflow(projectDir, '.takt/companions/security-reviewer.yaml', `name: security-reviewer
description: security review
interval_ms: 60000
`);
    writeWorkflow(projectDir, '.takt/runtime.yaml', `version: 1
companion:
  enabled: false
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: mock-model
  targets:
    companions:
      security-reviewer:
        profile: missing-profile
`);
    const filePath = writeWorkflow(projectDir, '.takt/workflows/disabled-companion.yaml', `name: disabled-companion
max_steps: 1
initial_step: implement
steps:
  - name: implement
    instruction: implement
    companion: [security-reviewer]
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).resolves.toBeUndefined();

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('disabled-companion.yaml'));
    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('Companion review mode: completion'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('displays the resolved live companion review mode for an enabled workflow', async () => {
    writeWorkflow(projectDir, '.takt/companions/security-reviewer.yaml', `name: security-reviewer
description: security review
interval_ms: 60000
`);
    writeWorkflow(projectDir, '.takt/runtime.yaml', `version: 1
companion:
  enabled: true
  review_mode: live
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: mock-model
    security:
      provider: mock
      model: mock-security
  targets:
    companions:
      security-reviewer:
        profile: security
`);
    const filePath = writeWorkflow(projectDir, '.takt/workflows/live-companion.yaml', `name: live-companion
max_steps: 1
initial_step: implement
steps:
  - name: implement
    instruction: implement
    companion: [security-reviewer]
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).resolves.toBeUndefined();

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('Companion review mode: live'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('accepts shared selector transport when only a called workflow is dynamic', async () => {
    writeWorkflow(projectDir, '.takt/config.yaml', [
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
      '    model: opencode/big-pickle',
    ].join('\n'));
    writeWorkflow(projectDir, '.takt/workflows/child-dynamic.yaml', `name: child-dynamic
subworkflow:
  callable: true
max_steps: 1
initial_step: reviewers
steps:
  - name: reviewers
    parallel:
      pool:
        - name: security
          description: review security
          instruction: review security
          rules:
            - condition: approved
      selection:
        mode: replace
    rules:
      - condition: all("approved")
        next: COMPLETE
`);
    const parentPath = writeWorkflow(projectDir, '.takt/workflows/parent-dynamic.yaml', `name: parent-dynamic
max_steps: 1
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: child-dynamic
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    await expect(doctorWorkflowCommand([parentPath], projectDir)).resolves.toBeUndefined();
    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('parent-dynamic.yaml'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('reports invalid team_leader inspect_tools from workflow doctor output', async () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/invalid-team-leader-inspect-tools.yaml', `name: invalid-team-leader-inspect-tools
max_steps: 10
initial_step: step1
steps:
  - name: step1
    team_leader:
      inspect_tools: [read, bash]
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('invalid-team-leader-inspect-tools.yaml'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('team_leader.inspect_tools'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('bash'));
  });


  it('reports a runtime.yaml same-priority tag routing conflict as a doctor error (fail-fast forwarded)', async () => {
    writeWorkflow(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: codex
      model: gpt-runtime
    alt:
      provider: opencode
      model: opencode/big-pickle
  targets:
    tags:
      t1:
        profile: default
      t2:
        profile: alt
`);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    const filePath = writeWorkflow(projectDir, '.takt/workflows/runtime-tag-conflict.yaml', `name: runtime-tag-conflict
max_steps: 1
initial_step: review
steps:
  - name: review
    instruction: review the implementation
    tags:
      - t1
      - t2
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('runtime-tag-conflict.yaml'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Conflicting provider routing for tags'));
  });


  it('keeps expanded workflow_ref composition valid without an inherited runtime requirement', async () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/root.yaml', `name: root
initial_step: compose
steps:
  - name: compose
    kind: workflow_call
    call: composer
    args:
      target: regular-review
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeWorkflowRefComposer(projectDir);
    writeWorkflow(projectDir, '.takt/workflows/regular-review.yaml', `name: regular-review
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).resolves.toBeUndefined();
  });

  it('attributes runtime validation errors to the referenced step fragment', async () => {
    const fragmentPath = writeWorkflow(projectDir, '.takt/steps/opencode-review.yaml', `provider: opencode
instruction: review the implementation
`);
    const filePath = writeWorkflow(projectDir, '.takt/workflows/fragment-runtime-error.yaml', `name: fragment-runtime-error
max_steps: 1
initial_step: review
steps:
  - name: review
    uses: opencode-review
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).rejects.toThrow('Workflow validation failed');

    const output = mockError.mock.calls.flat().join('\n');
    expect(output).toContain('workflow YAML no longer accepts provider execution settings');
    expect(output).toContain('configure provider/model/options in runtime.yaml');
    expect(output).toContain(filePath);
    expect(output).toContain('from step fragment "opencode-review"');
    expect(output).toContain(fragmentPath);
  });


  it('warns when an instruction references a report that is only produced by later steps (v3-r4 arbitrate shape)', async () => {
    writeWorkflow(projectDir, '.takt/facets/output-contracts/simple-report.md', 'Write a short report.');
    const filePath = writeWorkflow(projectDir, '.takt/workflows/report-ref-later.yaml', `name: report-ref-later
max_steps: 10
initial_step: review
loop_monitors:
  - cycle:
      - review
      - fix
    threshold: 3
    judge:
      instruction: "check the loop using {report:final-review.md}"
      rules:
        - condition: healthy
          next: review
        - condition: stuck
          next: reviewers
steps:
  - name: review
    instruction: review the diff
    rules:
      - condition: issues found
        next: fix
      - condition: clean
        next: reviewers
    output_contracts:
      report:
        - name: review-1st.md
          format: simple-report
  - name: fix
    instruction: fix it
    rules:
      - condition: fixed
        next: review
      - condition: no fix needed
        next: arbitrate
  - name: arbitrate
    instruction: "arbitrate using {report:final-review.md}"
    rules:
      - condition: reviewer is right
        next: fix
      - condition: coder is right
        next: reviewers
  - name: reviewers
    instruction: final review
    rules:
      - condition: ok
        next: COMPLETE
    output_contracts:
      report:
        - name: final-review.md
          format: simple-report
`);

    await doctorWorkflowCommand([filePath], projectDir);

    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('{report:final-review.md}'));
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('[review -> fix]'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('does not warn when the referenced report is produced before the step on every path', async () => {
    writeWorkflow(projectDir, '.takt/facets/output-contracts/simple-report.md', 'Write a short report.');
    const filePath = writeWorkflow(projectDir, '.takt/workflows/report-ref-earlier.yaml', `name: report-ref-earlier
max_steps: 10
initial_step: review
loop_monitors:
  - cycle:
      - review
      - fix
    threshold: 3
    judge:
      instruction: "check the loop using {report:review-1st.md}"
      rules:
        - condition: healthy
          next: review
        - condition: stuck
          next: COMPLETE
steps:
  - name: review
    instruction: review the diff
    rules:
      - condition: issues found
        next: fix
      - condition: clean
        next: COMPLETE
    output_contracts:
      report:
        - name: review-1st.md
          format: simple-report
  - name: fix
    instruction: fix it
    rules:
      - condition: fixed
        next: review
      - condition: no fix needed
        next: arbitrate
  - name: arbitrate
    instruction: "arbitrate using {report:review-1st.md}"
    rules:
      - condition: reviewer is right
        next: fix
      - condition: coder is right
        next: COMPLETE
`);

    await doctorWorkflowCommand([filePath], projectDir);

    expect(mockWarn).not.toHaveBeenCalledWith(expect.stringContaining('{report:'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('warns when a workflow_call path bypasses the parent report producer before a merge', async () => {
    writeWorkflow(projectDir, '.takt/facets/output-contracts/simple-report.md', 'Write a short report.');
    writeWorkflow(projectDir, '.takt/workflows/wildcard-child.yaml', `name: wildcard-child
subworkflow:
  callable: true
  returns: [ok]
initial_step: work
max_steps: 3
steps:
  - name: work
    instruction: do the delegated work
    rules:
      - condition: done
        return: ok
`);
    const filePath = writeWorkflow(projectDir, '.takt/workflows/report-ref-wildcard-merge.yaml', `name: report-ref-wildcard-merge
max_steps: 10
initial_step: route
steps:
  - name: route
    instruction: route the work
    rules:
      - condition: delegate path
        next: delegate
      - condition: direct path
        next: produce
  - name: delegate
    kind: workflow_call
    call: wildcard-child
    rules:
      - condition: ok
        next: join
  - name: produce
    instruction: produce the report
    rules:
      - condition: done
        next: join
    output_contracts:
      report:
        - name: x-report.md
          format: simple-report
  - name: join
    instruction: "consume {report:x-report.md}"
    rules:
      - condition: done
        next: COMPLETE
`);

    await doctorWorkflowCommand([filePath], projectDir);

    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('{report:x-report.md}'));
    expect(mockError).not.toHaveBeenCalled();
  });

  // codex 指摘 (b): loop monitor の judge は cycle 完走後にしか発火しないため、
  // judge エッジは cycle 最後のステップからのみ張る。cycle 後半のステップが
  // 生成するレポートを judge の遷移先が参照しても偽陽性を出さない。
  it('does not warn when a judge target references a report produced by the last cycle step', async () => {
    writeWorkflow(projectDir, '.takt/facets/output-contracts/simple-report.md', 'Write a short report.');
    const filePath = writeWorkflow(projectDir, '.takt/workflows/report-ref-cycle-late-producer.yaml', `name: report-ref-cycle-late-producer
max_steps: 10
initial_step: stepa
loop_monitors:
  - cycle:
      - stepa
      - stepb
    threshold: 3
    judge:
      instruction: judge the loop
      rules:
        - condition: healthy
          next: stepa
        - condition: stuck
          next: escalate
steps:
  - name: stepa
    instruction: do a
    rules:
      - condition: continue
        next: stepb
  - name: stepb
    instruction: do b
    rules:
      - condition: loop
        next: stepa
      - condition: done
        next: COMPLETE
    output_contracts:
      report:
        - name: b-report.md
          format: simple-report
  - name: escalate
    instruction: "handle the stuck loop using {report:b-report.md}"
    rules:
      - condition: done
        next: COMPLETE
`);

    await doctorWorkflowCommand([filePath], projectDir);

    expect(mockWarn).not.toHaveBeenCalledWith(expect.stringContaining('{report:'));
    expect(mockError).not.toHaveBeenCalled();
  });

  // 予約名の強制（codex 3巡目）: resume-artifacts.json は resume スナップショット
  // manifest の内部予約名。出力契約に使うとロード時（Zod 検証）に落ちる。
  it('rejects workflows whose output contract uses the reserved resume-artifacts.json name', async () => {
    writeWorkflow(projectDir, '.takt/facets/output-contracts/simple-report.md', 'Write a short report.');
    const filePath = writeWorkflow(projectDir, '.takt/workflows/reserved-contract-name.yaml', `name: reserved-contract-name
max_steps: 10
initial_step: step1
steps:
  - name: step1
    instruction: do the work
    rules:
      - condition: done
        next: COMPLETE
    output_contracts:
      report:
        - name: Resume-Artifacts.JSON
          format: simple-report
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).rejects.toThrow('Workflow validation failed');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('reserved for the internal resume snapshot manifest'));
  });

  it('rejects output contracts using a noncanonical backslash separator', async () => {
    writeWorkflow(projectDir, '.takt/facets/output-contracts/simple-report.md', 'Write a short report.');
    const filePath = writeWorkflow(projectDir, '.takt/workflows/reserved-contract-backslash.yaml', `name: reserved-contract-backslash
max_steps: 10
initial_step: step1
steps:
  - name: step1
    instruction: do the work
    rules:
      - condition: done
        next: COMPLETE
    output_contracts:
      report:
        - name: 'sub\\Resume-Artifacts.JSON'
          format: simple-report
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).rejects.toThrow('Workflow validation failed');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('non-canonical path separator'));
  });

  it('rejects output contracts containing a dotdot path segment before namespace classification', async () => {
    writeWorkflow(projectDir, '.takt/facets/output-contracts/simple-report.md', 'Write a short report.');
    const filePath = writeWorkflow(projectDir, '.takt/workflows/internal-contract-path.yaml', `name: internal-contract-path
max_steps: 10
initial_step: step1
steps:
  - name: step1
    instruction: do the work
    rules:
      - condition: done
        next: COMPLETE
    output_contracts:
      report:
        - name: 'public/../.takt-report-internal/review.md'
          format: simple-report
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).rejects.toThrow('Workflow validation failed');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('dot path segment'));
  });

  it('reports an error when an instruction uses a noncanonical backslash separator', async () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/reserved-reference-backslash.yaml', `name: reserved-reference-backslash
max_steps: 10
initial_step: step1
steps:
  - name: step1
    instruction: 'inspect {report:sub\\Resume-Artifacts.JSON}'
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).rejects.toThrow();
    expect(mockError).toHaveBeenCalled();
  });

  it('reports an error when an instruction report reference contains a dotdot path segment', async () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/internal-reference.yaml', `name: internal-reference
max_steps: 10
initial_step: step1
steps:
  - name: step1
    instruction: 'inspect {report:public/../.takt-report-internal/review.md}'
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).rejects.toThrow();
    expect(mockError).toHaveBeenCalled();
  });

  it('reports an error when an instruction references the reserved resume-artifacts.json', async () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/reserved-reference.yaml', `name: reserved-reference
max_steps: 10
initial_step: step1
steps:
  - name: step1
    instruction: "inspect {report:resume-artifacts.json}"
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(doctorWorkflowCommand([filePath], projectDir)).rejects.toThrow();
    expect(mockError).toHaveBeenCalled();
  });

  it('warns when an instruction references a report that no step produces at all', async () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/report-ref-nowhere.yaml', `name: report-ref-nowhere
max_steps: 10
initial_step: step1
steps:
  - name: step1
    instruction: "work with {report:ghost-report.md}"
    rules:
      - condition: done
        next: COMPLETE
`);

    await doctorWorkflowCommand([filePath], projectDir);

    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('{report:ghost-report.md}'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('warns on an unresolved callable reference when no caller is known', async () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/report-ref-callable.yaml', `name: report-ref-callable
subworkflow:
  callable: true
max_steps: 10
initial_step: step1
steps:
  - name: step1
    instruction: "work with {report:plan.md}"
    rules:
      - condition: done
        next: COMPLETE
`);

    await doctorWorkflowCommand([filePath], projectDir);

    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('{report:plan.md}'));
    expect(mockError).not.toHaveBeenCalled();
  });

  describe('callable report reference validation', () => {
    beforeEach(() => {
      writeWorkflow(projectDir, '.takt/config.yaml', 'provider: mock\n');
      writeWorkflow(projectDir, '.takt/facets/output-contracts/simple-report.md', '{report:future.md}');
    });

    function writeConsumer(name: string, reference: string): string {
      return writeWorkflow(projectDir, `.takt/workflows/${name}.yaml`, `name: ${name}
subworkflow:
  callable: true
initial_step: work
steps:
  - name: work
    instruction: 'consume {report:${reference}}'
    output_contracts:
      report:
        - name: result.md
          format: simple-report
    rules:
      - condition: done
        next: COMPLETE
`);
    }

    function writeParent(name: string, child: string, produceBeforeCall: boolean): string {
      return writeWorkflow(projectDir, `.takt/workflows/${name}.yaml`, `name: ${name}
initial_step: ${produceBeforeCall ? 'produce' : 'delegate'}
steps:
  - name: produce
    instruction: produce the plan
    output_contracts:
      report:
        - name: plan.md
          format: simple-report
    rules:
      - condition: done
        next: ${produceBeforeCall ? 'delegate' : 'COMPLETE'}
  - name: delegate
    kind: workflow_call
    call: ${child}
    rules:
      - condition: COMPLETE
        next: ${produceBeforeCall ? 'COMPLETE' : 'produce'}
`);
    }

    describe('caller discovery boundaries', () => {
      beforeEach(() => {
        writeWorkflow(process.env.TAKT_CONFIG_DIR!, 'config.yaml', 'enable_builtin_workflows: false\n');
        invalidateAllResolvedConfigCache();
      });

      function callerYaml(child: string, before: boolean, produces = true): string {
        return `name: parent
initial_step: ${before ? 'produce' : 'delegate'}
steps:
  - name: produce
    instruction: produce the plan
${produces ? `    output_contracts:
      report:
        - name: plan.md
          format: simple-report
` : ''}    rules:
      - condition: done
        next: ${before ? 'delegate' : 'COMPLETE'}
  - name: delegate
    kind: workflow_call
    call: ${child}
    rules:
      - condition: COMPLETE
        next: ${before ? 'COMPLETE' : 'produce'}
`;
      }

      function preferYmlEntries(): void {
        vi.mocked(fs.readdirSync).mockImplementation((path, options) =>
          actualFs.readdirSync(path, options).sort((a, b) =>
            Number(String(b).endsWith('.yml')) - Number(String(a).endsWith('.yml'))),
        );
      }

      function referenceWarnings(): string[] {
        return mockWarn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('{report:plan.md}'));
      }

      it('caches caller candidates for one doctor invocation only', async () => {
        const writeCallable = (name: string): void => {
          writeWorkflow(projectDir, `.takt/workflows/${name}.yaml`, `name: ${name}
subworkflow:
  callable: true
initial_step: work
steps:
  - name: work
    rules:
      - condition: done
        next: COMPLETE
`);
        };
        const writeCaller = (name: string, child: string): string => writeWorkflow(
          projectDir,
          `.takt/workflows/${name}.yaml`,
          `name: ${name}
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: ${child}
    rules:
      - condition: COMPLETE
        next: COMPLETE
`,
        );

        writeCallable('child-a');
        writeCallable('child-b');
        const callerPaths = [writeCaller('parent-a', 'child-a'), writeCaller('parent-b', 'child-b')];
        const readCounts = new Map(callerPaths.map((path) => [actualFs.realpathSync(path), 0]));
        vi.mocked(fs.readFileSync).mockImplementation((path, options) => {
          const canonicalPath = actualFs.realpathSync(String(path));
          const count = readCounts.get(canonicalPath);
          if (count !== undefined) readCounts.set(canonicalPath, count + 1);
          return actualFs.readFileSync(path, options);
        });

        await doctorWorkflowCommand(['child-a', 'child-b'], projectDir);
        expect([...readCounts.values()]).toEqual([1, 1]);

        await doctorWorkflowCommand(['child-a', 'child-b'], projectDir);
        expect([...readCounts.values()]).toEqual([2, 2]);
      });

      function expectRuntimePlanReference(parent: WorkflowConfig): void {
        const produces = parent.steps.some((step) => step.outputContracts?.some((contract) => contract.name === 'plan.md'));
        const reports = join(projectDir, produces ? 'reports-produced' : 'reports-missing');
        const childReports = join(reports, 'subworkflows', 'child');
        mkdirSync(childReports, { recursive: true });
        if (produces) writeFileSync(join(reports, 'plan.md'), 'SELECTED-PARENT-PLAN');
        const prepared = new InstructionBuilder(makeStep({ name: 'work', instruction: '{report:plan.md}' }), makeInstructionContext({
          reportDir: childReports, reportsRootDir: reports,
        })).prepare();
        const content = produces ? 'SELECTED-PARENT-PLAN' : formatMissingReportReference('plan.md');
        expect(prepared.injectedReports).toEqual([{
          reference: 'plan.md', scope: produces ? 'parent-run-readonly' : 'missing', content,
        }]);
        expect(prepared.text).toContain(content);
      }

      it.each(['parent', 'category/parent'])('uses runtime extension precedence for %s regardless of enumeration order', async (name) => {
        writeConsumer('child', 'plan.md');
        const yamlPath = writeWorkflow(projectDir, `.takt/workflows/${name}.yaml`, callerYaml('child', true));
        writeWorkflow(projectDir, `.takt/workflows/${name}.yml`, callerYaml('child', true));
        preferYmlEntries();
        expect(fs.readdirSync(dirname(yamlPath)).indexOf('parent.yml')).toBeLessThan(fs.readdirSync(dirname(yamlPath)).indexOf('parent.yaml'));
        const runtimeBefore = workflowResolver.loadWorkflow(name, projectDir)!;
        expect(getWorkflowSourcePath(runtimeBefore)).toBe(actualFs.realpathSync(yamlPath));
        expectRuntimePlanReference(runtimeBefore);

        await doctorWorkflowCommand(['child'], projectDir);
        expect(referenceWarnings()).toEqual([]);

        writeFileSync(yamlPath, callerYaml('child', true, false));
        mockWarn.mockClear();
        const runtimeParent = workflowResolver.loadWorkflow(name, projectDir)!;
        expect(getWorkflowSourcePath(runtimeParent)).toBe(actualFs.realpathSync(yamlPath));
        expect(runtimeParent.steps.flatMap((step) => step.outputContracts ?? [])).toEqual([]);
        expectRuntimePlanReference(runtimeParent);
        await doctorWorkflowCommand(['child'], projectDir);
        expect(referenceWarnings()).toEqual([expect.stringContaining('{report:plan.md}')]);
        expect(mockError).not.toHaveBeenCalled();
      });

      it('uses a yml-only caller until a higher-priority yaml caller exists', async () => {
        writeConsumer('child', 'plan.md');
        writeWorkflow(projectDir, '.takt/workflows/parent.yml', callerYaml('child', true));
        await doctorWorkflowCommand(['child'], projectDir);
        expect(referenceWarnings()).toEqual([]);

        writeWorkflow(projectDir, '.takt/workflows/parent.yaml', callerYaml('child', true, false));
        mockWarn.mockClear();
        await doctorWorkflowCommand(['child'], projectDir);
        expect(referenceWarnings()).toEqual([expect.stringContaining('{report:plan.md}')]);
        expect(mockError).not.toHaveBeenCalled();
      });

      it('does not fall back or reread metadata when the selected yaml caller is non-regular', async () => {
        writeConsumer('child', 'plan.md');
        const path = writeWorkflow(projectDir, '.takt/workflows/parent.yaml', callerYaml('child', true));
        writeWorkflow(projectDir, '.takt/workflows/parent.yml', callerYaml('child', true));
        setWorkflowFileType(path, false);
        const reads = observeWorkflowReads(path, false);

        await doctorWorkflowCommand(['child'], projectDir);

        expect(referenceWarnings()).toEqual([expect.stringContaining('{report:plan.md}')]);
        expect(reads).not.toHaveBeenCalled();
        expect(mockError).not.toHaveBeenCalled();
      });

      function writeRepertoireParent(content: string, extension = 'yaml'): string {
        writeWorkflow(process.env.TAKT_CONFIG_DIR!, 'repertoire/@alice/pack/facets/output-contracts/simple-report.md', 'Write the plan.');
        return writeWorkflow(process.env.TAKT_CONFIG_DIR!, `repertoire/@alice/pack/workflows/parent.${extension}`, content);
      }

      it.each(['child', 'middle'])('recognizes preceding repertoire ancestor reports through %s', async (called) => {
        writeConsumer('child', 'plan.md');
        if (called === 'middle') {
          writeWorkflow(projectDir, '.takt/workflows/middle.yaml', `name: middle
subworkflow:
  callable: true
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
        }
        const parent = writeRepertoireParent(callerYaml(called, true));

        await doctorWorkflowCommand(['child'], projectDir);
        expect(referenceWarnings()).toEqual([]);

        writeFileSync(parent, callerYaml(called, false));
        mockWarn.mockClear();
        await doctorWorkflowCommand(['child'], projectDir);
        expect(referenceWarnings()).toEqual([expect.stringContaining('{report:plan.md}')]);
        expect(mockError).not.toHaveBeenCalled();
      });

      it('keeps repertoire identity separate from project names and ignores non-callers', async () => {
        writeConsumer('child', 'plan.md');
        writeConsumer('other', 'plan.md');
        writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
initial_step: work
steps:
  - name: work
    rules:
      - condition: done
        next: COMPLETE
`);
        const parent = writeRepertoireParent(callerYaml('child', true));
        await doctorWorkflowCommand(['child'], projectDir);
        expect(referenceWarnings()).toEqual([]);

        writeFileSync(parent, callerYaml('other', true));
        mockWarn.mockClear();
        await doctorWorkflowCommand(['child'], projectDir);
        expect(referenceWarnings()).toEqual([expect.stringContaining('{report:plan.md}')]);
        expect(mockError).not.toHaveBeenCalled();
      });

      it('uses runtime extension precedence for repertoire callers', async () => {
        writeConsumer('child', 'plan.md');
        const yamlPath = writeRepertoireParent(callerYaml('child', true));
        writeRepertoireParent(callerYaml('child', true), 'yml');
        preferYmlEntries();
        const runtimeParent = workflowResolver.loadWorkflowByIdentifier('@alice/pack/parent', projectDir)!;
        expect(getWorkflowSourcePath(runtimeParent)).toBe(actualFs.realpathSync(yamlPath));
        expectRuntimePlanReference(runtimeParent);
        await doctorWorkflowCommand(['child'], projectDir);
        expect(referenceWarnings()).toEqual([]);

        writeFileSync(yamlPath, callerYaml('child', true, false));
        mockWarn.mockClear();
        expectRuntimePlanReference(workflowResolver.loadWorkflowByIdentifier('@alice/pack/parent', projectDir)!);
        await doctorWorkflowCommand(['child'], projectDir);
        expect(referenceWarnings()).toEqual([expect.stringContaining('{report:plan.md}')]);
        expect(mockError).not.toHaveBeenCalled();
      });

      it.each([true, false])('checks candidate call targets before reading them (regular=%s)', async (regular) => {
        writeConsumer('child', 'plan.md');
        const middle = writeWorkflow(projectDir, 'middle.yaml', `name: middle
subworkflow:
  callable: true
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
        writeParent('parent', middle, true);
        setWorkflowFileType(middle, regular);
        const reads = observeWorkflowReads(middle, regular);

        await doctorWorkflowCommand(['child'], projectDir);

        expect(mockError).not.toHaveBeenCalled();
        if (regular) {
          expect(referenceWarnings()).toEqual([]);
          expect(reads).toHaveBeenCalled();
        } else {
          expect(referenceWarnings()).toEqual([expect.stringContaining('{report:plan.md}')]);
          expect(reads).not.toHaveBeenCalled();
        }
      });

    });

    it.each(['parent', 'child'])('accepts a callable reference to a preceding parent report when targeting %s', async (target) => {
      writeConsumer('child', 'plan.md');
      writeParent('parent', 'child', true);

      await doctorWorkflowCommand([target], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
      expect(mockSuccess).toHaveBeenCalled();
    });

    describe.each(['parent', 'child'])('dynamic parent guarantees when targeting %s', (target) => {
      it.each([
        { fixed: [], pool: ['produce'], reportName: 'plan.md', warning: false },
        { fixed: ['idle'], pool: ['produce'], reportName: 'plan.md', warning: true },
        { fixed: ['produce'], pool: ['idle'], reportName: 'plan.md', warning: false },
        { fixed: [], pool: ['produce', 'other'], reportName: 'plan.md', warning: true },
        { fixed: ['idle'], pool: ['produce', 'other'], reportName: 'plan.md', warning: true },
        { fixed: ['produce'], pool: ['idle'], reportName: 'other.md', warning: true },
      ])('checks fixed=$fixed pool=$pool report=$reportName', async ({ fixed, pool, reportName, warning }) => {
        writeConsumer('child', 'plan.md');
        const participant = (name: string, inPool: boolean) => `        - name: ${name}
${inPool ? `          description: Run ${name}\n` : ''}          instruction: Run ${name}
${name === 'produce' ? `          output_contracts:
            report:
              - name: ${reportName}
                format: simple-report
` : ''}          rules:
            - condition: done`;
        writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
initial_step: select
steps:
  - name: select
    parallel:
      fixed:${fixed.length === 0 ? ' []' : `\n${fixed.map((name) => participant(name, false)).join('\n')}`}
      pool:
${pool.map((name) => participant(name, true)).join('\n')}
      selection:
        mode: replace
    rules:
      - condition: all("done")
        next: delegate
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

        await doctorWorkflowCommand([target], projectDir);

        expect(mockError).not.toHaveBeenCalled();
        const references = mockWarn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('{report:plan.md}'));
        expect(references).toEqual(warning ? [expect.stringContaining('{report:plan.md}')] : []);
        if (warning) {
          expect(references[0]).toContain('work');
          expect(references[0]).toContain('parent:delegate');
        } else {
          expect(mockSuccess).toHaveBeenCalled();
        }
      });
    });

    it.each(['parent', 'child'])('warns about an unproduced callable reference without consuming its output format when targeting %s', async (target) => {
      writeConsumer('child', 'plam.md');
      writeParent('parent', 'child', true);

      await doctorWorkflowCommand([target], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      const references = mockWarn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('{report:'));
      expect(references).toEqual([expect.stringContaining('{report:plam.md}')]);
    });

    it.each(['parent', 'child'])('does not count a parent report produced after the call when targeting %s', async (target) => {
      writeConsumer('child', 'plan.md');
      writeParent('parent', 'child', false);

      await doctorWorkflowCommand([target], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('{report:plan.md}'));
    });

    it('keeps distinct caller contexts separate when inspecting a shared child', async () => {
      writeConsumer('shared-child', 'plan.md');
      writeParent('good-parent', 'shared-child', true);
      writeParent('bad-parent', 'shared-child', false);

      await doctorWorkflowCommand(['shared-child'], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      const references = mockWarn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('{report:plan.md}'));
      expect(references.length).toBeGreaterThan(0);
      for (const message of references) {
        expect(message).toContain('work');
        expect(message).toContain('bad-parent');
        expect(message).toContain('delegate');
        expect(message).not.toContain('good-parent');
      }
    });

    it('keeps availability separate for repeated calls to the same child in one parent', async () => {
      writeConsumer('child', 'plan.md');
      writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
initial_step: early-call
steps:
  - name: early-call
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: produce
  - name: produce
    instruction: produce the report
    output_contracts:
      report:
        - name: plan.md
          format: simple-report
    rules:
      - condition: done
        next: late-call
  - name: late-call
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

      await doctorWorkflowCommand(['parent'], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      const references = mockWarn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('{report:plan.md}'));
      expect(references).toEqual([expect.stringContaining('early-call')]);
      expect(references[0]).toContain('work');
      expect(references[0]).not.toContain('late-call');
    });

    it('uses the resolved project child instead of a same-named user workflow producer', async () => {
      writeConsumer('child', 'plam.md');
      writeParent('parent', 'child', true);
      writeWorkflow(process.env.TAKT_CONFIG_DIR!, 'facets/output-contracts/user-report.md', 'Write a short report.');
      const userChildPath = writeWorkflow(process.env.TAKT_CONFIG_DIR!, 'workflows/child.yaml', `name: child
subworkflow:
  callable: true
initial_step: produce
steps:
  - name: produce
    instruction: produce the report
    output_contracts:
      report:
        - name: plam.md
          format: user-report
    rules:
      - condition: done
        next: COMPLETE
`);

      expect(inspectWorkflowFile(userChildPath, projectDir).diagnostics).toEqual([]);
      await doctorWorkflowCommand(['parent'], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('{report:plam.md}'));
    });

    it.each(['parent', 'child', 'grandchild'].flatMap((target) =>
      ['plan.md', 'plam.md'].map((reference) => ({ target, reference })),
    ))('matches doctor diagnostics with nested runtime report resolution ($target, $reference)', async ({ target, reference }) => {
      writeConsumer('grandchild', reference);
      writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
initial_step: delegate-grandchild
steps:
  - name: delegate-grandchild
    kind: workflow_call
    call: grandchild
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
      writeParent('parent', 'child', true);
      const reports = join(projectDir, 'reports');
      const grandchildReports = join(reports, 'subworkflows', 'child', 'subworkflows', 'grandchild');
      mkdirSync(grandchildReports, { recursive: true });
      writeFileSync(join(reports, 'plan.md'), 'PARENT-PLAN');
      const prepared = new InstructionBuilder(makeStep({ name: 'work', instruction: `{report:${reference}}` }), makeInstructionContext({
        reportDir: grandchildReports, reportsRootDir: reports,
      })).prepare();

      await doctorWorkflowCommand([target], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      const references = mockWarn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes(`{report:${reference}}`));
      if (reference === 'plan.md') {
        expect(prepared.injectedReports).toEqual([{ reference, scope: 'parent-run-readonly', content: 'PARENT-PLAN' }]);
        expect(prepared.text).toContain('PARENT-PLAN');
        expect(references).toEqual([]);
      } else {
        expect(prepared.injectedReports).toEqual([{ reference, scope: 'missing', content: formatMissingReportReference(reference) }]);
        expect(prepared.text).toContain(formatMissingReportReference(reference));
        expect(references).toEqual([expect.stringContaining('{report:plam.md}')]);
      }
    });

    it('accepts reports produced earlier in the callable itself without a caller', async () => {
      writeWorkflow(projectDir, '.takt/workflows/self.yaml', `name: self
subworkflow:
  callable: true
initial_step: produce
steps:
  - name: produce
    instruction: produce the report
    output_contracts:
      report:
        - name: plan.md
          format: simple-report
    rules:
      - condition: done
        next: work
  - name: work
    instruction: 'consume {report:plan.md}'
    rules:
      - condition: done
        next: COMPLETE
`);

      await doctorWorkflowCommand(['self'], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('validates required instruction args separately at each call site', async () => {
      writeWorkflow(projectDir, '.takt/facets/instructions/good.md', 'consume {report:plan.md}');
      writeWorkflow(projectDir, '.takt/facets/instructions/bad.md', 'consume {report:plam.md}');
      writeWorkflow(projectDir, '.takt/workflows/parameterized.yaml', `name: parameterized
subworkflow:
  callable: true
  params:
    work_instruction:
      type: facet_ref
      facet_kind: instruction
initial_step: work
steps:
  - name: work
    instruction:
      $param: work_instruction
    rules:
      - condition: done
        next: COMPLETE
`);
      writeWorkflow(projectDir, '.takt/workflows/args-parent.yaml', `name: args-parent
initial_step: produce
steps:
  - name: produce
    instruction: produce the report
    output_contracts:
      report:
        - name: plan.md
          format: simple-report
    rules:
      - condition: done
        next: good-call
  - name: good-call
    kind: workflow_call
    call: parameterized
    args:
      work_instruction: good
    rules:
      - condition: COMPLETE
        next: bad-call
  - name: bad-call
    kind: workflow_call
    call: parameterized
    args:
      work_instruction: bad
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

      await doctorWorkflowCommand(['args-parent'], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      const references = mockWarn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('{report:'));
      expect(references).toEqual([expect.stringContaining('{report:plam.md}')]);
      expect(references[0]).toContain('work');
      expect(references[0]).toContain('bad-call');
      expect(references[0]).not.toContain('good-call');
    });

    it('does not make a parallel workflow call sibling report visible', async () => {
      writeConsumer('consumer', 'review.md');
      writeWorkflow(projectDir, '.takt/workflows/producer.yaml', `name: producer
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    instruction: produce the report
    output_contracts:
      report:
        - name: review.md
          format: simple-report
    rules:
      - condition: done
        next: COMPLETE
`);
      const calls = `- name: branch-a
  kind: workflow_call
  call: producer
  description: Produce a review
  rules:
    - condition: COMPLETE
- name: branch-b
  kind: workflow_call
  call: consumer
  description: Consume a review
  rules:
    - condition: COMPLETE`;
      const parallel = calls.split('\n').map((line) => `      ${line}`).join('\n');
      writeWorkflow(projectDir, '.takt/workflows/parallel-parent.yaml', `name: parallel-parent
initial_step: branches
steps:
  - name: branches
    parallel:
${parallel}
    rules:
      - condition: all("COMPLETE")
        next: COMPLETE
`);

      await doctorWorkflowCommand(['parallel-parent'], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('{report:review.md}'));
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('branch-b'));
    });

    it.each(['fixed', 'pool'])('validates callable dynamic parallel %s instructions with their actual step name', async (branch) => {
      writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
initial_step: reviewers
steps:
  - name: reviewers
    parallel:
      fixed:
        - name: fixed-review
          instruction: '${branch === 'fixed' ? '{report:plan.md} {report:plam.md}' : 'review fixed'}'
          rules:
            - condition: approved
      pool:
        - name: pool-review
          description: Review the change
          instruction: '${branch === 'pool' ? '{report:plan.md} {report:plam.md}' : 'review pool'}'
          rules:
            - condition: approved
      selection:
        mode: replace
    rules:
      - condition: all("approved")
        next: COMPLETE
`);
      writeParent('parent', 'child', true);

      await doctorWorkflowCommand(['parent'], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      const references = mockWarn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('{report:'));
      expect(references).toEqual([expect.stringContaining('{report:plam.md}')]);
      expect(references[0]).toContain(`${branch}-review`);
    });

    it('validates callable loop monitor references using preceding ancestor reports', async () => {
      writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
initial_step: review
loop_monitors:
  - cycle: [review, fix]
    threshold: 2
    judge:
      instruction: '{report:plan.md} {report:plam.md}'
      rules:
        - condition: stop
          next: COMPLETE
steps:
  - name: review
    instruction: review the change
    rules:
      - condition: done
        next: fix
  - name: fix
    instruction: fix the change
    rules:
      - condition: done
        next: review
`);
      writeParent('parent', 'child', true);

      await doctorWorkflowCommand(['parent'], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      const references = mockWarn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('{report:'));
      expect(references).toEqual([expect.stringContaining('{report:plam.md}')]);
      expect(references[0]).toContain('judge');
      expect(references[0]).toContain('review');
      expect(references[0]).toContain('fix');
    });

    it('does not expose a child output to a subsequent parent instruction', async () => {
      writeConsumer('child', 'plan.md');
      const parentPath = writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
initial_step: produce
steps:
  - name: produce
    instruction: produce the report
    output_contracts:
      report:
        - name: plan.md
          format: simple-report
    rules:
      - condition: done
        next: delegate
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: consume
  - name: consume
    instruction: 'consume {report:result.md}'
    rules:
      - condition: done
        next: COMPLETE
`);

      await doctorWorkflowCommand([parentPath], projectDir);

      expect(mockError).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('{report:result.md}'));
    });
  });

  it('reports missing loop monitor judge references', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/missing-loop-monitor-refs.yaml', `name: missing-loop-monitor-refs
max_steps: 10
initial_step: step1
loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      persona: missing-judge
      instruction: missing-judge-instruction
      rules:
        - condition: retry
          next: step1
steps:
  - name: step1
    rules:
      - condition: continue
        next: step2
  - name: step2
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('loop monitor (step1 -> step2) persona references missing resource "missing-judge"');
    expect(messages).toContain('loop monitor (step1 -> step2) instruction references missing resource "missing-judge-instruction"');
  });

  it('reports missing refs for parallel substeps', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/missing-parallel-refs.yaml', `name: missing-parallel-refs
max_steps: 10
initial_step: step1
steps:
  - name: step1
    parallel:
      - name: part1
        persona: missing-part-persona
        instruction: missing-part-instruction
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('step "step1"/part1 persona references missing resource "missing-part-persona"');
    expect(messages).toContain('step "step1"/part1 instruction references missing resource "missing-part-instruction"');
  });

  it('reports unknown next steps and unreachable steps', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/routing.yaml', `name: routing
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: reroute
        next: missing-step
  - name: step2
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('Step "step1" routes to unknown next step "missing-step"');
    expect(messages).toContain('Unreachable steps: step2');
  });

  it('treats steps reachable from loop monitor transitions as reachable', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/loop-monitor-reachability.yaml', `name: loop-monitor-reachability
max_steps: 10
initial_step: step1
loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      rules:
        - condition: escape
          next: step3
steps:
  - name: step1
    rules:
      - condition: continue
        next: step2
  - name: step2
    rules:
      - condition: repeat
        next: step1
  - name: step3
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).not.toContain('Unreachable steps: step3');
  });

  it('reports missing initial_step target', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/initial.yaml', `name: initial
max_steps: 10
initial_step: missing
steps:
  - name: step1
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('initial_step references missing step "missing"');
    expect(messages).toContain('Unreachable steps: step1');
  });

  it('reports invalid auto_requeue_max_attempts from resolved project config', () => {
    writeWorkflow(projectDir, '.takt/config.yaml', 'auto_requeue_max_attempts: -1\n');
    invalidateAllResolvedConfigCache();

    const filePath = writeWorkflow(projectDir, '.takt/workflows/valid.yaml', `name: valid
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('auto_requeue_max_attempts');
  });

  it('reports invalid ignore_exceed from resolved project config', () => {
    writeWorkflow(projectDir, '.takt/config.yaml', 'ignore_exceed: 1\n');
    invalidateAllResolvedConfigCache();

    const filePath = writeWorkflow(projectDir, '.takt/workflows/valid.yaml', `name: valid
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('ignore_exceed');
  });

  it('reports unused section entries as warnings', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/unused.yaml', `name: unused
max_steps: 10
initial_step: step1
personas:
  unused-persona: ./facets/personas/unused-persona.md
instructions:
  used-step: ./facets/instructions/used-step.md
  unused-step: ./facets/instructions/unused-step.md
steps:
  - name: step1
    instruction: used-step
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/personas'), { recursive: true });
    mkdirSync(join(projectDir, '.takt/facets/instructions'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/personas/unused-persona.md'), 'persona', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/instructions/used-step.md'), 'instruction', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/instructions/unused-step.md'), 'instruction', 'utf-8');

    const diagnostics = inspectWorkflowFile(filePath, projectDir).diagnostics;

    expect(diagnostics).toContainEqual({
      level: 'warning',
      message: 'Unused personas entry "unused-persona"',
    });
    expect(diagnostics).toContainEqual({
      level: 'warning',
      message: 'Unused instructions entry "unused-step"',
    });
  });

  it('accepts callable subworkflow defaults referenced via $param', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/callable-defaults.yaml', `name: callable-defaults
subworkflow:
  callable: true
  params:
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
      default: [architecture]
    review_instruction:
      type: facet_ref
      facet_kind: instruction
      default: delegated-review
    review_report:
      type: facet_ref
      facet_kind: report_format
      default: summary
max_steps: 10
initial_step: review
knowledge:
  architecture: ./facets/knowledge/architecture.md
instructions:
  delegated-review: ./facets/instructions/delegated-review.md
report_formats:
  summary: ./facets/output-contracts/summary.md
steps:
  - name: review
    knowledge:
      $param: review_knowledge
    instruction:
      $param: review_instruction
    output_contracts:
      report:
        - name: summary.md
          format:
            $param: review_report
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/knowledge'), { recursive: true });
    mkdirSync(join(projectDir, '.takt/facets/instructions'), { recursive: true });
    mkdirSync(join(projectDir, '.takt/facets/output-contracts'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/knowledge/architecture.md'), 'Architecture', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/instructions/delegated-review.md'), 'Review', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/output-contracts/summary.md'), '# Summary', 'utf-8');

    const diagnostics = inspectWorkflowFile(filePath, projectDir).diagnostics;

    expect(diagnostics).toEqual([]);
  });

  it('accepts scalar policy and knowledge defaults referenced via $param', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/callable-scalar-defaults.yaml', `name: callable-scalar-defaults
subworkflow:
  callable: true
  params:
    review_policy:
      type: facet_ref
      facet_kind: policy
      default: strict-review
    review_knowledge:
      type: facet_ref
      facet_kind: knowledge
      default: architecture
max_steps: 10
initial_step: review
policies:
  strict-review: ./facets/policies/strict-review.md
knowledge:
  architecture: ./facets/knowledge/architecture.md
steps:
  - name: review
    policy:
      $param: review_policy
    knowledge:
      $param: review_knowledge
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/policies'), { recursive: true });
    mkdirSync(join(projectDir, '.takt/facets/knowledge'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/policies/strict-review.md'), 'Strict review', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/knowledge/architecture.md'), 'Architecture', 'utf-8');

    const diagnostics = inspectWorkflowFile(filePath, projectDir).diagnostics;

    expect(diagnostics).toEqual([]);
  });

  it('reports callable default facet refs whose values do not match facet_kind', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/callable-invalid-default.yaml', `name: callable-invalid-default
subworkflow:
  callable: true
  params:
    review_knowledge:
      type: facet_ref
      facet_kind: knowledge
      default: strict-review
max_steps: 10
initial_step: review
policies:
  strict-review: ./facets/policies/strict-review.md
steps:
  - name: review
    knowledge:
      $param: review_knowledge
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/policies'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/policies/strict-review.md'), 'Strict review', 'utf-8');

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain(
      'Workflow "callable-invalid-default.yaml" failed to load: workflow_call arg "review_knowledge" references unknown knowledge facet "strict-review"',
    );
  });

  it('reports callable default section map project facet symlinks as workflow load diagnostics', () => {
    const instructionsDir = join(projectDir, '.takt/facets/instructions');
    const outsideDir = join(projectDir, 'outside');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.md'), 'Secret instruction', 'utf-8');
    symlinkSync(join(outsideDir, 'secret.md'), join(instructionsDir, 'linked.md'));
    const filePath = writeWorkflow(projectDir, '.takt/workflows/callable-default-symlink.yaml', `name: callable-default-symlink
subworkflow:
  callable: true
  params:
    review_instruction:
      type: facet_ref
      facet_kind: instruction
      default: linked
max_steps: 1
initial_step: review
instructions:
  linked: ../facets/instructions/linked.md
steps:
  - name: review
    instruction:
      $param: review_instruction
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(
      /^Workflow "callable-default-symlink\.yaml" failed to load: Project facet file must stay inside the project and must not use symlinks:/,
    );
  });

  it('reports callable default section map package parent symlinks as workflow load diagnostics', () => {
    const ownerDir = join(process.env.TAKT_CONFIG_DIR!, 'repertoire', '@nrslib');
    const packageLink = join(ownerDir, 'pkg');
    const outsidePackageDir = join(projectDir, 'outside-package');
    const workflowsDir = join(outsidePackageDir, 'workflows');
    const instructionsDir = join(outsidePackageDir, 'facets/instructions');
    mkdirSync(ownerDir, { recursive: true });
    mkdirSync(workflowsDir, { recursive: true });
    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(join(instructionsDir, 'linked.md'), 'Secret instruction', 'utf-8');
    writeFileSync(join(workflowsDir, 'child.yaml'), `name: child
subworkflow:
  callable: true
  params:
    review_instruction:
      type: facet_ref
      facet_kind: instruction
      default: linked
max_steps: 1
initial_step: review
instructions:
  linked: ../facets/instructions/linked.md
steps:
  - name: review
    instruction:
      $param: review_instruction
`);
    symlinkSync(outsidePackageDir, packageLink, 'dir');

    const messages = inspectWorkflowFile(join(packageLink, 'workflows/child.yaml'), projectDir, {
      source: 'repertoire',
    }).diagnostics.map((item) => item.message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(
      /^Workflow "child\.yaml" failed to load: Scoped facet file must stay inside the repertoire and must not use symlinks:/,
    );
  });

  it('allows doctor inspection for callable subworkflows with required params', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/callable-required-param.yaml', `name: callable-required-param
subworkflow:
  callable: true
  params:
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
max_steps: 10
initial_step: review
steps:
  - name: review
    knowledge:
      $param: review_knowledge
    rules:
      - condition: done
        next: COMPLETE
`);

    const diagnostics = inspectWorkflowFile(filePath, projectDir).diagnostics;

    expect(diagnostics).toEqual([]);
  });

  it('reports unsupported nested workflow_call child return conditions for callable subworkflows with required params', () => {
    writeWorkflow(projectDir, '.takt/workflows/grandchild.yaml', `name: grandchild
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        return: ok
`);
    const filePath = writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
  params:
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    knowledge:
      $param: review_knowledge
    rules:
      - condition: continue
        next: delegate-grandchild
  - name: delegate-grandchild
    kind: workflow_call
    call: grandchild
    rules:
      - condition: retry_plan
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain(
      'Workflow "child.yaml" failed to load: workflow_call step "delegate-grandchild" cannot route on unsupported child result "retry_plan"',
    );
  });

  it('reports unsupported workflow_call child return conditions', () => {
    writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        return: ok
`);
    const filePath = writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: retry_plan
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain(
      'Workflow "parent.yaml" failed to load: workflow_call step "delegate" cannot route on unsupported child result "retry_plan"',
    );
  });

  it('reports unsupported parallel workflow_call child return conditions', () => {
    writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        return: ok
`);
    const filePath = writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
initial_step: review
max_steps: 3
steps:
  - name: review
    parallel:
      - name: delegate
        kind: workflow_call
        call: child
        rules:
          - condition: retry_plan
            next: COMPLETE
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain(
      'Workflow "parent.yaml" failed to load: workflow_call step "delegate" cannot route on unsupported child result "retry_plan"',
    );
  });

  it('reports unsupported nested workflow_call child return conditions', () => {
    writeWorkflow(projectDir, '.takt/workflows/grandchild.yaml', `name: grandchild
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        return: ok
`);
    writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
  returns: [ok]
initial_step: delegate-grandchild
max_steps: 3
steps:
  - name: delegate-grandchild
    kind: workflow_call
    call: grandchild
    rules:
      - condition: retry_plan
        next: COMPLETE
`);
    const filePath = writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: ok
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain(
      'Workflow "parent.yaml" failed to load: workflow_call step "delegate-grandchild" cannot route on unsupported child result "retry_plan"',
    );
  });

  it('does not read path-based workflow_call children during doctor inspection', () => {
    writeFileSync(join(projectDir, 'secret.txt'), 'SECRET_DOCTOR_MARKER: [not yaml', 'utf-8');
    const filePath = writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ../../secret.txt
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toEqual([]);
    expect(messages.join('\n')).not.toContain('SECRET_DOCTOR_MARKER');
  });

  it('does not warn for personas used by team_leader references', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/team-leader-used-personas.yaml', `name: team-leader-used-personas
max_steps: 10
initial_step: step1
personas:
  lead: ./facets/personas/lead.md
  worker: ./facets/personas/worker.md
steps:
  - name: step1
    team_leader:
      persona: lead
      part_persona: worker
    instruction: decompose
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/personas'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/personas/lead.md'), 'lead persona', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/personas/worker.md'), 'worker persona', 'utf-8');

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).not.toContain('Unused personas entry "lead"');
    expect(messages).not.toContain('Unused personas entry "worker"');
  });

  it('does not treat report.order as a missing output-contract ref', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/report-order-inline.yaml', `name: report-order-inline
max_steps: 10
initial_step: step1
report_formats:
  plan: ./facets/output-contracts/plan.md
steps:
  - name: step1
    output_contracts:
      report:
        - name: 00-plan.md
          format: plan
          order: Output to {report:00-plan.md} and overwrite if it already exists.
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/output-contracts'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/output-contracts/plan.md'), '# Plan', 'utf-8');

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).not.toContainEqual(expect.stringContaining('output_contract order references missing resource'));
  });

  it('loads report.order inline templates without resolving them as facet refs', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/report-order-loader.yaml', `name: report-order-loader
max_steps: 10
initial_step: step1
report_formats:
  plan: ./facets/output-contracts/plan.md
steps:
  - name: step1
    output_contracts:
      report:
        - name: 00-plan.md
          format: plan
          order: Output to {report:00-plan.md} file.
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/output-contracts'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/output-contracts/plan.md'), '# Plan', 'utf-8');

    const config = loadWorkflowFromFile(filePath, projectDir);

    expect(config.steps[0]?.outputContracts?.[0]).toMatchObject({
      name: '00-plan.md',
      order: 'Output to {report:00-plan.md} file.',
    });
  });

  it('validates all project workflow files when no targets are given', async () => {
    writeWorkflow(projectDir, '.takt/workflows/valid.yaml', `name: valid
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(projectDir, '.takt/workflows/broken.yaml', `name: broken
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: missing
`);

    await expect(doctorWorkflowCommand([], projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('valid.yaml'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('missing'));
  });

  it('inspects privileged builtin workflows without downgrading them to project trust', () => {
    const builtinPath = join(process.cwd(), 'builtins', 'ja', 'workflows', 'auto-improvement-loop.yaml');

    const report = inspectWorkflowFile(builtinPath, process.cwd());

    expect(report.diagnostics).toEqual([]);
  });


  it('resolves named builtin workflow targets without downgrading privileged builtin trust', async () => {
    await expect(doctorWorkflowCommand(['auto-improvement-loop'], process.cwd())).resolves.toBeUndefined();

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('auto-improvement-loop.yaml'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('rejects named builtin workflow targets when builtin workflows are disabled', async () => {
    writeFileSync(join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'), 'enable_builtin_workflows: false\n', 'utf-8');
    invalidateGlobalConfigCache();

    await expect(doctorWorkflowCommand(['auto-improvement-loop'], process.cwd())).rejects.toThrow(
      'Workflow not found: auto-improvement-loop',
    );

    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it('rejects named builtin workflow targets when the builtin is individually disabled', async () => {
    writeFileSync(
      join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'),
      'disabled_builtins:\n  - auto-improvement-loop\n',
      'utf-8',
    );
    invalidateGlobalConfigCache();

    await expect(doctorWorkflowCommand(['auto-improvement-loop'], process.cwd())).rejects.toThrow(
      'Workflow not found: auto-improvement-loop',
    );

    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it('resolves named builtin workflow targets from loader-side target resolution', () => {
    const [target] = resolveWorkflowDoctorTargets(['auto-improvement-loop'], process.cwd());

    expect(target).toMatchObject({
      filePath: expect.stringContaining('auto-improvement-loop.yaml'),
      source: 'builtin',
    });
  });

  it.each(worktreeRootCases)(
    'allows runtime.prepare for explicitly targeted worktree workflow paths in $name',
    async (rootCase) => {
      writeConfigForCase(rootCase);
      const { rootDirRelativePath } = rootCase;
      const rootDir = join(projectDir, rootDirRelativePath);
      // 共有 tmp 配下（../takt-worktrees は $TMPDIR 直下で全テストファイルが
      // 同一パスを共有する）での並走衝突を避けるため、branch dir 名は
      // テストごとに一意にする。
      const worktreeDir = join(rootDir, `feature-branch-${randomUUID()}`);
      createdWorktreeDirs.push(worktreeDir);
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'prepare.yaml');
      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: prepare
max_steps: 10
initial_step: review
workflow_config:
  runtime:
    prepare:
      - node
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

      await expect(
        doctorWorkflowCommand([relative(projectDir, worktreeWorkflowPath)], projectDir),
      ).resolves.toBeUndefined();

      expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('prepare.yaml'));
      expect(mockError).not.toHaveBeenCalled();
    },
  );

  it.each(worktreeRootCases)(
    'allows allow_git_commit for explicitly targeted worktree workflow paths in $name',
    async (rootCase) => {
      writeConfigForCase(rootCase);
      const { rootDirRelativePath } = rootCase;
      const rootDir = join(projectDir, rootDirRelativePath);
      // 共有 tmp 配下（../takt-worktrees は $TMPDIR 直下で全テストファイルが
      // 同一パスを共有する）での並走衝突を避けるため、branch dir 名は
      // テストごとに一意にする。
      const worktreeDir = join(rootDir, `feature-branch-${randomUUID()}`);
      createdWorktreeDirs.push(worktreeDir);
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'commit.yaml');
      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: commit
max_steps: 10
initial_step: review
steps:
  - name: review
    allow_git_commit: true
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

      await expect(
        doctorWorkflowCommand([relative(projectDir, worktreeWorkflowPath)], projectDir),
      ).resolves.toBeUndefined();

      expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('commit.yaml'));
      expect(mockError).not.toHaveBeenCalled();
    },
  );

  it.each(worktreeRootCases)(
    'passes derived worktree lookupCwd into workflow_call contract validation for path targets in $name',
    async (rootCase) => {
      writeConfigForCase(rootCase);
      const validateContractsSpy = vi.spyOn(workflowResolver, 'validateWorkflowCallContracts');
      const { rootDirRelativePath } = rootCase;
      const rootDir = join(projectDir, rootDirRelativePath);
      // 共有 tmp 配下（../takt-worktrees は $TMPDIR 直下で全テストファイルが
      // 同一パスを共有する）での並走衝突を避けるため、branch dir 名は
      // テストごとに一意にする。
      const worktreeDir = join(rootDir, `feature-branch-${randomUUID()}`);
      createdWorktreeDirs.push(worktreeDir);
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');

      writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
`, 'utf-8');

      try {
        await expect(
          doctorWorkflowCommand([relative(projectDir, worktreeWorkflowPath)], projectDir),
        ).resolves.toBeUndefined();

        expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('parent.yaml'));
        expect(validateContractsSpy).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'parent' }),
          projectDir,
          worktreeDir,
          { allowPathBasedCalls: false },
        );
      } finally {
        validateContractsSpy.mockRestore();
      }
    },
  );

  it.each(worktreeRootCases)(
    'derives worktree lookupCwd from loader-side target resolution for path targets in $name',
    (rootCase) => {
      writeConfigForCase(rootCase);
      const { rootDirRelativePath } = rootCase;
      const rootDir = join(projectDir, rootDirRelativePath);
      // 共有 tmp 配下（../takt-worktrees は $TMPDIR 直下で全テストファイルが
      // 同一パスを共有する）での並走衝突を避けるため、branch dir 名は
      // テストごとに一意にする。
      const worktreeDir = join(rootDir, `feature-branch-${randomUUID()}`);
      createdWorktreeDirs.push(worktreeDir);
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');

      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    rules:
      - condition: COMPLETE
        next: COMPLETE
`, 'utf-8');

      const [target] = resolveWorkflowDoctorTargets([relative(projectDir, worktreeWorkflowPath)], projectDir);

      expect(target).toEqual({
        filePath: worktreeWorkflowPath,
        lookupCwd: worktreeDir,
      });
    },
  );

  it('passes absolute configured worktree_dir into workflow_call contract validation for path targets', async () => {
    const configuredRoot = mkdtempSync(join(tmpdir(), 'takt-doctor-worktrees-'));
    const validateContractsSpy = vi.spyOn(workflowResolver, 'validateWorkflowCallContracts');

    writeWorkflow(process.env.TAKT_CONFIG_DIR!, 'config.yaml', `worktree_dir: ${configuredRoot}\n`);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const worktreeDir = join(configuredRoot, 'feature-branch');
    const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');

    writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
    writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
`, 'utf-8');

    try {
      await expect(
        doctorWorkflowCommand([relative(projectDir, worktreeWorkflowPath)], projectDir),
      ).resolves.toBeUndefined();

      expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('parent.yaml'));
      expect(validateContractsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'parent' }),
        projectDir,
        worktreeDir,
        { allowPathBasedCalls: false },
      );
    } finally {
      validateContractsSpy.mockRestore();
      rmSync(configuredRoot, { recursive: true, force: true });
    }
  });

  it('resolves named workflow targets and validates them', async () => {
    writeWorkflow(projectDir, '.takt/workflows/named.yaml', `name: named
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: COMPLETE
`);

    await doctorWorkflowCommand(['named'], projectDir);

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('named.yaml'));
  });
});
