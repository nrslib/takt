#!/usr/bin/env node
/**
 * Prepare the promptfoo eval environment from the CURRENT facets.
 *
 * Run before every eval so the fixture always reflects the latest facet
 * content (the flow: prepare -> promptfoo eval on codex -> assertions).
 *
 * Mirrors what the codex provider receives at runtime:
 *   - persona (system prompt) is prepended to the instruction
 *     (see src/infra/codex/client.ts: `${systemPrompt}\n\n${prompt}`)
 *   - policy/knowledge are truncated inline by InstructionBuilder (via
 *     faceted-prompting's preparePolicyContent/prepareKnowledgeContent) with
 *     the full content written to snapshot files referenced as Source Paths
 *     (same contract as StepExecutor.writeFacetSnapshot)
 *   - a seeded report directory (fixture reports-seed/ -> .takt/runs/eval/reports/)
 *   - `{task}` / `{previous_response}` exported as promptfoo template
 *     variables `{{task}}` / `{{previous_response}}` (escapeTemplateChars
 *     converts literal braces to full-width, so markers are swapped after
 *     building)
 *
 * Coder (mutable) targets additionally copy the fixture to eval/.work/<name>
 * so the agent can write files; the copy is recreated on every prepare.
 *
 * Requires `npm run build` (imports from dist/).
 *
 * Usage:
 *   node eval/scripts/prepare.mjs [targetId...]   # default: all targets
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TASK_MARKER = '@@PROMPTFOO_TASK@@';
const PREV_MARKER = '@@PROMPTFOO_PREVIOUS_RESPONSE@@';
const SCENARIO_MARKER = '@@PROMPTFOO_SCENARIO@@';

// id doubles as the prompt basename (normal targets use phase1; loop monitors use phase3).
// mutable targets run in a disposable copy under eval/.work/<id>.
const TARGETS = [
  { id: 'coding-review', workflow: 'peer-review', step: 'coding-review', fixture: 'eval/fixtures/sample-project' },
  { id: 'arch-review', workflow: 'peer-review', step: 'arch-review', fixture: 'eval/fixtures/sample-project' },
  { id: 'antipattern-review', workflow: 'peer-review', step: 'ai-antipattern-review-2nd', fixture: 'eval/fixtures/sample-project' },
  { id: 'frontend-review', workflow: 'review-frontend', step: 'frontend-review', fixture: 'eval/fixtures/frontend-app' },
  { id: 'cqrs-review', workflow: 'review-backend-cqrs', step: 'cqrs-es-review', fixture: 'eval/fixtures/backend-cqrs' },
  // rescan は arch-review と同じ facet 構成だが fixture が異なるため、
  // スナップショット（Source Path）を inventory-es 側に生成する専用エントリが必要
  { id: 'rescan', workflow: 'peer-review', step: 'arch-review', fixture: 'eval/fixtures/inventory-es' },
  { id: 'rescan-coding', workflow: 'peer-review', step: 'coding-review', fixture: 'eval/fixtures/inventory-es' },
  { id: 'rescan-semantics', workflow: 'takt-default-high', step: 'implementation-semantics-review', fixture: 'eval/fixtures/inventory-es' },
  // 精度（偽陽性）測定: hasOwn 防御済み Record を指摘しないこと
  { id: 'rescan-precision', workflow: 'takt-default-high', step: 'implementation-semantics-review', fixture: 'eval/fixtures/inventory-es-guarded' },
  { id: 'boundary-contract-buggy', workflow: 'takt-default-localllm', step: 'contract-wiring-review', fixture: 'eval/fixtures/review-boundaries-buggy', twoPhaseReport: true },
  { id: 'boundary-contract-clean', workflow: 'takt-default-localllm', step: 'contract-wiring-review', fixture: 'eval/fixtures/review-boundaries-clean', twoPhaseReport: true },
  { id: 'boundary-resource-buggy', workflow: 'takt-default-localllm', step: 'resource-ownership-review', fixture: 'eval/fixtures/review-boundaries-buggy', twoPhaseReport: true },
  { id: 'boundary-resource-clean', workflow: 'takt-default-localllm', step: 'resource-ownership-review', fixture: 'eval/fixtures/review-boundaries-clean', twoPhaseReport: true },
  { id: 'boundary-robustness-buggy', workflow: 'takt-default-localllm', step: 'failure-boundary-review', fixture: 'eval/fixtures/review-boundaries-buggy', twoPhaseReport: true },
  { id: 'boundary-robustness-clean', workflow: 'takt-default-localllm', step: 'failure-boundary-review', fixture: 'eval/fixtures/review-boundaries-clean', twoPhaseReport: true },
  { id: 'loop-monitor-reviewers-fix-fc', workflow: 'takt-default-high', monitorCycle: ['fix', 'reviewers'], fixture: 'eval/fixtures/sample-project' },
  { id: 'frontend-implement', workflow: 'frontend', step: 'implement', fixture: 'eval/fixtures/frontend-app', mutable: true },
  { id: 'cqrs-implement', workflow: 'backend-cqrs', step: 'implement', fixture: 'eval/fixtures/backend-cqrs', mutable: true },
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');

const { loadWorkflowByIdentifier, resolveWorkflowConfigValue, loadPersonaPromptFromPath } = await import(
  pathToFileURL(join(repoRoot, 'dist/infra/config/index.js')).href
);
const { InstructionBuilder } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/instruction/InstructionBuilder.js')).href
);
const { StatusJudgmentBuilder } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/instruction/StatusJudgmentBuilder.js')).href
);
const { ReportInstructionBuilder } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/instruction/ReportInstructionBuilder.js')).href
);
const { getReportFiles } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/output-contract-files.js')).href
);
const { createFindingLedgerStore } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/findings/store.js')).href
);
const {
  renderFindingLedgerInstructionSummary,
  renderFindingLedgerReportSummary,
  ledgerHasOpenFindings,
  ledgerHasWaivedFindings,
  ledgerHasDismissedFindings,
} = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/findings/context.js')).href
);
const { computeReviewScopeSnapshotId } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/findings/snapshot.js')).href
);
const { createRawFindingsStructuredOutput } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/findings/manager-agent.js')).href
);

const requested = process.argv.slice(2);
for (const id of requested) {
  if (!TARGETS.some((t) => t.id === id)) {
    throw new Error(`Unknown target "${id}". Available: ${TARGETS.map((t) => t.id).join(', ')}`);
  }
}
const targets = requested.length > 0 ? TARGETS.filter((t) => requested.includes(t.id)) : TARGETS;

const language = resolveWorkflowConfigValue(repoRoot, 'language');
const preparedDirs = new Set();
const findingContractContexts = new Map();

for (const {
  id,
  workflow: workflowName,
  step: stepName,
  monitorCycle,
  fixture,
  mutable,
  twoPhaseReport,
} of targets) {
  const fixtureDir = resolve(repoRoot, fixture);

  // Mutable (coder) targets work on a disposable copy.
  let runDir = fixtureDir;
  if (mutable) {
    runDir = join(repoRoot, 'eval', '.work', id);
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(dirname(runDir), { recursive: true });
    cpSync(fixtureDir, runDir, { recursive: true });
  }

  const config = loadWorkflowByIdentifier(workflowName, repoRoot);
  if (!config) {
    throw new Error(`Workflow not found: ${workflowName}`);
  }

  let target = null;
  let stepIndex = -1;
  if (monitorCycle) {
    const monitor = config.loopMonitors?.find(({ cycle }) =>
      cycle.length === monitorCycle.length
      && cycle.every((name, index) => name === monitorCycle[index]),
    );
    if (!monitor?.judge.instruction) {
      throw new Error(`Loop monitor [${monitorCycle.join(', ')}] not found in ${workflowName}`);
    }
    target = {
      name: `_loop_judge_${monitor.cycle.join('_')}`,
      persona: monitor.judge.persona,
      personaPath: monitor.judge.personaPath,
      edit: false,
      instruction: monitor.judge.instruction.replaceAll('{cycle_count}', String(monitor.threshold)),
      rules: monitor.judge.rules,
      passPreviousResponse: true,
    };
    stepIndex = config.steps.findIndex(({ name }) => name === monitor.cycle.at(-1));
  } else {
    for (const [i, step] of config.steps.entries()) {
      if (step.name === stepName) {
        target = step;
        stepIndex = i;
        break;
      }
      const substep = (step.parallel ?? []).find((s) => s.name === stepName);
      if (substep) {
        target = substep;
        stepIndex = i;
        break;
      }
    }
  }
  if (!target) {
    const names = config.steps.flatMap((s) => [s.name, ...(s.parallel ?? []).map((p) => p.name)]);
    throw new Error(`Step "${stepName}" not found in ${workflowName}. Available: ${names.join(', ')}`);
  }

  // --- Facet snapshots + seeded reports (once per run directory) -----------
  const snapshotDir = join(runDir, '.takt', 'eval-snapshots');
  const reportDir = join(runDir, '.takt', 'runs', 'eval', 'reports');
  if (!preparedDirs.has(runDir)) {
    preparedDirs.add(runDir);
    rmSync(snapshotDir, { recursive: true, force: true });
    mkdirSync(snapshotDir, { recursive: true });
    rmSync(reportDir, { recursive: true, force: true });
    mkdirSync(reportDir, { recursive: true });
    if (twoPhaseReport && config.findingContract) {
      rmSync(resolve(runDir, config.findingContract.ledgerPath), { force: true });
      rmSync(resolve(runDir, config.findingContract.rawFindingsPath), { recursive: true, force: true });
    }
    const seedDir = join(runDir, 'reports-seed');
    if (existsSync(seedDir)) {
      cpSync(seedDir, reportDir, { recursive: true });
      console.log(`Report dir seeded: ${reportDir} (${readdirSync(seedDir).length} files)`);
    }
  }

  function writeFacetSnapshot(kind, contents) {
    if (!contents || contents.length === 0) return undefined;
    const path = join(snapshotDir, `${id}-${kind}.md`);
    writeFileSync(path, contents.join('\n\n---\n\n'));
    return path;
  }

  const policySourcePath = writeFacetSnapshot('policies', target.policyContents);
  const knowledgeSourcePath = writeFacetSnapshot('knowledge', target.knowledgeContents);
  let findingContract;
  if (twoPhaseReport) {
    if (!config.findingContract) {
      throw new Error(`Two-phase target "${id}" requires a finding_contract`);
    }
    findingContract = findingContractContexts.get(runDir);
    if (!findingContract) {
      const store = createFindingLedgerStore({
        projectCwd: runDir,
        reportDir,
        workflowName: config.name,
        ledgerPath: config.findingContract.ledgerPath,
        rawFindingsPath: config.findingContract.rawFindingsPath,
      });
      const ledger = store.loadLedger();
      const reviewScopeSnapshotId = computeReviewScopeSnapshotId(runDir);
      findingContract = {
        ledgerCopyPath: store.createRunCopy(),
        ledgerSummary: renderFindingLedgerInstructionSummary(ledger),
        reportLedgerSummary: renderFindingLedgerReportSummary(ledger),
        hasOpenFindings: ledgerHasOpenFindings(ledger),
        hasWaivedFindings: ledgerHasWaivedFindings(ledger),
        hasDismissedFindings: ledgerHasDismissedFindings(ledger),
        rawFindingsStructuredOutput: createRawFindingsStructuredOutput(reviewScopeSnapshotId),
        reviewScopeSnapshotId,
      };
      findingContractContexts.set(runDir, findingContract);
    }
  }

  // --- Render the assembled Phase 1 prompt ---------------------------------
  const context = {
    task: TASK_MARKER,
    iteration: 1,
    maxSteps: config.maxSteps,
    stepIteration: 1,
    cwd: runDir,
    projectCwd: runDir,
    userInputs: [],
    previousOutput: { content: PREV_MARKER },
    workflowSteps: config.steps,
    currentStepIndex: stepIndex,
    reportDir,
    policySourcePath,
    knowledgeSourcePath,
    language,
    findingContract,
  };

  const instruction = monitorCycle
    ? new StatusJudgmentBuilder(target, {
        language,
        inputSource: 'response',
        lastResponse: `${target.instruction}\n\n## Scenario evidence\n${SCENARIO_MARKER}`,
      }).build()
    : new InstructionBuilder(target, context).build();

  // The codex provider concatenates system prompt (persona) and instruction.
  const persona = target.personaPath
    ? loadPersonaPromptFromPath(target.personaPath, repoRoot).trim()
    : '';
  const assembled = (persona ? `${persona}\n\n${instruction}` : instruction)
    .replaceAll(TASK_MARKER, '{{task}}')
    .replaceAll(PREV_MARKER, '{{previous_response}}')
    .replaceAll(SCENARIO_MARKER, '{{scenario}}');

  const outDir = join(repoRoot, 'eval', 'prompts');
  mkdirSync(outDir, { recursive: true });
  const phase = monitorCycle ? 'phase3' : 'phase1';
  const outPath = join(outDir, `${id}.${phase}.md`);
  writeFileSync(outPath, assembled);
  let phase2Path;
  if (twoPhaseReport) {
    const reportFiles = getReportFiles(target.outputContracts);
    if (reportFiles.length !== 1 || !reportFiles[0]) {
      throw new Error(`Two-phase target "${id}" must define exactly one report file`);
    }
    const reportInstruction = new ReportInstructionBuilder(target, {
      cwd: runDir,
      reportDir,
      stepIteration: 1,
      language,
      targetFile: reportFiles[0],
      findingContract,
    }).build();
    const phase2Assembled = persona
      ? `${persona}\n\n${reportInstruction}`
      : reportInstruction;
    phase2Path = join(outDir, `${id}.phase2.md`);
    writeFileSync(phase2Path, phase2Assembled);
  }

  const targetName = monitorCycle ? `[${monitorCycle.join(' -> ')}] monitor` : stepName;
  console.log(`[${id}] ${workflowName}/${targetName}${mutable ? ' (mutable copy)' : ''}`);
  console.log(`  Prompt:             ${outPath} (${assembled.length} chars, language: ${language})`);
  console.log(`  Run dir:            ${runDir}`);
  console.log(`  Policy snapshot:    ${policySourcePath ?? '(none)'}`);
  console.log(`  Knowledge snapshot: ${knowledgeSourcePath ?? '(none)'}`);
  if (phase2Path) {
    console.log(`  Report prompt:      ${phase2Path}`);
  }
}
