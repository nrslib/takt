import { describe, expect, it } from 'vitest';
import { reportInputEntries } from '../core/models/workflow-report-input.js';
import { normalizeReportInputs } from '../infra/config/loaders/workflowReportInputNormalizer.js';
import { CURRENT_REPORT_BODY_LIMIT, renderCurrentReport } from '../core/workflow/instruction/prepared-instruction.js';
import { reportInputNames } from '../core/workflow/report-input-contract.js';
import { makeStep } from './test-helpers.js';
import type { WorkflowCallStep, WorkflowStep } from '../core/models/workflow-types.js';

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

  it('rejects duplicate public names before all nested reports are deduplicated', () => {
    const source: WorkflowCallStep = { name: 'source', personaDisplayName: 'source', instruction: '', kind: 'workflow_call', call: 'child' };
    const workflow = { name: 'parent', initialStep: 'source', maxSteps: 10, steps: [source] };
    const context = { projectCwd: '/', lookupCwd: '/', workflowCallResolver: () => ({
      name: 'child', initialStep: 'left', maxSteps: 10,
      steps: [
        makeStep({ name: 'left', outputContracts: [{ name: 'left/review.md', format: 'Review' }] }),
        makeStep({ name: 'right', outputContracts: [{ name: 'right/review.md', format: 'Review' }] }),
      ],
    }) };
    expect(() => reportInputNames(workflow,
      { name: 'consumer', inputReports: { fromStep: 'source', reports: 'all' } }, context)).toThrow();
  });

  function allReportsNames(kind: 'step' | 'parallel' | 'nested workflow', reportPaths: readonly string[]) {
    const contracts = reportPaths.map((name) => ({ name, format: 'Review' }));
    const source: WorkflowStep = kind === 'step'
      ? makeStep({ name: 'source', outputContracts: contracts })
      : kind === 'parallel'
        ? makeStep({ name: 'source', parallel: [
          makeStep({ name: 'left', outputContracts: [contracts[0]!] }),
          makeStep({ name: 'right', outputContracts: [contracts[1]!] }),
        ] })
        : { name: 'source', personaDisplayName: 'source', instruction: '', kind: 'workflow_call', call: 'child' };
    const workflow = { name: 'parent', initialStep: 'source', maxSteps: 10, steps: [source] };
    return reportInputNames(workflow, { name: 'consumer', inputReports: { fromStep: 'source', reports: 'all' } }, {
      projectCwd: '/', lookupCwd: '/', workflowCallResolver: () => ({
        name: 'child', initialStep: 'left', maxSteps: 10,
        steps: [
          makeStep({ name: 'left', outputContracts: [contracts[0]!] }),
          makeStep({ name: 'right', outputContracts: [contracts[1]!] }),
        ],
      }),
    });
  }

  it.each(['step', 'parallel', 'nested workflow'] as const)('accepts duplicate full paths as one reports:all input from a %s', (kind) => {
    expect(allReportsNames(kind, ['left/review.md', 'left/review.md'])).toEqual([['review.md']]);
  });

  it.each(['step', 'parallel', 'nested workflow'] as const)('rejects different full paths with one public name for reports:all from a %s', (kind) => {
    expect(() => allReportsNames(kind, ['left/review.md', 'right/review.md'])).toThrow();
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
