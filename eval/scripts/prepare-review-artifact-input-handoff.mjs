#!/usr/bin/env node
/** Freeze the four #1803 artifact handoff prompts with real resolver evidence. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baselineSnapshot = JSON.parse(readFileSync(
  join(repo, 'eval/fixtures/review-artifact-input-handoff/baseline-lines.json'),
  'utf8',
));
const baselineSha = baselineSnapshot.baseline_sha;
const project = join(repo, 'eval/.work/review-artifact-input-handoff');
const prompts = join(repo, 'eval/prompts/review-artifact-input-handoff');
process.env.TAKT_CONFIG_DIR = join(repo, 'eval/config');

const { loadWorkflowByIdentifier } = await import('../../dist/infra/config/loaders/workflowResolver.js');
const { resolveWorkflowCallTarget } = await import('../../dist/infra/config/loaders/workflowCallResolver.js');
const { loadPersonaPromptFromPath } = await import('../../dist/infra/config/index.js');
const { InstructionBuilder } = await import('../../dist/core/workflow/instruction/InstructionBuilder.js');
const { resolveDeclaredReportInputs } = await import('../../dist/core/workflow/instruction/declared-report-inputs.js');
const { createInitialState } = await import('../../dist/core/workflow/engine/state-manager.js');
const { WorkflowCallInvocationIndex } = await import('../../dist/core/workflow/workflow-call-invocation-index.js');
const { WorkflowStepParticipationIndex } = await import('../../dist/core/workflow/workflow-step-participation-index.js');
const { buildWorkflowCallNamespaceSegment } = await import('../../dist/core/workflow/workflow-call-namespace.js');
const { buildWorkflowResumePointEntry } = await import('../../dist/core/workflow/workflow-reference.js');
const { buildDynamicParallelSelectionIdentity } = await import('../../dist/core/workflow/dynamic-parallel/identity.js');

{
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), 'Read the supplied task and the available workflow reports. This is a read-only evaluation fixture.\n');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src/token-reuse.mjs'), [
    'export function dispatchWithToken(token, tenantId, send) {',
    '  send(token);',
    '  if (token.tenantId !== tenantId) throw new Error("wrong tenant");',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(project, 'src/routes.mjs'), [
    'export async function saveRecord(db, user, record) {',
    '  await db.insert(record);',
    '  if (!user.canWrite) throw new Error("forbidden");',
    '}',
    '',
  ].join('\n'));
  mkdirSync(join(project, 'tests'), { recursive: true });
  writeFileSync(join(project, 'tests/token-reuse.test.mjs'), [
    'import { dispatchWithToken } from "../src/token-reuse.mjs";',
    'const sent = [];',
    'dispatchWithToken({ tenantId: "tenant-a" }, "tenant-a", (token) => sent.push(token));',
    'if (sent.length !== 1) throw new Error("expected matching token dispatch");',
    '',
  ].join('\n'));
  mkdirSync(join(project, '.takt'), { recursive: true });
  writeFileSync(join(project, '.takt/config.yaml'), 'language: ja\n');
  mkdirSync(prompts, { recursive: true });

  const currentWorkflow = (name) => {
    const path = join(repo, 'builtins/ja/workflows', `${name}.yaml`);
    const workflow = loadWorkflowByIdentifier(path, project);
    if (!workflow) throw new Error(`Current workflow ${name} missing`);
    return workflow;
  };
  const childOf = (workflow, stepName) => {
    const step = workflow.steps.find((candidate) => candidate.name === stepName);
    if (step?.kind !== 'workflow_call') throw new Error(`Call ${workflow.name}/${stepName} missing`);
    const child = resolveWorkflowCallTarget(workflow, step, project, project);
    if (!child) throw new Error(`Child ${workflow.name}/${stepName} missing`);
    return child;
  };
  const stepOf = (workflow, name) => {
    const step = workflow.steps.find((candidate) => candidate.name === name);
    if (!step) throw new Error(`Step ${workflow.name}/${name} missing`);
    return step;
  };
  const oldInstruction = (currentStep, id) => {
    const snapshot = baselineSnapshot.lines[id];
    if (!snapshot) throw new Error(`Baseline instruction ${id} missing`);
    if (id === 'follow-up') {
      return { ...currentStep, instruction: `${currentStep.instruction.trimEnd()}\n\n${snapshot.baseline_line}` };
    }
    const sourceLines = readFileSync(join(repo, snapshot.source), 'utf8').split('\n');
    const currentLine = snapshot.current_line.trimStart();
    const baselineLine = snapshot.baseline_line.trimStart();
    const currentBlock = [currentLine, ...(snapshot.current_tail ?? [])].join('\n');
    if (!sourceLines.includes(snapshot.current_line) || !currentStep.instruction.includes(currentBlock)) {
      throw new Error(`Current instruction differs from the frozen ${id} line`);
    }
    return { ...currentStep, instruction: currentStep.instruction.replace(currentBlock, baselineLine) };
  };
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const receipts = [];

  function prepareCase(id, spec) {
    const current = currentWorkflow(spec.workflow);
    const source = stepOf(current, spec.source);
    const consumer = stepOf(current, spec.consumer);
    if (!consumer.inputReports || consumer.inputReports.fromStep !== source.name) {
      throw new Error(`${id}: missing declared source`);
    }
    const reportDir = join(project, '.takt/runs/eval', id, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const state = createInitialState(current, { projectCwd: project });
    if (id === 'merge') {
      state.systemContexts.set('wait_ci', {
        status: {
          headSha: 'a'.repeat(40),
          ci: { passed: true },
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          reviewDecision: 'APPROVED',
        },
      });
    }
    const invocations = new WorkflowCallInvocationIndex(new Map());
    const participation = new WorkflowStepParticipationIndex(new Map());
    const sharedRuntime = {
      startedAtMs: 0,
      workflowCallInvocationEvidence: { kind: 'exact', index: invocations },
      workflowStepParticipationIndex: participation,
    };
    const registerCall = (parent, stepName, parentPath, parentDirectory, instance = 1) => {
      const step = stepOf(parent, stepName);
      if (step.kind !== 'workflow_call') throw new Error(`${id}: ${stepName} is not a call`);
      const child = childOf(parent, stepName);
      const segment = buildWorkflowCallNamespaceSegment(step.name, child.name, instance);
      invocations.record(parent, step.name, parentPath, {
        call_instance: instance,
        report_namespace_segment: segment,
        completed: true,
      });
      const path = [
        ...parentPath,
        buildWorkflowResumePointEntry(parent, step.name, 'workflow_call', instance, undefined, instance),
      ];
      const directory = join(parentDirectory, 'subworkflows', segment);
      mkdirSync(directory, { recursive: true });
      return { child, path, directory, segment };
    };
    const registerReport = (workflow, stepName, path, directory, name, body, parallelParent) => {
      const step = parallelParent === undefined
        ? stepOf(workflow, stepName)
        : stepOf(workflow, parallelParent).parallel && [
            ...(stepOf(workflow, parallelParent).parallel.fixed ?? []),
            ...(stepOf(workflow, parallelParent).parallel.pool ?? []),
          ].find((candidate) => candidate.name === stepName);
      if (!step?.outputContracts?.some((entry) => entry.name === name)) {
        throw new Error(`${id}: ${workflow.name}/${stepName} does not contract ${name}`);
      }
      const reportNames = participation.get(workflow, stepName, path, parallelParent)?.report_names ?? [];
      participation.record(workflow, stepName, path, [...reportNames, name], parallelParent);
      writeFileSync(join(directory, name), body.trim() + '\n');
    };
    const registerDynamic = (workflow, stepName, path, directory, selected) => {
      const step = stepOf(workflow, stepName);
      if (step.parallel?.kind !== 'dynamic') throw new Error(`${id}: ${stepName} is not dynamic`);
      participation.record(workflow, stepName, path, []);
      const identity = buildDynamicParallelSelectionIdentity(workflow, stepName, path);
      state.dynamicParallelSelections.set(identity, {
        identity,
        step_name: stepName,
        round: 1,
        selected_pool_ids: selected.filter(([name]) => step.parallel.pool.some((candidate) => candidate.name === name)).map(([name]) => name),
        effective_selection_ids: selected.map(([name]) => name),
      });
      for (const [name, file, body] of selected) {
        registerReport(workflow, name, path, directory, file, body, stepName);
      }
    };

    spec.seed({ current, reportDir, registerCall, registerReport, registerDynamic });
    const declaredReportInputs = resolveDeclaredReportInputs(consumer, {
      workflow: current,
      state,
      sharedRuntime,
      workflowCallResolver: ({ parentWorkflow, step }) => resolveWorkflowCallTarget(parentWorkflow, step, project, project),
      projectCwd: project,
      lookupCwd: project,
      reportDir,
      resumeStackPrefix: [],
    });
    if (declaredReportInputs === undefined
      || !declaredReportInputs.reports.some(({ content }) => content.includes(spec.expected))) {
      throw new Error(`${id}: expected source receipt missing`);
    }
    const currentTarget = spec.currentTarget(current);
    const baselineTarget = spec.baselineTarget(currentTarget);
    const baseline = {
      ...current,
      steps: current.steps.map((step) => {
        if (step.name !== consumer.name) return step;
        const { inputReports: _inputReports, ...withoutInputs } = step;
        return step === currentTarget
          ? { ...withoutInputs, instruction: baselineTarget.instruction }
          : withoutInputs;
      }),
    };
    const targetReportDir = spec.targetReportDir?.(reportDir) ?? reportDir;
    mkdirSync(targetReportDir, { recursive: true });
    for (const name of spec.shadowNames ?? []) {
      writeFileSync(join(targetReportDir, name), `UNRELATED-SHADOW-${id}-${name}`);
    }
    const build = (step, workflow, supplied) => {
      const prepared = new InstructionBuilder(step, {
        task: '@@EVAL_TASK@@',
        iteration: 5,
        maxSteps: workflow.maxSteps,
        stepIteration: 2,
        cwd: project,
        projectCwd: project,
        userInputs: [],
        reportDir: targetReportDir,
        reportsRootDir: reportDir,
        language: 'ja',
        workflowName: workflow.name,
        workflowSteps: workflow.steps,
        currentStepIndex: workflow.steps.findIndex((entry) => entry.name === step.name),
        declaredReportInputs: supplied === undefined ? undefined : [supplied],
        workflowState: state,
      }).prepare();
      const persona = step.personaPath ? loadPersonaPromptFromPath(step.personaPath, project).trim() : '';
      return {
        prompt: `${persona ? `${persona}\n\n` : ''}${prepared.text}`.replaceAll('@@EVAL_TASK@@', '{{task}}'),
        injectedReports: prepared.injectedReports,
      };
    };
    const baselinePrompt = build(baselineTarget, baseline, undefined).prompt;
    const currentBuilt = build(currentTarget, current, declaredReportInputs);
    const currentPrompt = currentBuilt.prompt;
    if (baselinePrompt.includes('## 宣言された成果物入力')
      || currentPrompt.includes('## 宣言された成果物入力') !== spec.expectTail) {
      throw new Error(`${id}: prompt handoff boundary mismatch`);
    }
    if (baselinePrompt.includes(spec.expected) || !currentPrompt.includes(spec.expected)) {
      throw new Error(`${id}: receipt is not candidate-only`);
    }
    if (currentPrompt.includes(`UNRELATED-SHADOW-${id}-`)) {
      throw new Error(`${id}: unrelated same-name report shadowed the declared producer`);
    }
    writeFileSync(join(prompts, `${id}-baseline.md`), baselinePrompt);
    writeFileSync(join(prompts, `${id}-current.md`), currentPrompt);
    receipts.push({
      case: id,
      reachability: spec.reachability ?? 'normal',
      baseline_sha: baselineSha,
      source_step: source.name,
      consumer_step: consumer.name,
      report_files: declaredReportInputs.reports.map(({ reference }) => reference),
      receipt_sha256: hash(JSON.stringify(declaredReportInputs.reports)),
      injected_report_scopes: currentBuilt.injectedReports.map(({ reference, scope }) => ({ reference, scope })),
      baseline_prompt_sha256: hash(baselinePrompt),
      current_prompt_sha256: hash(currentPrompt),
      expected_marker: spec.expected,
    });
  }

  prepareCase('follow-up', {
    workflow: 'peer-review', source: 'remediation', consumer: 'reviewers', expected: 'F-17-unresolved',
    // This deliberately combines a completed call record with an incomplete
    // verifier report. The normal remediation loop cannot reach this state.
    reachability: 'anomalous_report_combination',
    expectTail: true, shadowNames: ['fix-plan.md', 'fix-report.md', 'fix-verification.md'],
    seed: ({ current, reportDir, registerCall, registerReport }) => {
      const call = registerCall(current, 'remediation', [], reportDir, 2);
      registerReport(call.child, 'fix-plan', call.path, call.directory, 'fix-plan.md',
        '# Fix plan\nFinding F-17: reject tenant-mismatched token reuse. Completion requires tenant equality before dispatch.');
      registerReport(call.child, 'fix', call.path, call.directory, 'fix-report.md',
        '# Fix report\nF-17-unresolved: the implementation still sends a reused token before comparing tenant IDs. The focused test covers only matching tenants.');
      registerReport(call.child, 'fix-verifier', call.path, call.directory, 'fix-verification.md',
        '# Completion verification\nincomplete: F-17 remains unresolved because dispatch precedes tenant validation.');
    },
    currentTarget: (workflow) => childOf(workflow, 'reviewers').steps[0].parallel.fixed
      .find((step) => step.name === 'coding-review'),
    baselineTarget: (currentTarget) => oldInstruction(currentTarget, 'follow-up'),
    targetReportDir: (root) => join(root, 'subworkflows', buildWorkflowCallNamespaceSegment('reviewers', 'peer-review-suite-base', 2)),
  });

  prepareCase('replan', {
    workflow: 'development-core', source: 'peer-review', consumer: 'replan', expected: 'EXT-LOCK-27',
    expectTail: false, shadowNames: ['review-resolution.md'],
    seed: ({ current, reportDir, registerCall, registerReport }) => {
      const call = registerCall(current, 'peer-review', [], reportDir);
      registerReport(call.child, 'final-gate', call.path, call.directory, 'review-resolution.md',
        '# Review resolution\nBLOCKED. EXT-LOCK-27: the production hardware approval is pending with the operator. No local code or test task remains; retain the exact external acceptance evidence.');
      registerReport(call.child, 'final-gate', call.path, call.directory, 'summary.md',
        '# Summary\nBLOCKED: production hardware approval is pending. No local implementation or verification work remains.');
    },
    currentTarget: (workflow) => stepOf(workflow, 'replan'),
    baselineTarget: (currentTarget) => oldInstruction(currentTarget, 'replan'),
  });

  prepareCase('synthesis', {
    workflow: 'review', source: 'reviewers', consumer: 'review-synthesis', expected: 'BACK-4',
    expectTail: true, shadowNames: ['backend-review.md'],
    seed: ({ current, reportDir, registerCall, registerReport, registerDynamic }) => {
      registerReport(current, 'gather', [], reportDir, 'review-target.md',
        '# Review target\nReview src/routes.mjs authorization and its focused tests.');
      const call = registerCall(current, 'reviewers', [], reportDir);
      registerDynamic(call.child, 'review', call.path, call.directory, [
        ['backend-review', 'backend-review.md', '# Backend review\nREJECT: BACK-4, authorization is checked after mutation in src/routes.mjs. This is an unresolved finding.'],
        ['testing-review', 'testing-review.md', '# Testing review\nAPPROVE: focused tests cover the changed happy path.'],
      ]);
    },
    currentTarget: (workflow) => stepOf(workflow, 'review-synthesis'),
    baselineTarget: (currentTarget) => oldInstruction(currentTarget, 'synthesis'),
  });

  prepareCase('merge', {
    workflow: 'merge-review', source: 'review', consumer: 'judge', expected: 'AUTH-9',
    expectTail: true, shadowNames: ['review-summary.md'],
    seed: ({ current, reportDir, registerCall, registerReport, registerDynamic }) => {
      const review = registerCall(current, 'review', [], reportDir);
      registerReport(review.child, 'gather', review.path, review.directory, 'review-target.md',
        '# Review target\nPR 123 at head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.');
      const reviewers = registerCall(review.child, 'reviewers', review.path, review.directory);
      registerDynamic(reviewers.child, 'review', reviewers.path, reviewers.directory, [
        ['backend-review', 'backend-review.md', '# Backend review\nREJECT: AUTH-9, request authorization occurs after a database write.'],
      ]);
      registerReport(review.child, 'review-synthesis', review.path, review.directory, 'review-summary.md',
        '# Review summary\nREJECT. AUTH-9 remains unresolved. CI passed but the database write is reachable before authorization.');
    },
    currentTarget: (workflow) => stepOf(workflow, 'judge'),
    baselineTarget: (currentTarget) => oldInstruction(currentTarget, 'merge'),
  });

  writeFileSync(join(prompts, 'receipts.json'), JSON.stringify(receipts, null, 2) + '\n');
  console.log(JSON.stringify({ baselineSha, receipts }, null, 2));
}
