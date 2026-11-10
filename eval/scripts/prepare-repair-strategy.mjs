#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRepairStrategyFixture, repairStrategyWorkDirectory, REPAIR_STRATEGY_CASES, REPAIR_STRATEGY_LANGUAGES } from '../repair-strategy-cases.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => readFileSync(path, 'utf8');

// Keep history selection and immutable references on the production resolver path.
export async function prepareRepairStrategy({ workRoot = join(repo, 'eval/.work'), promptRoot = join(repo, 'eval/prompts') } = {}) {
  process.env.TAKT_CONFIG_DIR = join(repo, 'eval/config');
  const { loadWorkflowByIdentifier, resolveWorkflowCallTarget, loadPersonaPromptFromPath } = await import('../../dist/infra/config/index.js');
  const { InstructionBuilder } = await import('../../dist/core/workflow/instruction/InstructionBuilder.js');
  const { ReportInstructionBuilder } = await import('../../dist/core/workflow/instruction/ReportInstructionBuilder.js');
  const { resolveDeclaredReportInputs } = await import('../../dist/core/workflow/instruction/declared-report-inputs.js');
  const { createInitialState } = await import('../../dist/core/workflow/engine/state-manager.js');
  const { WorkflowCallInvocationIndex } = await import('../../dist/core/workflow/workflow-call-invocation-index.js');
  const { WorkflowStepParticipationIndex, buildWorkflowStepParticipationIdentity } = await import('../../dist/core/workflow/workflow-step-participation-index.js');
  const { buildWorkflowCallNamespaceSegment } = await import('../../dist/core/workflow/workflow-call-namespace.js');
  const { buildWorkflowResumePointEntry, getWorkflowReference } = await import('../../dist/core/workflow/workflow-reference.js');
  const { ReportExecutionStore } = await import('../../dist/core/workflow/report-execution-store.js');
  const { mergeWorkflowWideRules } = await import('../../dist/core/workflow/engine/workflow-wide-rule-merge.js');
  mkdirSync(promptRoot, { recursive: true });
  const receipts = [];
  for (const language of REPAIR_STRATEGY_LANGUAGES) {
    for (const caseId of REPAIR_STRATEGY_CASES) {
      for (const stage of ['adjudication', 'plan']) {
        const id = `repair-strategy-${stage}-${caseId}${language === 'en' ? '-en' : ''}`;
        const project = join(workRoot, repairStrategyWorkDirectory(caseId, language, stage));
        rmSync(project, { recursive: true, force: true });
        const { hasHistory } = buildRepairStrategyFixture(project, caseId, language);
        const reportDir = join(project, '.takt/runs/eval/reports');
        mkdirSync(reportDir, { recursive: true });
        cpSync(join(project, 'reports-seed'), reportDir, { recursive: true });
        const workflow = loadWorkflowByIdentifier(join(repo, `builtins/${language}/workflows/peer-review.yaml`), project);
        if (!workflow) throw new Error('peer-review missing');
        const call = workflow.steps.find(step => step.name === 'remediation');
        const adjudication = workflow.steps.find(step => step.name === 'review-adjudication');
        if (call?.kind !== 'workflow_call' || !adjudication) throw new Error('peer-review repair stages missing');
        const child = resolveWorkflowCallTarget(workflow, call, project, project);
        if (!child) throw new Error('remediation missing');
        const plan = child.steps.find(step => step.name === 'fix-plan');
        if (!plan) throw new Error('fix-plan missing');
        const state = createInitialState(workflow, { projectCwd: project });
        const invocations = new WorkflowCallInvocationIndex(new Map());
        const participation = new WorkflowStepParticipationIndex(new Map());
        const store = new ReportExecutionStore(reportDir);
        const sharedRuntime = {
          startedAtMs: 0,
          workflowCallInvocationEvidence: { kind: 'exact', index: invocations },
          workflowStepParticipationIndex: participation,
          reportExecutions: store,
        };
        const fixedReferences = [];
        if (hasHistory) {
          const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(workflow), call.name, []);
          for (const iteration of [1, 2]) {
            const segment = buildWorkflowCallNamespaceSegment(call.name, child.name, iteration);
            const directory = join(reportDir, 'subworkflows', segment);
            const path = [buildWorkflowResumePointEntry(workflow, call.name, 'workflow_call', iteration, undefined, iteration)];
            const reports = ['fix-plan.md', 'fix-report.md', 'fix-verification.md'];
            invocations.record(workflow, call.name, [], {
              call_instance: iteration, report_namespace_segment: segment, completed: true,
            });
            const execution = store.begin(identity, `${workflow.name} / ${call.name}`, reportDir,
              reports.map(name => `subworkflows/${segment}/${name}`));
            for (const [index, name] of reports.entries()) {
              const producer = ['fix-plan', 'fix', 'fix-verifier'][index];
              participation.record(child, producer, path, [name]);
              mkdirSync(directory, { recursive: true });
              const body = read(join(project, `history/repair-${iteration}`, name));
              writeFileSync(join(directory, name), body);
              store.capture(directory, name, body);
            }
            store.finish(execution, true);
            for (const name of reports) {
              const fixed = store.current(identity, `subworkflows/${segment}/${name}`);
              if (!fixed) throw new Error('Missing fixed repair report');
              fixedReferences.push({ iteration, name, path: fixed.path, execution: fixed.execution });
            }
          }
        }
        const resolverContext = {
          workflow, state, sharedRuntime,
          workflowCallResolver: ({ parentWorkflow, step }) => resolveWorkflowCallTarget(parentWorkflow, step, project, project),
          projectCwd: project, lookupCwd: project, reportDir, resumeStackPrefix: [],
        };
        const repairInputs = resolveDeclaredReportInputs(adjudication, resolverContext);
        const historyText = hasHistory
          ? fixedReferences.map(item => `修正${item.iteration} ${item.name}: ${item.path}`).join('\n')
          : '過去の修正記録はない。';
        const migration = caseId === 'p1'
          ? '\n進行中の作業資料: history/migration-plan.md、history/migration-report.md、history/migration-verification.md。これは完了済み実行として登録していない。'
          : '';
        const ongoingMaterials = caseId === 'p1' && stage === 'adjudication'
          ? (language === 'ja' ? '\n## 進行中の作業資料（完了済み履歴とは別）\n' : '\n## Work in progress (separate from completed history)\n')
            + ['plan', 'report', 'verification'].map(kind => {
              const path = `history/migration-${kind}.md`;
              return `### ${path}\n${read(join(project, path))}`;
            }).join('\n')
          : '';
        const previousDecision = hasHistory
          ? '# 前回の裁定\nCODE-A と CODE-B は修正対象として採用し、それぞれの検証後に解消済みとした。履歴は以下。\n'
          : '# 前回の裁定\n前回の裁定と修正はない。\n';
        const resolution = (stage === 'plan' ? read(join(project, 'reports-seed/review-resolution.md')) : previousDecision)
          + `\n## 修正の経過\n${historyText}${migration}\n`;
        writeFileSync(join(reportDir, 'review-resolution.md'), resolution);
        writeFileSync(join(project, 'reports-seed/review-resolution.md'), resolution);
        const decisionIdentity = buildWorkflowStepParticipationIdentity(getWorkflowReference(workflow), adjudication.name, []);
        const decisionExecution = store.begin(decisionIdentity, `${workflow.name} / ${adjudication.name}`, reportDir, ['review-resolution.md']);
        store.capture(reportDir, 'review-resolution.md', resolution);
        store.finish(decisionExecution, true);
        participation.record(workflow, adjudication.name, [], ['review-resolution.md']);
        const decisionInputs = resolveDeclaredReportInputs(call, resolverContext);
        const prepareStage = (stage, target, config, declared) => {
          const snapshotDir = join(project, '.takt/eval-snapshots');
          mkdirSync(snapshotDir, { recursive: true });
          const snapshot = (kind, entries) => {
            const path = join(snapshotDir, `${kind}.md`);
            writeFileSync(path, (entries ?? []).map(entry => entry.content).join('\n\n---\n\n'));
            return path;
          };
          const policySourcePath = snapshot('policies', target.policyContents);
          const knowledgeSourcePath = snapshot('knowledge', target.knowledgeContents);
          const prepared = new InstructionBuilder(target, {
            task: '@@TASK@@', iteration: hasHistory ? 8 : 1, maxSteps: config.maxSteps,
            stepIteration: hasHistory ? 2 : 1, cwd: project, projectCwd: project, userInputs: [],
            workflowName: config.name, workflowSteps: config.steps,
            currentStepIndex: config.steps.indexOf(target), reportDir, reportsRootDir: reportDir,
            policySourcePath, knowledgeSourcePath, language,
            workflowRules: mergeWorkflowWideRules(workflow.allStepsRules, config.allStepsRules),
            declaredReportInputs: declared === undefined ? undefined : [declared], workflowState: state,
          }).prepare();
          const persona = target.personaPath ? loadPersonaPromptFromPath(target.personaPath, project).trim() : '';
          const phase1 = `${persona}\n\n${prepared.text}${ongoingMaterials}`.replaceAll('@@TASK@@', '{{task}}');
          const report = new ReportInstructionBuilder(target, {
            cwd: project, task: '@@TASK@@', reportDir, stepIteration: 1, language,
            targetFile: stage === 'adjudication' ? 'review-resolution.md' : 'fix-plan.md',
            lastResponse: '@@RESPONSE@@', injectedReports: prepared.injectedReports,
          }).build().replaceAll('@@TASK@@', '{{task}}').replaceAll('@@RESPONSE@@', '{{previous_response}}');
          writeFileSync(join(promptRoot, `${id}.phase1.md`), phase1);
          writeFileSync(join(promptRoot, `${id}.phase2.md`), report);
          receipts.push({ caseId, language, stage, id, project, fixedReferences,
            declaredReports: declared?.reports ?? [], injectedReports: prepared.injectedReports });
        };
        if (stage === 'adjudication') prepareStage(stage, adjudication, workflow, repairInputs);
        else prepareStage(stage, plan, child, decisionInputs);
      }
    }
  }
  writeFileSync(join(promptRoot, 'repair-strategy-receipts.json'), JSON.stringify(receipts, null, 2) + '\n');
  return receipts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareRepairStrategy();
}
