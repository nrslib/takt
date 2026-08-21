import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

interface RawWorkflowRule {
  condition?: unknown;
  next?: unknown;
}

interface RawWorkflowStep {
  name?: unknown;
  rules?: RawWorkflowRule[];
}

interface RawWorkflow {
  steps?: RawWorkflowStep[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowNames = [
  'development-remediation',
  'development-remediation-dynamic',
  'development-remediation-team',
  'review-remediation',
] as const;
const sourceDiscoveryEvalFiles = [
  'promptfooconfig.fix-verifier-family-boundary.yaml',
  'promptfooconfig.fix-verifier-state-closure.yaml',
  'promptfooconfig.fix-verifier-model-matrix.yaml',
] as const;

function readBuiltin(language: 'ja' | 'en', relativePath: string): string {
  return readFileSync(join(repoRoot, 'builtins', language, relativePath), 'utf8');
}

function verifierRules(language: 'ja' | 'en', workflowName: string): RawWorkflowRule[] {
  const workflow = parseYaml(readBuiltin(language, `workflows/${workflowName}.yaml`)) as RawWorkflow;
  const verifier = workflow.steps?.find((step) => step.name === 'fix-verifier');
  if (verifier?.rules === undefined) {
    throw new Error(`fix-verifier rules are required in ${language}/${workflowName}`);
  }
  return verifier.rules;
}

describe('fix-verifier result ownership', () => {
  it.each(['ja', 'en'] as const)('keeps result selection out of the %s instruction facet', (language) => {
    const instruction = readBuiltin(
      language,
      'facets/partials/instructions/repair-verification-path-check.md',
    );

    expect(instruction).not.toContain('plan_invalid');
  });

  it.each(sourceDiscoveryEvalFiles)(
    'keeps workflow-result selection out of the Phase 1 rubric in %s',
    (fileName) => {
      const config = readFileSync(join(repoRoot, 'eval', fileName), 'utf8');

      expect(config).not.toContain('final result must');
      expect(config).toMatch(
        /Overall workflow-result selection is not\s+part of this Phase 1/,
      );
    },
  );

  it.each(['ja', 'en'] as const)('defines mixed-gap precedence in every %s remediation workflow', (language) => {
    for (const workflowName of workflowNames) {
      const rules = verifierRules(language, workflowName);

      expect(rules.map((rule) => rule.next)).toEqual(['COMPLETE', 'fix-plan', 'fix-retry']);
      expect(rules[1]?.condition).toEqual(expect.stringContaining('plan_invalid'));
      expect(rules[1]?.condition).toEqual(expect.stringContaining(
        language === 'ja' ? '同時にある場合を含む' : 'also have implementation or evidence gaps',
      ));
      expect(rules[2]?.condition).toEqual(expect.stringContaining('incomplete'));
      expect(rules[2]?.condition).toEqual(expect.stringContaining(
        language === 'ja' ? '修正計画に不備はない' : 'fix plan has no defect',
      ));
    }
  });
});
