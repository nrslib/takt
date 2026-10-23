import { describe, expect, it } from 'vitest';
import { reportInputEntries } from '../core/models/workflow-report-input.js';
import { normalizeReportInputs } from '../infra/config/loaders/workflowReportInputNormalizer.js';
import { CURRENT_REPORT_BODY_LIMIT, renderCurrentReport } from '../core/workflow/instruction/prepared-instruction.js';
import { reportInputNames } from '../core/workflow/report-input-contract.js';
import { makeStep } from './test-helpers.js';
import type { WorkflowCallStep } from '../core/models/workflow-types.js';

describe('report input declarations and rendering', () => {
  it('preserves the single declaration while enumerating both accepted forms', () => {
    const raw = { from_step: 'source', reports: ['plan.md'], history: { previous: 0 } };
    const single = normalizeReportInputs(raw);
    expect(single).toEqual({ fromStep: 'source', reports: ['plan.md'], optionalIfUnrun: undefined, history: { previous: 0 } });
    expect(normalizeReportInputs([raw])).toEqual([single]);
    expect(reportInputEntries(single)).toEqual(reportInputEntries(normalizeReportInputs([raw])));
    expect(reportInputEntries(undefined)).toEqual([]);
  });

  it('renders the complete boundary body and requires a fixed path above it', () => {
    const report = { reference: 'plan.md', scope: 'declared-producer' as const, content: 'x'.repeat(CURRENT_REPORT_BODY_LIMIT) };
    expect(renderCurrentReport(report)).toBe(report.content);
    expect(() => renderCurrentReport({ ...report, content: report.content + 'Z' })).toThrow();
    const rendered = renderCurrentReport({ ...report, content: report.content + 'Z', path: '/versions/plan.md' });
    expect(rendered.startsWith(report.content)).toBe(true);
    expect(rendered).toContain('/versions/plan.md');
    expect(rendered).not.toContain('Z');
  });

  it('reserves nested producer names even when an optional source has not executed', () => {
    const source: WorkflowCallStep = { name: 'source', personaDisplayName: 'source', instruction: '', kind: 'workflow_call', call: 'child' };
    const other = makeStep({ name: 'other', outputContracts: [{ name: 'plan.md', format: 'Plan' }] });
    const workflow = { name: 'parent', initialStep: 'source', maxSteps: 10, steps: [source, other] };
    const consumer = { name: 'consumer', inputReports: [
      { fromStep: 'source', reports: 'all' as const, optionalIfUnrun: true as const },
      { fromStep: 'other', reports: ['plan.md'] },
    ] };
    const context = { projectCwd: '/', lookupCwd: '/', workflowCallResolver: () => ({
      name: 'child', initialStep: 'write', maxSteps: 10,
      steps: [makeStep({ name: 'write', outputContracts: [{ name: 'plan.md', format: 'Plan' }] })],
    }) };
    expect(() => reportInputNames(workflow, consumer, context)).toThrow();
    expect(reportInputNames(workflow, { ...consumer, inputReports: consumer.inputReports.slice(0, 1) }, context)).toEqual([['plan.md']]);
  });

  it('rejects parallel producers publishing the selected name into the same file', () => {
    const parallel = makeStep({ name: 'source', parallel: [
      makeStep({ name: 'alpha', outputContracts: [{ name: 'review.md', format: 'Review' }] }),
      makeStep({ name: 'beta', outputContracts: [{ name: 'review.md', format: 'Review' }] }),
    ] });
    const workflow = { name: 'parent', initialStep: 'source', maxSteps: 10, steps: [parallel] };
    expect(() => reportInputNames(workflow, { name: 'consumer', inputReports: { fromStep: 'source', reports: ['review.md'] } },
      { projectCwd: '/', lookupCwd: '/' })).toThrow();
  });
});
