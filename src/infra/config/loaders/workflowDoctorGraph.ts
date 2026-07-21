import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import { FINDING_CONFLICT_ADJUDICATION_STEP, NEEDS_ADJUDICATION_STEP } from '../../../core/workflow/constants.js';
import type { WorkflowDiagnostic } from './workflowDoctorTypes.js';

type RawWorkflow = ReturnType<typeof WorkflowConfigRawSchema.parse>;

type DoctorGraphRule = {
  next?: string;
};

type DoctorGraphStep = {
  name: string;
  parallel?: DoctorGraphStep[];
  rules?: DoctorGraphRule[];
};

type DoctorGraphMonitor = {
  cycle: string[];
  judge: {
    rules: DoctorGraphRule[];
  };
};

type DoctorGraph = {
  initialStep: string;
  loopMonitors?: DoctorGraphMonitor[];
  steps: DoctorGraphStep[];
};

// NEEDS_ADJUDICATION (対策バッチ B1) is a pure routing marker like COMPLETE/ABORT
// — no step object is synthesized for it — so it belongs in TERMINAL_NEXT, not
// SYNTHESIZED_NEXT below.
const TERMINAL_NEXT = new Set(['COMPLETE', 'ABORT', NEEDS_ADJUDICATION_STEP]);

// The engine synthesizes this step at construction time (injectFindingConflictAdjudicationStep)
// rather than authoring it in config.steps, so it never appears in the raw
// workflow's step list. Treat it like the terminal targets for "unknown next
// step" / reachability purposes — WorkflowValidator does the same via its own
// stepNames.add(FINDING_CONFLICT_ADJUDICATION_STEP) (WorkflowValidator.ts).
const SYNTHESIZED_NEXT = new Set([FINDING_CONFLICT_ADJUDICATION_STEP]);

const SPECIAL_NEXT = new Set([...TERMINAL_NEXT, ...SYNTHESIZED_NEXT]);

// Targets that only make sense when a finding ledger exists to evaluate
// against — routing to either without finding_contract configured is a
// configuration mistake. Mirrors WorkflowValidator's
// validateFindingConflictAdjudicationRuleContract /
// validateNeedsAdjudicationRuleContract.
const CONTRACT_REQUIRED_NEXT = new Set([FINDING_CONFLICT_ADJUDICATION_STEP, NEEDS_ADJUDICATION_STEP]);

function collectStepEdges(config: DoctorGraph): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const step of config.steps) {
    const nextSteps = new Set<string>();
    for (const rule of step.rules ?? []) {
      if (rule.next && !SPECIAL_NEXT.has(rule.next)) {
        nextSteps.add(rule.next);
      }
    }
    edges.set(step.name, nextSteps);
  }

  for (const monitor of config.loopMonitors ?? []) {
    const monitorTargets = monitor.judge.rules
      .map((rule) => rule.next)
      .filter((next): next is string => typeof next === 'string' && !SPECIAL_NEXT.has(next));

    for (const stepName of monitor.cycle) {
      const nextSteps = edges.get(stepName);
      if (!nextSteps) {
        continue;
      }
      for (const next of monitorTargets) {
        nextSteps.add(next);
      }
    }
  }

  return edges;
}

function collectReachableSteps(config: DoctorGraph): Set<string> {
  const edges = collectStepEdges(config);
  const visited = new Set<string>();
  const queue = [config.initialStep];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current) || SPECIAL_NEXT.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of edges.get(current) ?? []) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }

  return visited;
}

function createDoctorGraph(raw: RawWorkflow): DoctorGraph {
  return {
    initialStep: raw.initial_step ?? raw.steps[0]!.name,
    loopMonitors: raw.loop_monitors?.map((monitor) => ({
      cycle: [...monitor.cycle],
      judge: {
        rules: monitor.judge.rules.map((rule) => ({ next: rule.next })),
      },
    })),
    steps: raw.steps.map((step) => ({
      name: step.name,
      parallel: step.parallel?.map((substep) => ({
        name: substep.name,
        rules: substep.rules?.map((rule) => ({ next: rule.next })),
      })),
      rules: step.rules?.map((rule) => ({ next: rule.next })),
    })),
  };
}

