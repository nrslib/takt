import type { AgentResponse, CommandQualityGate } from '../../models/types.js';
import { formatCommandGateFailure, sanitizeCommandGatePromptText, sanitizeSensitiveText } from './commandGateMessage.js';
import { runCommandQualityGate } from './commandGateRunner.js';
import type { CommandQualityGateEvidence, QualityGateRunResult, RunQualityGatesOptions } from './types.js';
import { recordQualityGateResultMetric } from '../observability/workflowMetrics.js';

const UNNAMED_COMMAND_GATE_METRIC_NAME = '(unnamed)';

function createFailureResponse(content: string, persona: string, beforeReport: boolean, guidance?: string): AgentResponse {
  return {
    persona,
    status: 'done',
    content,
    timestamp: new Date(),
    ...(beforeReport ? { beforeReportGateFailed: true } : {}),
    ...(guidance === undefined ? {} : { beforeReportGateGuidance: guidance }),
  };
}

export async function runQualityGates(options: RunQualityGatesOptions): Promise<QualityGateRunResult> {
  const gates = options.qualityGates?.filter(
    (gate): gate is CommandQualityGate => typeof gate !== 'string' && gate.runAt === options.runAt,
  );
  if (gates === undefined || gates.length === 0) return { ok: true };

  const execute = () => runCommandGates(gates, options);
  return options.runWithoutInactivityTimeout === undefined ? execute() : options.runWithoutInactivityTimeout(execute);
}

async function runCommandGates(gates: readonly CommandQualityGate[], {
  runAt,
  projectRoot,
  step,
  childProcessEnv,
  signal,
  observabilityEnabled,
  runId,
  workflowName,
}: RunQualityGatesOptions): Promise<QualityGateRunResult> {
  const evidence: CommandQualityGateEvidence[] = [];
  for (const gate of gates) {
    const result = await runCommandQualityGate({ gate, projectRoot, childProcessEnv, signal });
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
      const beforeReport = runAt === 'before_report';
      return {
        ok: false,
        response: createFailureResponse(
          formatCommandGateFailure(result.failure),
          step.name,
          beforeReport,
          beforeReport && gate.guidance !== undefined
            ? sanitizeCommandGatePromptText(gate.guidance, projectRoot)
            : undefined,
        ),
      };
    }
    if (result.evidence !== undefined) {
      evidence.push(result.evidence);
    }
  }

  return { ok: true, ...(evidence.length > 0 ? { evidence } : {}) };
}
