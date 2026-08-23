import type { AgentResponse } from '../../models/types.js';
import { formatCommandGateFailure, sanitizeSensitiveText } from './commandGateMessage.js';
import { runCommandQualityGate } from './commandGateRunner.js';
import type { QualityGateRunResult, RunQualityGatesOptions } from './types.js';
import { recordQualityGateResultMetric } from '../observability/workflowMetrics.js';

const UNNAMED_COMMAND_GATE_METRIC_NAME = '(unnamed)';

function createFailureResponse(content: string, persona: string): AgentResponse {
  return {
    persona,
    status: 'done',
    content,
    timestamp: new Date(),
  };
}

export async function runQualityGates({
  qualityGates,
  projectRoot,
  step,
  childProcessEnv,
  observabilityEnabled,
  runId,
  workflowName,
}: RunQualityGatesOptions): Promise<QualityGateRunResult> {
  if (!qualityGates || qualityGates.length === 0) {
    return { ok: true };
  }

  for (const gate of qualityGates) {
    if (typeof gate === 'string') {
      continue;
    }

    const result = await runCommandQualityGate({ gate, projectRoot, childProcessEnv });
    if (observabilityEnabled && workflowName) {
      recordQualityGateResultMetric({
        runId,
        workflowName,
        stepName: step.name,
        gateName: gate.name ? sanitizeSensitiveText(gate.name) : UNNAMED_COMMAND_GATE_METRIC_NAME,
        result: result.ok ? 'pass' : 'fail',
      });
    }
    if (!result.ok) {
      return {
        ok: false,
        response: createFailureResponse(
          formatCommandGateFailure(result.failure),
          step.name,
        ),
      };
    }
  }

  return { ok: true };
}
