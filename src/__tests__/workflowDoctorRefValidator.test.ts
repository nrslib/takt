import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema } from '../core/models/index.js';
import type { FacetResolutionContext, WorkflowSections } from '../infra/config/loaders/resource-resolver.js';
import { resolveSectionMap } from '../infra/config/loaders/resource-resolver.js';
import { validateWorkflowReferences } from '../infra/config/loaders/workflowDoctorRefValidator.js';

describe('workflowDoctorRefValidator', () => {
  it('resolves callable $param defaults against local facet sections', () => {
    const raw = WorkflowConfigRawSchema.parse({
      name: 'callable-defaults',
      subworkflow: {
        callable: true,
        params: {
          review_knowledge: {
            type: 'facet_ref[]',
            facet_kind: 'knowledge',
            default: ['architecture'],
          },
          review_instruction: {
            type: 'facet_ref',
            facet_kind: 'instruction',
            default: 'delegated-review',
          },
          review_report: {
            type: 'facet_ref',
            facet_kind: 'report_format',
            default: 'summary',
          },
        },
      },
      max_steps: 10,
      initial_step: 'review',
      knowledge: {
        architecture: './facets/knowledge/architecture.md',
      },
      instructions: {
        'delegated-review': './facets/instructions/delegated-review.md',
      },
      report_formats: {
        summary: './facets/output-contracts/summary.md',
      },
      steps: [
        {
          name: 'review',
          knowledge: { $param: 'review_knowledge' },
          instruction: { $param: 'review_instruction' },
          output_contracts: {
            report: [
              {
                name: 'summary.md',
                format: { $param: 'review_report' },
              },
            ],
          },
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });
    const workflowDir = '/project/.takt/workflows';
    const context: FacetResolutionContext = {
      lang: 'ja',
      workflowDir,
      projectDir: '/project',
      repertoireDir: '/repertoire',
    };
    const sections: WorkflowSections = {
      personas: raw.personas,
      resolvedInstructions: resolveSectionMap(raw.instructions, workflowDir),
      resolvedKnowledge: resolveSectionMap(raw.knowledge, workflowDir),
      resolvedPolicies: resolveSectionMap(raw.policies, workflowDir),
      resolvedReportFormats: resolveSectionMap(raw.report_formats, workflowDir),
    };
    const diagnostics: { level: 'error' | 'warning'; message: string }[] = [];

    validateWorkflowReferences(raw, sections, context, diagnostics);

    expect(diagnostics).toEqual([]);
  });
});