/**
 * Mirrors WorkflowValidator's validateFindingConflictAdjudicationRuleContract /
 * validateNeedsAdjudicationRuleContract: `next: finding-conflict-adjudication`
 * and `next: NEEDS_ADJUDICATION` only make sense when a finding ledger exists
 * to evaluate against. Doctor runs on the raw (pre-load) config, so the check
 * accepts either a local `finding_contract` or an explicit callable
 * `subworkflow.requires_finding_contract` declaration. Cross-workflow
 * validation separately verifies that the caller actually provides the
 * inherited contract.
 */
function targetRequiresFindingContract(rule: DoctorGraphRule): boolean {
  return rule.next !== undefined && CONTRACT_REQUIRED_NEXT.has(rule.next);
}

export function validateDoctorGraph(
  raw: RawWorkflow,
  diagnostics: WorkflowDiagnostic[],
): void {
  const config = createDoctorGraph(raw);
  const stepNames = new Set(config.steps.map((step) => step.name));
  const findingContractConfigured = raw.finding_contract !== undefined
    || raw.subworkflow?.requires_finding_contract === true;

  if (!stepNames.has(config.initialStep)) {
    diagnostics.push({
      level: 'error',
      message: `initial_step references missing step "${config.initialStep}"`,
    });
  }

  for (const step of config.steps) {
    for (const rule of step.rules ?? []) {
      if (!findingContractConfigured && targetRequiresFindingContract(rule)) {
        diagnostics.push({
          level: 'error',
          message: `Step "${step.name}" routes to "${rule.next}" but finding_contract is not configured`,
        });
      }

      if (!rule.next || SPECIAL_NEXT.has(rule.next) || stepNames.has(rule.next)) {
        continue;
      }
      diagnostics.push({
        level: 'error',
        message: `Step "${step.name}" routes to unknown next step "${rule.next}"`,
      });
    }

    for (const sub of step.parallel ?? []) {
      for (const rule of sub.rules ?? []) {
        if (targetRequiresFindingContract(rule)) {
          if (!findingContractConfigured) {
            diagnostics.push({
              level: 'error',
              message: `Step "${step.name}/${sub.name}" routes to "${rule.next}" but finding_contract is not configured`,
            });
          }
          // 事実確認済み: parallel サブステップの rules[].next はエンジンで
          // 遷移として消費されない（ParallelRunner が集約し、遷移は親ステップの
          // rules だけが決める。AggregateEvaluator はサブステップの一致条件の
          // 文字列しか見ない）。合成ステップへの配線はステップ注入の条件
          // （workflowWiresFindingConflictAdjudication）にだけ数えられ、経路と
          // しては死んでいるため、意図どおりに動かないことを警告する。
          diagnostics.push({
            level: 'warning',
            message: `Step "${step.name}/${sub.name}" routes to "${rule.next}" from a parallel sub-step, but sub-step "next" is ignored by parallel aggregation; wire the parent step's rules instead`,
          });
        }

        if (!rule.next || SPECIAL_NEXT.has(rule.next) || stepNames.has(rule.next)) {
          continue;
        }
        diagnostics.push({
          level: 'error',
          message: `Step "${step.name}/${sub.name}" routes to unknown next step "${rule.next}"`,
        });
      }
    }
  }

  for (const monitor of config.loopMonitors ?? []) {
    const label = monitor.cycle.join(' -> ');
    for (const rule of monitor.judge.rules) {
      if (!findingContractConfigured && targetRequiresFindingContract(rule)) {
        diagnostics.push({
          level: 'error',
          message: `Loop monitor "${label}" routes to "${rule.next}" but finding_contract is not configured`,
        });
      }

      if (!rule.next || SPECIAL_NEXT.has(rule.next) || stepNames.has(rule.next)) {
        continue;
      }
      diagnostics.push({
        level: 'error',
        message: `Loop monitor "${label}" routes to unknown next step "${rule.next}"`,
      });
    }
  }

  const reachable = collectReachableSteps(config);
  const unreachable = config.steps
    .map((step) => step.name)
    .filter((name) => !reachable.has(name));

  if (unreachable.length > 0) {
    diagnostics.push({
      level: 'error',
      message: `Unreachable steps: ${unreachable.join(', ')}`,
    });
  }
}
