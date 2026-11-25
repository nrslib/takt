import { describe, expect, it } from 'vitest';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { getBuiltinWorkflowsDir } from '../infra/config/paths.js';
import { reportInputNames } from '../core/workflow/report-input-contract.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';

describe('peer review adjudication handoff', () => {
  it.each(['ja', 'en'] as const)('supplies the previous decision only to follow-up reviewers (%s)', (language) => {
    const workflow = loadWorkflowFromFile(`${getBuiltinWorkflowsDir(language)}/peer-review.yaml`, process.cwd());
    const initial = workflow.steps.find((step) => step.name === 'initial-reviewers');
    const followUp = workflow.steps.find((step) => step.name === 'reviewers');
    expect(initial).toBeDefined();
    expect(followUp).toBeDefined();
    expect(initial?.inputReports).toBeUndefined();
    expect(followUp?.kind).toBe('workflow_call');
    expect(followUp?.inputReports).toEqual([
      { fromStep: 'remediation', reports: ['fix-plan.md', 'fix-report.md', 'fix-verification.md'] },
      { fromStep: 'review-adjudication', reports: ['review-resolution.md'], previousOnly: true },
    ]);
    expect(reportInputNames(workflow, followUp!, {
      projectCwd: process.cwd(), lookupCwd: process.cwd(),
      workflowCallResolver: ({ parentWorkflow, step }) => resolveWorkflowCallTarget(parentWorkflow, step, process.cwd()),
    })).toEqual([['fix-plan.md', 'fix-report.md', 'fix-verification.md'], ['review-resolution.md']]);
  });
});
