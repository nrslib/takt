import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { WorkflowConfig, WorkflowRule } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import {
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
  mockRunAgentSequence,
} from './engine-test-helpers.js';

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
const runtimeRoutes = [
  {
    name: 'verified',
    ruleIndex: 0,
    expectedNext: 'COMPLETE',
    report: 'All planned obligations are implemented and supported by evidence.',
  },
  {
    name: 'mixed-gap plan_invalid',
    ruleIndex: 1,
    expectedNext: 'fix-plan',
    report: 'The plan omits a required path, and an implementation gap also remains.',
  },
  {
    name: 'incomplete',
    ruleIndex: 2,
    expectedNext: 'fix-retry',
    report: 'The plan is sound, but one planned implementation obligation remains incomplete.',
  },
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

function requireRuleText(
  rule: RawWorkflowRule,
  field: 'condition' | 'next',
  source: string,
): string {
  const value = rule[field];
  if (typeof value !== 'string') {
    throw new Error(`${field} is required in ${source}`);
  }
  return value;
}

function buildRuntimeConfig(
  language: 'ja' | 'en',
  workflowName: string,
): { config: WorkflowConfig; rules: WorkflowRule[] } {
  const source = `${language}/${workflowName}`;
  const rules = verifierRules(language, workflowName).map((rule) => makeRule(
    requireRuleText(rule, 'condition', source),
    requireRuleText(rule, 'next', source),
  ));
  return {
    config: {
      name: `routing-${language}-${workflowName}`,
      description: `Runtime routing contract for ${source}`,
      maxSteps: 1,
      initialStep: 'fix-verifier',
      steps: [
        makeStep('fix-verifier', { rules }),
        makeStep('fix-plan'),
        makeStep('fix-retry'),
      ],
    },
    rules,
  };
}

const runtimeCases = (['ja', 'en'] as const).flatMap((language) => (
  workflowNames.flatMap((workflowName) => (
    runtimeRoutes.map((route) => ({ language, workflowName, ...route }))
  ))
));

let tmpDir: string;
let engine: WorkflowEngine | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runReportPhase).mockResolvedValue(undefined);
  tmpDir = createTestTmpDir();
});

afterEach(() => {
  if (engine !== undefined) {
    cleanupWorkflowEngine(engine);
    engine = undefined;
  }
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

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

  it.each(runtimeCases)(
    'routes $language/$workflowName $name through WorkflowEngine to $expectedNext',
    async ({ language, workflowName, ruleIndex, expectedNext, report }) => {
      const { config, rules } = buildRuntimeConfig(language, workflowName);
      const selectedRule = rules[ruleIndex];
      if (selectedRule?.condition.kind !== 'semantic') {
        throw new Error(`semantic rule ${ruleIndex} is required in ${language}/${workflowName}`);
      }
      mockRunAgentSequence([
        makeResponse({ persona: 'fix-verifier', content: report }),
      ]);
      vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({
        label: selectedRule.condition.label,
        method: 'phase3_tag',
      });
      engine = new WorkflowEngine(config, tmpDir, 'verify remediation', {
        projectCwd: tmpDir,
        reportDirName: 'test-report-dir',
      });

      const result = await engine.runSingleIteration();

      expect(result.nextStep).toBe(expectedNext);
      expect(result.isComplete).toBe(expectedNext === 'COMPLETE');
      expect(runAgent).toHaveBeenCalledOnce();
      expect(runStatusJudgmentPhase).toHaveBeenCalledOnce();
    },
  );
});
