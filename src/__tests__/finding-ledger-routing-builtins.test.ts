import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type {
  AgentResponse,
  FindingsRuleContext,
  WorkflowState,
  WorkflowStep,
} from '../core/models/index.js';
import { parseWorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';
import { RuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import {
  getBuiltinWorkflowsDir,
} from '../infra/config/paths.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';
import { makeStep } from './test-helpers.js';

type Language = 'en' | 'ja';

interface RawRule {
  condition: string;
  next?: string;
  return?: string;
}

interface RawStep {
  name?: string;
  parallel?: RawStep[];
  rules?: RawRule[];
}

interface RawWorkflow {
  steps: RawStep[];
}

interface FindingCounts {
  open?: number;
  provisional?: number;
  dismissEligible?: number;
  provisionalFixpoint?: boolean;
  roundBudgetExhausted?: boolean;
  anomalies?: number;
  anomalyBudgetExhausted?: boolean;
  conflicts?: number;
  unadjudicated?: number;
}

const EMPTY_LEDGER_CONDITION = 'findings.open.count == 0 && findings.provisional.count == 0 && findings.conflicts.count == 0';
const ACTIONABLE_OPEN_CONDITION = 'findings.open.count > 0 && findings.provisional.count == 0 && findings.conflicts.count == 0';

function readExpandedStep(language: Language, workflowName: string, stepName: string): RawStep {
  const workflowPath = join(getBuiltinWorkflowsDir(language), `${workflowName}.yaml`);
  const raw = parseYaml(readFileSync(workflowPath, 'utf-8')) as RawWorkflow;
  const expanded = resolveWorkflowStepFragments(raw, {
    candidateDirs: buildStepFragmentLookupDirs({ lang: language }),
    context: { lang: language, projectDir: process.cwd() },
    workflowPath,
  }).raw as RawWorkflow;
  const step = expanded.steps.find((candidate) => candidate.name === stepName);
  if (step === undefined) throw new Error(`Missing expanded builtin step: ${stepName}`);
  return step;
}

function toWorkflowStep(raw: RawStep): WorkflowStep {
  if (raw.name === undefined) throw new Error('Builtin step name is required');
  return makeStep({
    name: raw.name,
    parallel: raw.parallel?.map(toWorkflowStep),
    rules: raw.rules?.map((rule) => ({
      condition: parseWorkflowRuleCondition(rule.condition),
      ...(rule.next === undefined ? {} : { next: rule.next }),
      ...(rule.return === undefined ? {} : { returnValue: rule.return }),
    })),
  });
}

function findings(counts: FindingCounts = {}): FindingsRuleContext {
  return {
    open: {
      count: counts.open ?? 0,
      bySeverity: {} as FindingsRuleContext['open']['bySeverity'],
      items: [],
    },
    resolved: { count: 0 },
    waived: { count: 0 },
    invalidated: { count: 0 },
    superseded: { count: 0 },
    provisional: {
      count: counts.provisional ?? 0,
      dismissEligible: { count: counts.dismissEligible ?? 0 },
      fixpoint: counts.provisionalFixpoint ?? false,
      items: [],
    },
    rounds: { budgetExhausted: counts.roundBudgetExhausted ?? false },
    reviewerAnomalies: {
      count: counts.anomalies ?? 0,
      budgetExhausted: counts.anomalyBudgetExhausted ?? false,
    },
    conflicts: {
      count: counts.conflicts ?? 0,
      items: [],
      unadjudicated: { count: counts.unadjudicated ?? 0 },
    },
  };
}

function reviewerOutput(step: WorkflowStep, matchedRuleIndex: number): AgentResponse {
  return {
    persona: step.name,
    status: 'done',
    content: '',
    timestamp: new Date(0),
    matchedRuleIndex,
    matchedRuleMethod: 'structured_output',
  };
}

function stateFor(
  step: WorkflowStep,
  counts: FindingCounts,
  reviewerRuleIndex: number,
): WorkflowState {
  return {
    workflowName: 'finding-ledger-routing-builtins',
    currentStep: step.name,
    iteration: 1,
    findings: findings(counts),
    stepOutputs: new Map(
      (step.parallel ?? []).map((substep) => [
        substep.name,
        reviewerOutput(substep, reviewerRuleIndex),
      ]),
    ),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function transition(
  step: WorkflowStep,
  counts: FindingCounts,
  reviewerRuleIndex: number,
  label?: string,
): string {
  const match = new RuleEvaluator(step, { state: stateFor(step, counts, reviewerRuleIndex) })
    .evaluate(label === undefined ? undefined : { label, method: 'structured_output' });
  if (match === undefined) throw new Error(`No rule matched for ${step.name}`);
  const rule = step.rules?.[match.index];
  const target = rule?.next ?? rule?.returnValue;
  if (target === undefined) throw new Error(`Matched rule has no target for ${step.name}`);
  return target;
}

function sharedReviewers(language: Language): RawStep {
  return readExpandedStep(language, 'takt-default-high', 'reviewers');
}

function localReviewers(language: Language, name: 'reviewers' | 'boundary-reviewers'): RawStep {
  const workflowName = name === 'reviewers'
    ? 'finding-contract-local-review'
    : 'finding-contract-boundary-review';
  return readExpandedStep(language, workflowName, name);
}

describe('builtin Finding ledger routing', () => {
  it.each(['en', 'ja'] as const)('%s reviewer集約は末尾をstate-onlyの2ルールにする', (language) => {
    for (const raw of [
      sharedReviewers(language),
      localReviewers(language, 'reviewers'),
      localReviewers(language, 'boundary-reviewers'),
    ]) {
      expect(raw.rules?.slice(-2).map((rule) => rule.condition)).toEqual([
        `when(${EMPTY_LEDGER_CONDITION})`,
        `when(${ACTIONABLE_OPEN_CONDITION})`,
      ]);
      expect(raw.rules?.some((rule) => /^(?:all|any)\(/u.test(rule.condition))).toBe(false);
    }
  });

  it.each(['en', 'ja'] as const)('%s shared reviewersはstatusとanomaly数によらず空台帳をfinal gateへ送る', (language) => {
    const step = toWorkflowStep(sharedReviewers(language));

    for (const reviewerRuleIndex of [0, 1]) {
      for (const label of [undefined, 'all("approved")', 'any("needs_fix")', 'needs_fix', 'need_replan']) {
        for (const anomalies of [0, 3]) {
          expect(transition(step, { anomalies }, reviewerRuleIndex, label)).toBe('final-gate');
        }
        expect(transition(step, { open: 1 }, reviewerRuleIndex, label)).toBe('fix');
      }
    }
  });

  it.each(['en', 'ja'] as const)('%s localllmは空台帳を通常integrity gate、boundary final gateへ送る', (language) => {
    const regular = toWorkflowStep(localReviewers(language, 'reviewers'));
    const boundary = toWorkflowStep(localReviewers(language, 'boundary-reviewers'));

    for (const reviewerRuleIndex of [0, 1]) {
      for (const label of [undefined, 'all("approved")', 'any("needs_fix")', 'needs_fix', 'need_replan']) {
        for (const anomalies of [0, 3]) {
          expect(transition(regular, { anomalies }, reviewerRuleIndex, label))
            .toBe('integrity-gate');
          expect(transition(boundary, { anomalies }, reviewerRuleIndex, label)).toBe('final-gate');
        }
        expect(transition(regular, { open: 1 }, reviewerRuleIndex, label)).toBe('needs_fix');
        expect(transition(boundary, { open: 1 }, reviewerRuleIndex, label)).toBe('needs_fix');
      }
    }
  });

  it.each(['en', 'ja'] as const)('%s reviewer集約はconflict/provisionalの先行ルールを維持する', (language) => {
    const cases = [
      { raw: sharedReviewers(language), dismissTarget: 'final-gate', replanTarget: 'replan' },
      { raw: localReviewers(language, 'reviewers'), dismissTarget: 'integrity-gate', replanTarget: 'need_replan' },
      { raw: localReviewers(language, 'boundary-reviewers'), dismissTarget: 'final-gate', replanTarget: 'need_replan' },
    ];

    for (const { raw, dismissTarget, replanTarget } of cases) {
      const step = toWorkflowStep(raw);
      expect(transition(step, { open: 1, conflicts: 1, unadjudicated: 1 }, 1))
        .toBe('finding-conflict-adjudication');
      expect(transition(step, { open: 1, conflicts: 1 }, 1)).toBe('ABORT');
      expect(transition(step, { open: 1, provisional: 1, dismissEligible: 1 }, 1))
        .toBe(dismissTarget);
      expect(transition(step, { open: 1, provisional: 1 }, 1)).toBe(replanTarget);
    }
  });

  it.each(['en', 'ja'] as const)('%s merge-readinessは空台帳のneeds_fixをsuperviseへ進める', (language) => {
    const raw = readExpandedStep(
      language,
      'merge-readiness-finding-contract-final-gate',
      'merge-readiness-review',
    );
    const step = toWorkflowStep(raw);

    expect(raw.rules?.some((rule) => rule.condition === 'needs_fix')).toBe(false);
    expect(transition(step, {}, 0, 'needs_fix')).toBe('supervise');
    expect(transition(step, { open: 1 }, 0, 'approved')).toBe('needs_fix');
    expect(transition(step, { open: 1 }, 0, 'needs_fix')).toBe('needs_fix');
    expect(transition(step, { anomalies: 1 }, 0, 'needs_fix')).toBe('needs_review');
    expect(transition(
      step,
      { anomalies: 1, anomalyBudgetExhausted: true },
      0,
      'needs_fix',
    )).toBe('need_replan');
  });

  it.each(['en', 'ja'] as const)(
    '%s supervisor callerは空台帳の生labelを無視してCOMPLETEにし、台帳だけで遷移する',
    (language) => {
      const raw = readExpandedStep(
        language,
        'merge-readiness-finding-contract-final-gate',
        'supervise',
      );
      const step = toWorkflowStep(raw);

      expect(raw.rules?.some((rule) => ['approved', 'needs_fix', 'need_replan'].includes(rule.condition)))
        .toBe(false);
      for (const label of ['approved', 'needs_fix', 'need_replan']) {
        expect(transition(step, {}, 0, label)).toBe('COMPLETE');
        expect(transition(step, { open: 1 }, 0, label)).toBe('needs_fix');
        expect(transition(step, { anomalies: 1 }, 0, label)).toBe('needs_review');
        expect(transition(
          step,
          { anomalies: 1, anomalyBudgetExhausted: true },
          0,
          label,
        )).toBe('need_replan');
        expect(transition(step, { open: 1, provisional: 1 }, 0, label)).toBe('need_replan');
      }
    },
  );
});
