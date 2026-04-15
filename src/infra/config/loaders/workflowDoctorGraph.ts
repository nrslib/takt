import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
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

const SPECIAL_NEXT = new Set(['COMPLETE', 'ABORT']);

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

export function validateDoctorGraph(
  raw: RawWorkflow,
  diagnostics: WorkflowDiagnostic[],
): void {
  const config = createDoctorGraph(raw);
  const stepNames = new Set(config.steps.map((step) => step.name));

  if (!stepNames.has(config.initialStep)) {
    diagnostics.push({
      level: 'error',
      message: `initial_step references missing step "${config.initialStep}"`,
    });
  }

  for (const step of config.steps) {
    for (const rule of step.rules ?? []) {
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
