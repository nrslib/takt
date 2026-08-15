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
  {
    id: 'arch-failure-aggregation',
    workflow: 'peer-review',
    step: 'arch-review',
    fixture: 'eval/fixtures/arch-failure-aggregation',
  },
  { id: 'antipattern-review', workflow: 'peer-review', step: 'ai-antipattern-review-2nd', fixture: 'eval/fixtures/sample-project' },
  { id: 'frontend-review', workflow: 'review-frontend', step: 'frontend-review', fixture: 'eval/fixtures/frontend-app' },
  { id: 'cqrs-review', workflow: 'review-backend-cqrs', step: 'cqrs-es-review', fixture: 'eval/fixtures/backend-cqrs' },
  // rescan は arch-review と同じ facet 構成だが fixture が異なるため、
  // スナップショット（Source Path）を inventory-es 側に生成する専用エントリが必要
  { id: 'rescan', workflow: 'peer-review', step: 'arch-review', fixture: 'eval/fixtures/inventory-es' },
  { id: 'rescan-coding', workflow: 'peer-review', step: 'coding-review', fixture: 'eval/fixtures/inventory-es' },
  { id: 'frontend-implement', workflow: 'frontend', step: 'implement', fixture: 'eval/fixtures/frontend-app', mutable: true },
  { id: 'cqrs-implement', workflow: 'backend-cqrs', step: 'implement', fixture: 'eval/fixtures/backend-cqrs', mutable: true },
  { id: 'fix-closure', workflow: 'review-remediation', step: 'fix-retry', fixture: 'eval/fixtures/fix-closure', mutable: true },
  { id: 'fix-self-scan', workflow: 'peer-review', step: 'fix', fixture: 'eval/fixtures/fix-self-scan', mutable: true },
  { id: 'fix-plan-fresh-findings', workflow: 'peer-review', step: 'fix-plan', fixture: 'eval/fixtures/fix-plan-fresh-findings' },
  { id: 'fix-plan-boundary-preflight', workflow: 'peer-review', step: 'fix-plan', fixture: 'eval/fixtures/fix-plan-boundary-preflight' },
  { id: 'fix-plan-cause-check', workflow: 'peer-review', step: 'fix-plan', fixture: 'eval/fixtures/fix-plan-cause-check' },
  { id: 'review-family-closure', workflow: 'peer-review-suite-base', step: 'coding-review', fixture: 'eval/fixtures/review-family-closure' },
  {
    id: 'initial-review-contract-discovery',
    workflow: 'peer-review',
    via: 'initial-reviewers',
    step: 'coding-review',
    fixture: 'eval/fixtures/initial-review-contract-discovery',
  },
  {
    id: 'initial-review-external-identity-wiring',
    workflow: 'takt-experimental-review',
    step: 'coding-review',
    fixture: 'eval/fixtures/initial-review-external-identity-wiring',
  },
  {
    id: 'testing-review-observable-evidence',
    workflow: 'peer-review',
    via: 'initial-reviewers',
    step: 'testing-review',
    fixture: 'eval/fixtures/testing-review-observable-evidence',
  },
  {
    id: 'initial-plan-contract-closure',
    workflow: 'default',
    step: 'plan',
    fixture: 'eval/fixtures/initial-review-contract-discovery',
  },
  {
    id: 'replan-contract-closure',
    workflow: 'default',
    step: 'replan',
    fixture: 'eval/fixtures/initial-review-contract-discovery',
  },
  {
    id: 'issue-plan-samples',
    workflow: 'default',
    step: 'plan',
    fixture: '.',
    artifacts: 'eval/.work/issue-plan-samples-context',
  },
  {
    id: 'plan-report-source-authority',
    workflow: 'default',
    step: 'plan',
    fixture: '.',
    artifacts: 'eval/.work/plan-report-source-authority-context',
    phase: 'phase2',
    targetFile: 'plan.md',
  },
  {
    id: 'write-tests-contract-traceability',
    workflow: 'default',
    step: 'write_tests',
    fixture: 'eval/fixtures/write-tests-contract-traceability',
    mutable: true,
  },
  {
    id: 'write-tests-default-priority',
    workflow: 'default',
    step: 'write_tests',
    fixture: 'eval/fixtures/write-tests-default-priority',
    mutable: true,
  },
  {
    id: 'write-tests-default-priority-codex',
    workflow: 'default',
    step: 'write_tests',
    fixture: 'eval/fixtures/write-tests-default-priority',
    mutable: true,
  },
  {
    id: 'scope-default-write-tests',
    workflow: 'default',
    step: 'write_tests',
    fixture: 'eval/fixtures/scope-discipline-tests',
    mutable: true,
  },
  {
    id: 'scope-maintenance-write-tests',
    workflow: 'backend-maintenance',
    step: 'write_tests',
    fixture: 'eval/fixtures/scope-discipline-tests',
    mutable: true,
  },
  {
    id: 'scope-architecture-search',
    workflow: 'peer-review',
    step: 'arch-review',
    fixture: 'eval/fixtures/scope-architecture-search',
  },
  {
    id: 'scope-architecture-search-none',
    workflow: 'peer-review',
    step: 'arch-review',
    fixture: 'eval/fixtures/scope-architecture-search',
    facetMode: 'none',
  },
  {
    id: 'scope-architecture-search-unrelated',
    workflow: 'peer-review',
    step: 'arch-review',
    fixture: 'eval/fixtures/scope-architecture-search',
    facetMode: 'unrelated',
  },
  {
    id: 'scope-architecture-boundary',
    workflow: 'peer-review',
    step: 'arch-review',
    fixture: 'eval/fixtures/scope-architecture-boundary',
  },
  {
    id: 'implement-contract-traceability',
    workflow: 'default',
    step: 'implement',
    fixture: 'eval/fixtures/implement-contract-traceability',
    mutable: true,
  },
  {
    id: 'implementation-report-contract-traceability',
    workflow: 'default',
    step: 'implement',
    fixture: 'eval/fixtures/implement-contract-traceability',
    mutable: true,
    phase: 'phase2',
    targetFile: 'implementation-report.md',
  },
  {
    id: 'follow-up-review-repair-regression',
    workflow: 'peer-review',
    via: 'reviewers',
    step: 'coding-review',
    fixture: 'eval/fixtures/follow-up-review-repair-regression',
  },
  {
    id: 'follow-up-testing-review-repair-regression',
    workflow: 'peer-review',
    via: 'reviewers',
    step: 'testing-review',
    fixture: 'eval/fixtures/follow-up-review-repair-regression',
  },
  {
    id: 'review-adjudication-binding',
    workflow: 'peer-review',
    via: 'reviewers',
    step: 'security-review',
    fixture: 'eval/fixtures/review-adjudication-binding',
    includeOutputContract: true,
  },
  {
    id: 'security-review-method',
    workflow: 'peer-review',
    via: 'initial-reviewers',
    step: 'security-review',
    fixture: 'eval/fixtures/security-review-method',
    includeOutputContract: true,
  },
  {
    id: 'review-mode-authority',
    workflow: 'review-default',
    step: 'coding-review',
    fixture: 'eval/fixtures/review-mode-authority',
  },
  {
    id: 'fix-verifier-family-boundary',
    workflow: 'review-remediation',
    step: 'fix-verifier',
    fixture: 'eval/fixtures/fix-verifier-family-boundary',
  },
  {
    id: 'companion-early-scan',
    companion: 'ai-antipattern-review-companion',
    fixture: 'eval/fixtures/companion-family-boundary',
  },
  {
    id: 'companion-evidence-boundary',
    companion: 'review-companion-moderator',
    fixture: 'eval/fixtures/companion-family-boundary',
  },
  { id: 'review-adjudication', workflow: 'peer-review', step: 'review-adjudication', fixture: 'eval/fixtures/review-adjudication' },
  {
    id: 'final-readiness-supervision',
    workflow: 'review-fix-default',
    step: 'supervise',
    fixture: 'eval/fixtures/final-readiness-supervision',
  },
  {
    id: 'final-readiness-supervision-phase2',
    workflow: 'review-fix-default',
    step: 'supervise',
    fixture: 'eval/fixtures/final-readiness-supervision',
    phase: 'phase2',
    targetFile: 'supervisor-validation.md',
  },
  {
    id: 'final-readiness-precision',
    workflow: 'review-fix-default',
    step: 'supervise',
    fixture: 'eval/fixtures/final-readiness-precision',
  },
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');

