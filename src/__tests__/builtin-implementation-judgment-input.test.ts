import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/types.js';
import { runStatusJudgmentPhase } from '../core/workflow/status-judgment-phase.js';
import { loadAllWorkflowsWithSourcesFromDirs } from '../infra/config/loaders/workflowDiscovery.js';

const IMPLEMENTATION_METADATA_FORMATS = new Set([
  'coder-scope',
  'coder-decisions',
  'maintenance-scope',
]);

function loadBuiltinWorkflows(language: 'en' | 'ja') {
  return loadAllWorkflowsWithSourcesFromDirs<WorkflowConfig>(
    process.cwd(),
    [{
      dir: join(process.cwd(), 'builtins', language, 'workflows'),
      source: 'builtin',
    }],
    undefined,
    undefined,
    true,
  );
}

describe('builtin implementation status judgment input', () => {
  it.each(['en', 'ja'] as const)(
    'should exclude implementation metadata reports from status judgment in every shipped %s workflow',
    (language) => {
      const workflows = loadBuiltinWorkflows(language);
      const implementationMetadataContracts = Array.from(workflows.values())
        .filter(({ source }) => source === 'builtin')
        .flatMap(({ config }) => config.steps)
        .flatMap((step) => step.outputContracts ?? [])
        .filter(
          (contract) => contract.formatRef !== undefined
            && IMPLEMENTATION_METADATA_FORMATS.has(contract.formatRef),
        );

      expect(implementationMetadataContracts.length).toBeGreaterThan(0);
      for (const contract of implementationMetadataContracts) {
        expect(contract.useJudge).toBe(false);
      }
    },
  );

  it.each(['en', 'ja'] as const)(
    'should judge the shipped %s frontend-mini implementation from its Phase 1 response',
    async (language) => {
      const reportDir = mkdtempSync(join(tmpdir(), 'takt-implementation-judgment-'));
      const scopeMetadata = 'SCOPE_METADATA_MUST_NOT_REPLACE_IMPLEMENTATION_RESULT';
      const decisionMetadata = 'DECISION_METADATA_MUST_NOT_REPLACE_IMPLEMENTATION_RESULT';
      const implementationResult = 'IMPLEMENTATION_COMPLETE_AND_TESTS_PASSED';

      try {
        writeFileSync(join(reportDir, 'coder-scope.md'), scopeMetadata);
        writeFileSync(join(reportDir, 'coder-decisions.md'), decisionMetadata);

        const workflow = loadBuiltinWorkflows(language).get('frontend-mini')?.config;
        const implementStep = workflow?.steps.find((step) => step.name === 'implement');
        if (!implementStep) {
          throw new Error(`Missing frontend-mini implement step for ${language}`);
        }

        const structuredCaller = {
          judgeStatus: vi.fn().mockImplementation(async (
            _structuredInstruction,
            _tagInstruction,
            _candidates,
            options,
          ) => {
            options.onStructuredPromptResolved?.({
              systemPrompt: 'judge-system',
              userInstruction: 'judge-instruction',
            });
            return { candidateIndex: 0, method: 'structured_output' as const };
          }),
        };

        await runStatusJudgmentPhase(implementStep, {
          cwd: process.cwd(),
          reportDir,
          language,
          lastResponse: implementationResult,
          workflowName: workflow.name,
          iteration: 1,
          resolveStepProviderModel: vi.fn().mockReturnValue({
            provider: 'cursor',
            model: undefined,
          }),
          structuredCaller,
        });

        const [structuredInstruction, tagInstruction] = structuredCaller.judgeStatus.mock.calls[0] ?? [];
        for (const instruction of [structuredInstruction, tagInstruction]) {
          expect(instruction).toContain(implementationResult);
          expect(instruction).not.toContain(scopeMetadata);
          expect(instruction).not.toContain(decisionMetadata);
        }
      } finally {
        rmSync(reportDir, { recursive: true, force: true });
      }
    },
  );
});
