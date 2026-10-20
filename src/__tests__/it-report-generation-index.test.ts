import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReportGenerationIndex } from '../core/workflow/report-generation-index.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { formatMissingReportReference } from '../core/workflow/instruction/report-reference.js';
import { cloneWorkflowResumePoint, parseWorkflowResumePoint } from '../core/workflow/resume-point-codec.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import { createSharedRuntime } from '../core/workflow/engine/WorkflowEngineSetup.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

describe('report generation evidence', () => {
  const roots: string[] = [];
  const root = () => {
    const path = mkdtempSync(join(tmpdir(), 'takt-report-generation-'));
    roots.push(path);
    return path;
  };
  const render = (
    reports: string,
    directory: string,
    index: ReportGenerationIndex,
    names = ['review.md'],
    declaredReportInputs?: ReturnType<typeof makeInstructionContext>['declaredReportInputs'],
  ) => new InstructionBuilder(
    makeStep({ instruction: names.map((name) => `{report:${name}}`).join('\n') }),
    makeInstructionContext({
      reportDir: directory,
      reportsRootDir: reports,
      unavailableLocalReports: index.missingNames(reports, directory),
      isUnavailableReportPath: (path) => index.isMissing(reports, dirname(path), basename(path)),
      declaredReportInputs,
    }),
  ).prepare().text;

  afterEach(() => {
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('follows the last same-name attempt through failure, alias success, and retry failure', () => {
    const reports = join(root(), 'reports');
    mkdirSync(reports);
    writeFileSync(join(reports, 'review.md'), 'OLD_REVIEW');
    const index = new ReportGenerationIndex();

    index.record(reports, reports, 'review.md', false);
    expect(render(reports, reports, index)).toContain(formatMissingReportReference('review.md'));
    expect(render(reports, reports, index)).not.toContain('OLD_REVIEW');

    writeFileSync(join(reports, 'review.md'), 'CURRENT_ALIAS_REVIEW');
    index.record(reports, reports, 'review.md', true);
    expect(render(reports, reports, index)).toContain('CURRENT_ALIAS_REVIEW');

    index.record(reports, reports, 'review.md', false);
    expect(render(reports, reports, index)).toContain(formatMissingReportReference('review.md'));
    expect(render(reports, reports, index)).not.toContain('CURRENT_ALIAS_REVIEW');
  });

  it('keeps successful outputs and declared inputs when a second output is missing', () => {
    const reports = join(root(), 'reports');
    mkdirSync(reports);
    writeFileSync(join(reports, 'plan.md'), 'CURRENT_PLAN');
    writeFileSync(join(reports, 'review.md'), 'OLD_REVIEW');
    const index = new ReportGenerationIndex();
    index.record(reports, reports, 'plan.md', true);
    index.record(reports, reports, 'review.md', false);
    const text = render(reports, reports, index, ['plan.md', 'review.md']);
    expect(text).toContain('CURRENT_PLAN');
    expect(text).toContain(formatMissingReportReference('review.md'));
    expect(text).not.toContain('OLD_REVIEW');

    const declared = render(reports, reports, index, ['review.md'], [{
      declaredNames: ['review.md'],
      reports: [{ reference: 'review.md', scope: 'declared-producer', content: 'DECLARED_REVIEW' }],
    }]);
    expect(declared).toContain('DECLARED_REVIEW');
    expect(declared).not.toContain(formatMissingReportReference('review.md'));
  });

  it('isolates sibling namespaces and restores missing evidence under a new reports root', () => {
    const oldReports = join(root(), 'reports');
    const oldChild = join(oldReports, 'subworkflows', 'child-a');
    const sibling = join(oldReports, 'subworkflows', 'child-b');
    mkdirSync(oldChild, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(oldChild, 'review.md'), 'OLD_CHILD');
    writeFileSync(join(sibling, 'review.md'), 'SIBLING_CURRENT');
    const index = new ReportGenerationIndex();
    index.record(oldReports, oldChild, 'review.md', false);
    expect(render(oldReports, oldChild, index)).not.toContain('OLD_CHILD');
    expect(render(oldReports, sibling, index)).toContain('SIBLING_CURRENT');

    const resumePoint = parseWorkflowResumePoint({
      version: 2,
      stack: [{ workflow: 'parent', workflow_ref: 'parent', step: 'consume', kind: 'agent', occurrence: 1 }],
      iteration: 1,
      elapsed_ms: 0,
      workflow_call_invocations: {},
      workflow_step_participations: {},
      missing_report_generations: index.serialized(),
    });
    const cloned = cloneWorkflowResumePoint(resumePoint);
    const newReports = join(root(), 'reports');
    const newChild = join(newReports, 'subworkflows', 'child-a');
    mkdirSync(newChild, { recursive: true });
    writeFileSync(join(newChild, 'review.md'), 'COPIED_OLD_CHILD');
    const restored = createSharedRuntime(cloned, 5).reportGenerationIndex!;
    expect(render(newReports, newChild, restored)).toContain(formatMissingReportReference('review.md'));
    expect(render(newReports, newChild, restored)).not.toContain('COPIED_OLD_CHILD');

    const legacy = new ReportGenerationIndex(parseWorkflowResumePoint({
      ...resumePoint,
      missing_report_generations: undefined,
    }).missing_report_generations);
    expect(legacy.isMissing(newReports, newChild, 'review.md')).toBe(false);
  });

  it('blocks an old ancestor body while allowing a current child body', () => {
    const reports = join(root(), 'reports');
    const child = join(reports, 'subworkflows', 'child');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(reports, 'review.md'), 'OLD_PARENT');
    const index = new ReportGenerationIndex();
    index.record(reports, reports, 'review.md', false);
    expect(render(reports, child, index)).toContain(formatMissingReportReference('review.md'));
    expect(render(reports, child, index)).not.toContain('OLD_PARENT');

    writeFileSync(join(child, 'review.md'), 'CURRENT_CHILD');
    index.record(reports, child, 'review.md', true);
    expect(render(reports, child, index)).toContain('CURRENT_CHILD');
  });

  it('blocks an old nested ancestor body and accepts a fresh body from the same file', () => {
    const reports = join(root(), 'reports');
    const child = join(reports, 'subworkflows', 'child');
    const nested = join(reports, 'nested');
    mkdirSync(child, { recursive: true });
    mkdirSync(nested);
    writeFileSync(join(nested, 'review.md'), 'STALE_NESTED_PARENT');
    const index = new ReportGenerationIndex();

    index.record(reports, reports, 'nested/review.md', false);
    expect(index.serialized()).toEqual({ '': ['nested/review.md'] });
    expect(index.missingNames(reports, reports)).toContain('nested/review.md');
    const blocked = render(reports, child, index, ['nested/review.md']);
    expect(blocked)
      .toContain(formatMissingReportReference('nested/review.md'));
    expect(blocked).not.toContain('STALE_NESTED_PARENT');

    const restoredFromOldShape = new ReportGenerationIndex({ '': ['nested/review.md'] });
    const restoredBlocked = render(reports, child, restoredFromOldShape, ['nested/review.md']);
    expect(restoredBlocked).toContain(formatMissingReportReference('nested/review.md'));
    expect(restoredBlocked).not.toContain('STALE_NESTED_PARENT');

    writeFileSync(join(nested, 'review.md'), 'FRESH_NESTED_PARENT');
    index.record(reports, nested, 'review.md', true);
    expect(render(reports, child, index, ['nested/review.md'])).toContain('FRESH_NESTED_PARENT');
    restoredFromOldShape.record(reports, nested, 'review.md', true);
    expect(render(reports, child, restoredFromOldShape, ['nested/review.md']))
      .toContain('FRESH_NESTED_PARENT');
  });

  it('rejects a failed report selected by an exact resume snapshot mapping', () => {
    const project = root();
    const sourceReports = join(project, '.takt', 'runs', 'source-run', 'reports');
    const sourceNamespace = join(sourceReports, 'subworkflows', 'old-peer');
    mkdirSync(sourceNamespace, { recursive: true });
    writeFileSync(join(sourceNamespace, 'review.md'), 'STALE_SNAPSHOT_REVIEW');
    const index = new ReportGenerationIndex();
    index.record(sourceReports, sourceNamespace, 'review.md', false);
    const consumerKey = '{"workflow":"review-gate","step":"consume","calls":[]}';
    inheritResumeReportSnapshot({
      cwd: project,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
      resumeReportConsumers: [{
        consumerKey,
        reportDirectories: ['subworkflows/old-peer'],
        references: [{ reference: 'review.md', path: 'subworkflows/old-peer/review.md' }],
      }],
    });
    const targetReports = join(project, '.takt', 'runs', 'target-run', 'reports');
    const currentNamespace = join(targetReports, 'subworkflows', 'new-peer');
    mkdirSync(currentNamespace, { recursive: true });
    const restored = new ReportGenerationIndex(index.serialized());
    const prepared = new InstructionBuilder(
      makeStep({ instruction: '{report:review.md}' }),
      makeInstructionContext({
        reportDir: currentNamespace,
        reportsRootDir: targetReports,
        resumeReportConsumerKey: consumerKey,
        unavailableLocalReports: restored.missingNames(targetReports, currentNamespace),
        isUnavailableReportPath: (path) => restored.isMissing(targetReports, dirname(path), basename(path)),
      }),
    ).prepare();
    expect(prepared.text).toContain(formatMissingReportReference('review.md'));
    expect(prepared.text).not.toContain('STALE_SNAPSHOT_REVIEW');
  });

  it('rejects an old nested report selected by an exact resume snapshot mapping', () => {
    const project = root();
    const sourceReports = join(project, '.takt', 'runs', 'source-run', 'reports');
    const sourceNamespace = join(sourceReports, 'subworkflows', 'old-peer');
    const nested = join(sourceNamespace, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'review.md'), 'STALE_NESTED_SNAPSHOT');
    const index = new ReportGenerationIndex();
    index.record(sourceReports, sourceNamespace, 'nested/review.md', false);
    const consumerKey = '{"workflow":"review-gate","step":"consume","calls":[]}';
    inheritResumeReportSnapshot({
      cwd: project,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
      resumeReportConsumers: [{
        consumerKey,
        reportDirectories: ['subworkflows/old-peer'],
        references: [{ reference: 'nested/review.md', path: 'subworkflows/old-peer/nested/review.md' }],
      }],
    });
    const targetReports = join(project, '.takt', 'runs', 'target-run', 'reports');
    const currentNamespace = join(targetReports, 'subworkflows', 'new-peer');
    mkdirSync(currentNamespace, { recursive: true });
    const restored = new ReportGenerationIndex(index.serialized());
    const prepare = () => new InstructionBuilder(
      makeStep({ instruction: '{report:nested/review.md}' }),
      makeInstructionContext({
        reportDir: currentNamespace,
        reportsRootDir: targetReports,
        resumeReportConsumerKey: consumerKey,
        unavailableLocalReports: restored.missingNames(targetReports, currentNamespace),
        isUnavailableReportPath: (path) => restored.isMissing(targetReports, dirname(path), basename(path)),
      }),
    ).prepare();
    const prepared = prepare();
    expect(prepared.text).toContain(formatMissingReportReference('nested/review.md'));
    expect(prepared.text).not.toContain('STALE_NESTED_SNAPSHOT');

    const copiedNested = join(targetReports, 'subworkflows', 'old-peer', 'nested');
    writeFileSync(join(copiedNested, 'review.md'), 'FRESH_NESTED_SNAPSHOT');
    restored.record(targetReports, copiedNested, 'review.md', true);
    expect(prepare().text).toContain('FRESH_NESTED_SNAPSHOT');
  });
});
