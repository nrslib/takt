import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const QUALITY_CHECK_GATE = {
  type: 'command',
  name: 'takt-quality-check',
  command: 'bash ./.takt/quality-gates/takt-check.sh',
  timeout_ms: 1800000,
};

const STEPS_REQUIRING_QUALITY_CHECK = [
  'implement',
  'fix',
  'ai_fix',
  'ai-antipattern-fix',
  'fix_supervisor',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProjectConfig(): Record<string, unknown> {
  const configPath = join(process.cwd(), '.takt', 'config.yaml');
  const parsed = parseYaml(readFileSync(configPath, 'utf-8'));
  if (!isRecord(parsed)) {
    throw new Error('.takt/config.yaml must be a YAML object.');
  }
  return parsed;
}

function getStepQualityGates(config: Record<string, unknown>, stepName: string): unknown[] {
  const workflowOverrides = config.workflow_overrides;
  if (!isRecord(workflowOverrides)) {
    throw new Error('workflow_overrides must be a YAML object.');
  }
  const steps = workflowOverrides.steps;
  if (!isRecord(steps)) {
    throw new Error('workflow_overrides.steps must be a YAML object.');
  }
  const step = steps[stepName];
  if (!isRecord(step)) {
    throw new Error(`workflow_overrides.steps.${stepName} must be a YAML object.`);
  }
  if (!Array.isArray(step.quality_gates)) {
    throw new Error(`workflow_overrides.steps.${stepName}.quality_gates must be a YAML array.`);
  }
  return step.quality_gates;
}

function hasQualityCheckGate(gates: unknown[]): boolean {
  return gates.some((gate) => (
    isRecord(gate) &&
    gate.type === QUALITY_CHECK_GATE.type &&
    gate.name === QUALITY_CHECK_GATE.name &&
    gate.command === QUALITY_CHECK_GATE.command &&
    gate.timeout_ms === QUALITY_CHECK_GATE.timeout_ms
  ));
}

describe('project .takt/config.yaml quality gate overrides', () => {
  it('keeps the takt-quality-check command gate on edit workflow steps', () => {
    const config = readProjectConfig();

    for (const stepName of STEPS_REQUIRING_QUALITY_CHECK) {
      const gates = getStepQualityGates(config, stepName);

      expect(hasQualityCheckGate(gates), stepName).toBe(true);
    }
  });
});