const {
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
  resolveWorkflowConfigValue,
  loadPersonaPromptFromPath,
} = await import(
  pathToFileURL(join(repoRoot, 'dist/infra/config/index.js')).href
);
const { InstructionBuilder } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/instruction/InstructionBuilder.js')).href
);
const { ReportInstructionBuilder } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/instruction/ReportInstructionBuilder.js')).href
);
const { StatusJudgmentBuilder } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/instruction/StatusJudgmentBuilder.js')).href
);
const { getAllParallelSubSteps } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/models/types.js')).href
);
const { MAX_WORKFLOW_CALL_DEPTH } = await import(
  pathToFileURL(join(repoRoot, 'dist/core/workflow/workflow-call-depth.js')).href
);
const { loadCompanionDefinition } = await import(
  pathToFileURL(join(repoRoot, 'dist/infra/config/loaders/companionDefinitionLoader.js')).href
);
const { getBuiltinCompanionsDir } = await import(
  pathToFileURL(join(repoRoot, 'dist/infra/config/paths.js')).href
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

function findStepTarget(workflow, stepName, depth = 0) {
  if (depth > MAX_WORKFLOW_CALL_DEPTH) {
    throw new Error(`Workflow-call nesting exceeded while resolving step "${stepName}"`);
  }

  for (const [stepIndex, step] of workflow.steps.entries()) {
    if (step.name === stepName && step.kind !== 'workflow_call') {
      return { workflow, target: step, stepIndex };
    }
  }

  for (const [stepIndex, step] of workflow.steps.entries()) {
    const substep = (step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel))
      .find((candidate) => candidate.name === stepName && candidate.kind !== 'workflow_call');
    if (substep) return { workflow, target: substep, stepIndex };
  }

  for (const step of workflow.steps) {
    const candidates = [
      step,
      ...(step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel)),
    ];
    for (const candidate of candidates) {
      if (candidate.kind !== 'workflow_call') continue;
      const child = resolveWorkflowCallTarget(workflow, candidate, repoRoot);
      if (!child) continue;
      const found = findStepTarget(child, stepName, depth + 1);
      if (found) return found;
    }
  }

  const directWorkflowCall = workflow.steps.find((step) => (
    step.name === stepName && step.kind === 'workflow_call'
  ));
  if (directWorkflowCall) {
    return {
      workflow,
      target: directWorkflowCall,
      stepIndex: workflow.steps.indexOf(directWorkflowCall),
    };
  }

  return null;
}

