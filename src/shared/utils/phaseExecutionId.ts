export interface PhaseExecutionIdParts {
  step: string;
  iteration: number;
  phase: 1 | 2 | 3;
  sequence: number;
}

export function buildPhaseExecutionId(parts: PhaseExecutionIdParts): string {
  if (!parts.step) {
    throw new Error('phaseExecutionId requires step');
  }
  if (!Number.isInteger(parts.iteration) || parts.iteration <= 0) {
    throw new Error(`phaseExecutionId requires positive iteration: ${parts.iteration}`);
  }
  if (parts.phase !== 1 && parts.phase !== 2 && parts.phase !== 3) {
    throw new Error(`phaseExecutionId requires phase 1|2|3: ${parts.phase}`);
  }
  if (!Number.isInteger(parts.sequence) || parts.sequence <= 0) {
    throw new Error(`phaseExecutionId requires positive sequence: ${parts.sequence}`);
  }
  return `${parts.step}:${parts.iteration}:${parts.phase}:${parts.sequence}`;
}

export function parsePhaseExecutionId(
  phaseExecutionId: string,
): PhaseExecutionIdParts | undefined {
  const parts = phaseExecutionId.split(':');
  if (parts.length !== 4) {
    return undefined;
  }
  const [step, iterationStr, phaseStr, sequenceStr] = parts;
  const iteration = Number(iterationStr);
  const phase = Number(phaseStr);
  const sequence = Number(sequenceStr);
  if (!step || !Number.isInteger(iteration) || iteration <= 0) {
    return undefined;
  }
  if (!Number.isInteger(phase) || (phase !== 1 && phase !== 2 && phase !== 3)) {
    return undefined;
  }
  if (!Number.isInteger(sequence) || sequence <= 0) {
    return undefined;
  }
  return {
    step,
    iteration,
    phase: phase as 1 | 2 | 3,
    sequence,
  };
}
