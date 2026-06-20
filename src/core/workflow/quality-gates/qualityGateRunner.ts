import type { AgentResponse } from '../../models/types.js';
import { formatCommandGateFailure } from './commandGateMessage.js';
import { runCommandQualityGate } from './commandGateRunner.js';
import type { QualityGateRunResult, RunQualityGatesOptions } from './types.js';

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
}: RunQualityGatesOptions): Promise<QualityGateRunResult> {
  if (!qualityGates || qualityGates.length === 0) {
    return { ok: true };
  }

  for (const gate of qualityGates) {
    if (typeof gate === 'string') {
      continue;
    }

    const result = await runCommandQualityGate({ gate, projectRoot, childProcessEnv });
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
