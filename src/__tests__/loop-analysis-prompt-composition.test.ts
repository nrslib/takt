import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowLoader.js';
import { makeInstructionContext } from './test-helpers.js';

afterEach(() => {
  invalidateGlobalConfigCache();
});

describe('loop analysis prompt composition', () => {
  it.each([
    ['en', 'Facets are composed independently.', 'Cannot be addressed'],
    ['ja', 'facetsは個別に組み立てられる。', '対応不能'],
  ] as const)(
    'injects TAKT architecture knowledge into %s analysis prompts but not the review prompt',
    (language, knowledgeMarker, dispositionMarker) => {
      const previousConfigDir = process.env.TAKT_CONFIG_DIR;
      const tempConfigDir = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-prompt-'));
      process.env.TAKT_CONFIG_DIR = tempConfigDir;
      try {
        mkdirSync(tempConfigDir, { recursive: true });
        writeFileSync(
          join(tempConfigDir, 'config.yaml'),
          `language: ${language}\nenable_builtin_workflows: true\n`,
          'utf-8',
        );
        invalidateGlobalConfigCache();

        const workflow = loadWorkflowByIdentifier('loop-analysis', process.cwd());
        if (workflow === null) {
          throw new Error(`loop-analysis builtin workflow was not loaded for ${language}`);
        }
        const analyzer = workflow.steps.find((step) => step.name === 'analyze');
        const reanalyzer = workflow.steps.find((step) => step.name === 'reanalyze');
        const reviewer = workflow.steps.find((step) => step.name === 'review');
        if (analyzer === undefined || reanalyzer === undefined || reviewer === undefined) {
          throw new Error(`loop-analysis steps were not loaded for ${language}`);
        }
        const context = makeInstructionContext({
          language,
          workflowName: workflow.name,
          workflowDescription: workflow.description,
          workflowRules: workflow.allStepsRules,
          workflowSteps: workflow.steps.map((step) => ({ name: step.name })),
          validateReportReferences: false,
        });
        const analyzerPrompt = new InstructionBuilder(analyzer, context).build();
        const reanalyzerPrompt = new InstructionBuilder(reanalyzer, context).build();
        const reviewerPrompt = new InstructionBuilder(reviewer, context).build();

        expect(analyzerPrompt.split(knowledgeMarker)).toHaveLength(2);
        expect(reanalyzerPrompt.split(knowledgeMarker)).toHaveLength(2);
        expect(reanalyzerPrompt).toContain(dispositionMarker);
        expect(reviewerPrompt).not.toContain(knowledgeMarker);
      } finally {
        if (previousConfigDir === undefined) {
          delete process.env.TAKT_CONFIG_DIR;
        } else {
          process.env.TAKT_CONFIG_DIR = previousConfigDir;
        }
        invalidateGlobalConfigCache();
        rmSync(tempConfigDir, { recursive: true, force: true });
      }
    },
  );
});