function findStepThroughCall(workflow, callStepName, stepName) {
  const callStep = workflow.steps.find((step) => step.name === callStepName);
  if (!callStep || callStep.kind !== 'workflow_call') {
    throw new Error(`Workflow call "${callStepName}" not found while resolving step "${stepName}"`);
  }
  const child = resolveWorkflowCallTarget(workflow, callStep, repoRoot);
  if (!child) {
    throw new Error(`Workflow call "${callStepName}" could not be resolved`);
  }
  return findStepTarget(child, stepName, 1);
}

for (const {
  id,
  workflow: workflowName,
  companion: companionName,
  via,
  step: stepName,
  monitorCycle,
  fixture,
  mutable,
  workflowCallVars,
  facetMode,
  artifacts,
  phase: requestedPhase,
  targetFile,
  includeOutputContract,
} of targets) {
  if (requestedPhase !== undefined && monitorCycle !== undefined) {
    throw new Error(`Target "${id}" cannot define both phase and monitorCycle`);
  }
  const resolvedPhase = requestedPhase ?? (monitorCycle ? 'phase3' : 'phase1');
  const fixtureDir = resolve(repoRoot, fixture);

  // Mutable (coder) targets work on a disposable copy.
  let runDir = fixtureDir;
  if (mutable) {
    runDir = join(repoRoot, 'eval', '.work', id);
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(dirname(runDir), { recursive: true });
    cpSync(fixtureDir, runDir, { recursive: true });
  }
  const artifactDir = artifacts === undefined ? runDir : resolve(repoRoot, artifacts);

  let config = null;
  let companionSystemPrompt;
  if (companionName !== undefined) {
    const candidateDirs = [getBuiltinCompanionsDir(language)];
    const definition = loadCompanionDefinition(companionName, {
      candidateDirs,
      language,
      facetContext: { projectDir: runDir, lang: language },
    });
    companionSystemPrompt = [
      definition.personaContent,
      ...(definition.policyContents ?? []),
      ...(definition.knowledgeContents ?? []),
      definition.instruction,
    ].filter((content) => content !== undefined).join('\n\n');
    config = { name: companionName, maxSteps: 1, steps: [] };
  } else {
    config = loadWorkflowByIdentifier(workflowName, repoRoot);
    if (!config) {
      throw new Error(`Workflow not found: ${workflowName}`);
    }
  }

  let target = null;
  let stepIndex = -1;
  if (companionSystemPrompt !== undefined) {
    target = {
      name: companionName,
      instruction: companionSystemPrompt,
      edit: false,
      rules: [],
    };
  } else if (monitorCycle) {
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
    const found = via === undefined
      ? findStepTarget(config, stepName)
      : findStepThroughCall(config, via, stepName);
    if (found) {
      config = found.workflow;
      target = found.target;
      stepIndex = found.stepIndex;
    }
  }
  if (!target) {
    const names = config.steps.flatMap((step) => [
      step.name,
      ...(step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel))
        .map((substep) => substep.name),
    ]);
    throw new Error(`Step "${stepName}" not found in ${workflowName}. Available: ${names.join(', ')}`);
  }

  if (includeOutputContract === true) {
    if (target.outputContracts?.length !== 1) {
      throw new Error(`Target "${id}" requires exactly one output contract`);
    }
    const [outputContract] = target.outputContracts;
    if (
      outputContract === undefined
      || outputContract === null
      || typeof outputContract !== 'object'
      || typeof outputContract.format !== 'string'
    ) {
      throw new Error(`Target "${id}" requires a formatted output contract`);
    }
    target = {
      ...target,
      instruction: [
        target.instruction,
        '',
        '## Phase 1 evaluation output contract',
        outputContract.format.trimEnd(),
      ].join('\n'),
    };
  }

  if (facetMode === 'none') {
    target = { ...target, policyContents: [], knowledgeContents: [] };
  } else if (facetMode === 'unrelated') {
    target = {
      ...target,
      policyContents: [{
        content: '# Documentation Link Policy\n\nWhen public documentation is edited, preserve externally published link targets.',
      }],
      knowledgeContents: [{
        content: '# Markdown Navigation Knowledge\n\nRelative links in Markdown are resolved from the directory containing the document.',
      }],
    };
  }

  // --- Facet snapshots + seeded reports (once per run directory) -----------
  const snapshotDir = join(artifactDir, '.takt', 'eval-snapshots');
  const reportDir = join(artifactDir, '.takt', 'runs', 'eval', 'reports');
  if (!preparedDirs.has(artifactDir)) {
    preparedDirs.add(artifactDir);
    rmSync(snapshotDir, { recursive: true, force: true });
    mkdirSync(snapshotDir, { recursive: true });
    rmSync(reportDir, { recursive: true, force: true });
    mkdirSync(reportDir, { recursive: true });
    const seedDir = join(runDir, 'reports-seed');
    if (existsSync(seedDir)) {
      cpSync(seedDir, reportDir, { recursive: true });
      console.log(`Report dir seeded: ${reportDir} (${readdirSync(seedDir).length} files)`);
    }
  }

  function writeFacetSnapshot(kind, contents) {
    if (!contents || contents.length === 0) return undefined;
    const path = join(snapshotDir, `${id}-${kind}.md`);
    const text = contents.map((entry) => {
      if (entry === null || typeof entry !== 'object' || typeof entry.content !== 'string') {
        throw new Error(`Invalid ${kind} facet content for eval target "${id}"`);
      }
      return entry.content;
    }).join('\n\n---\n\n');
    writeFileSync(path, text);
    return path;
  }

  const policySourcePath = writeFacetSnapshot('policies', target.policyContents);
  const knowledgeSourcePath = writeFacetSnapshot('knowledge', target.knowledgeContents);

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
    workflowCallVars,
    language,
  };

  const instruction = companionSystemPrompt !== undefined
    ? `${companionSystemPrompt}\n\n## Supplied work-in-progress context\n${TASK_MARKER}\n\n## Prior findings and notes\n${PREV_MARKER}`
    : resolvedPhase === 'phase2'
    ? new ReportInstructionBuilder(target, {
        cwd: runDir,
        task: TASK_MARKER,
        reportDir,
        stepIteration: 1,
        language,
        targetFile,
        lastResponse: PREV_MARKER,
      }).build()
    : resolvedPhase === 'phase3'
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
  const outPath = join(outDir, `${id}.${resolvedPhase}.md`);
  writeFileSync(outPath, assembled);

  const targetName = companionName ?? (monitorCycle ? `[${monitorCycle.join(' -> ')}] monitor` : stepName);
  console.log(`[${id}] ${workflowName ?? 'companion'}/${targetName}${mutable ? ' (mutable copy)' : ''}`);
  console.log(`  Prompt:             ${outPath} (${assembled.length} chars, language: ${language})`);
  console.log(`  Run dir:            ${runDir}`);
  console.log(`  Policy snapshot:    ${policySourcePath ?? '(none)'}`);
  console.log(`  Knowledge snapshot: ${knowledgeSourcePath ?? '(none)'}`);
}
