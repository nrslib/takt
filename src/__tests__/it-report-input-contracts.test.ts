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
          const identityColumn = language === 'ja' ? '契約ID / 出典' : 'Contract ID / Source';
          expect(contract.format.split('\n').filter((line) => line.startsWith('| ' + identityColumn))).toHaveLength(2);
          const states = language === 'ja' ? ['未完了', '環境要因で未実証', '未完了', '確認済み'] : ['Incomplete', 'Environment-limited', 'Incomplete', 'Verified'];
          const statusRules = contract.order!.split('\n').filter((line) => line.startsWith('- '));
          expect(statusRules).toHaveLength(states.length);
          statusRules.forEach((line, index) => expect(line).toContain(states[index]!));
          expect(contract.order).toMatch(language === 'ja' ? /IDのない行.*契約IDを作らず/ : /rows without IDs.*do not invent a contract ID/);
          expect(contract.order).toMatch(language === 'ja' ? /変更・撤回.*現行の要求に残る行/ : /modify or withdraw.*current requirements/);
          expect(contract.format).toContain(language === 'ja'
            ? '不明（実装状態・箇所が未確認） / 未実装（実装がないことを確認済み）'
            : 'unknown (implementation status or location unconfirmed) / not implemented (absence confirmed)');
          const verificationSource = language === 'ja'
            ? '検証の出典: {渡されたテスト名・ファイル位置・その他の証拠出典を省略せず保持。未提示なら「未提示」}'
            : 'Verification source: {retain all supplied test names, file locations, and other evidence sources; mark missing source information as "not supplied"}';
          expect(contract.format).toContain(verificationSource);
          expect(prepared.text).toContain(verificationSource);
          expect(report).toContain(verificationSource);
          expect(contract.order).toContain(language === 'ja'
            ? '実装状態・実装箇所が未確認の場合は「不明」と記載してください。'
            : 'When implementation status or location is unconfirmed, record it as unknown.');
          expect(contract.order).toContain(language === 'ja'
            ? '情報・検証が不足しているだけで未実装と断定せず、実装がないことを確認した場合だけ「未実装」と記載してください。'
            : 'Missing information or verification alone does not establish absent implementation; record "not implemented" only when absence has been confirmed.');
        }
      });
  }
});
