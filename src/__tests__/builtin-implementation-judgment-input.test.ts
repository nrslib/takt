import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/types.js';
import { runStatusJudgmentPhase } from '../core/workflow/status-judgment-phase.js';
import {
  collectValidatedWorkflowEntries,
  iterateWorkflowDir,
} from '../infra/config/loaders/workflowDiscovery.js';

// The tests only inspect these implementation workflows. Loading all ~66
// builtin workflows takes ~3s per call, so load just the needed entries once
// per language through the same entry loader the full discovery path uses.
const NEEDED_WORKFLOWS = new Set(['mini-core', 'development-core']);
const builtinWorkflowsCache = new Map<'en' | 'ja', Map<string, { config: WorkflowConfig }>>();

function loadBuiltinWorkflows(language: 'en' | 'ja') {
  const cached = builtinWorkflowsCache.get(language);
  if (cached) {
    return cached;
  }
  const entries = Array.from(iterateWorkflowDir(
    join(process.cwd(), 'builtins', language, 'workflows'),
    'builtin',
  )).filter((entry) => NEEDED_WORKFLOWS.has(entry.name));
  const workflows = new Map(
    collectValidatedWorkflowEntries<WorkflowConfig>(
      entries,
      process.cwd(),
      undefined,
      undefined,
      true,
    ).map(({ entry, config }) => [entry.name, { config }]),
  );
  builtinWorkflowsCache.set(language, workflows);
  return workflows;
}

describe('builtin implementation status judgment input', () => {
  describe.each(['en', 'ja'] as const)('shipped %s workflows', (language) => {
    it.each([
      { entrypoint: 'frontend-mini', implementationWorkflow: 'mini-core' },
      { entrypoint: 'backend-mini', implementationWorkflow: 'mini-core' },
      { entrypoint: 'backend-maintenance', implementationWorkflow: 'development-core' },
    ] as const)(
      'should judge the $entrypoint implementation from its Phase 1 response',
      async ({ entrypoint, implementationWorkflow }) => {
        const reportDir = mkdtempSync(join(tmpdir(), 'takt-implementation-judgment-'));
        const scopeMetadata = 'SCOPE_METADATA_MUST_NOT_REPLACE_IMPLEMENTATION_RESULT';
        const decisionMetadata = 'DECISION_METADATA_MUST_NOT_REPLACE_IMPLEMENTATION_RESULT';
        const maintenanceMetadata = 'MAINTENANCE_METADATA_MUST_NOT_REPLACE_IMPLEMENTATION_RESULT';
        const implementationResult = 'IMPLEMENTATION_COMPLETE_AND_TESTS_PASSED';

        try {
          writeFileSync(join(reportDir, 'coder-scope.md'), scopeMetadata);
          writeFileSync(join(reportDir, 'coder-decisions.md'), decisionMetadata);
          writeFileSync(join(reportDir, 'maintenance-scope.md'), maintenanceMetadata);

          const workflow = loadBuiltinWorkflows(language).get(implementationWorkflow)?.config;
          const implementStep = workflow?.steps.find((step) => step.name === 'implement');
          if (!implementStep) {
            throw new Error(`Missing ${entrypoint} implementation step for ${language}`);
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
            expect(instruction).not.toContain(maintenanceMetadata);
          }
        } finally {
          rmSync(reportDir, { recursive: true, force: true });
        }
      },
    );
  });
});
