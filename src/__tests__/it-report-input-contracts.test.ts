import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import type { WorkflowConfig } from '../core/models/types.js';
import { getBuiltinWorkflowsDir } from '../infra/config/paths.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { makeInstructionContext } from './test-helpers.js';

describe('builtin implementation report input contracts', () => {
  let root: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-report-contracts-'));
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = join(root, 'global');
    mkdirSync(join(root, '.takt'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = originalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  for (const language of ['ja', 'en'] as const) {
    it.each(['default', 'simple', 'simple-mini', 'frontend-mini', 'maintenance', 'takt-default-team'])
      ('shares the evidence format between work and reports for %s (' + language + ')', (name) => {
        writeFileSync(join(root, '.takt', 'config.yaml'), `language: ${language}\n`);
        const workflow = loadWorkflowFromFile(join(getBuiltinWorkflowsDir(language), `${name}.yaml`), root);
        const workflows: WorkflowConfig[] = [];
        const pending = [workflow];
        const visited = new Set<string>();
        while (pending.length > 0) {
          const current = pending.pop()!;
          if (visited.has(current.name)) continue;
          visited.add(current.name);
          workflows.push(current);
          for (const step of current.steps) {
            if (step.kind !== 'workflow_call') continue;
            const child = resolveWorkflowCallTarget(current, step, root);
            expect(child).not.toBeNull();
            if (child) pending.push(child);
          }
        }
        const implementationSteps = workflows.flatMap((entry) => entry.steps)
          .filter((step) => step.outputContracts?.some((entry) => entry.name === 'implementation-report.md'));
        expect(implementationSteps.length).toBeGreaterThan(0);
        for (const step of implementationSteps) {
          const contract = step.outputContracts!.find((entry) => entry.name === 'implementation-report.md')!;
          expect(contract.format).toBeTruthy();
          expect(contract.order).toBeTruthy();
          const context = makeInstructionContext({
            cwd: root, projectCwd: root, language, reportDir: join(root, 'reports'),
            userInputs: ['Withdraw the obsolete obligation.'],
          });
          const prepared = new InstructionBuilder(step, context).prepare();
          const report = new ReportInstructionBuilder(step, {
            cwd: root, language, reportDir: context.reportDir!, stepIteration: 1,
            targetFile: 'implementation-report.md', reportInputs: prepared.reportInputs,
          }).build();
          expect(prepared.text).toContain(contract.format);
          expect(prepared.text).toContain(contract.order!);
          expect(report).toContain(contract.format);
          expect(report).toContain(contract.order!);
          expect(report).toContain(JSON.stringify(context.userInputs));
        }
      });
  }
});
