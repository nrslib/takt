import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowConfig } from '../core/models/types.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { buildResumeReportSnapshotConsumerEntry } from '../core/workflow/run/resume-report-reference-snapshot.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import { buildWorkflowCallNamespaceSegment } from '../core/workflow/workflow-call-namespace.js';
import { buildWorkflowStepParticipationIdentity } from '../core/workflow/workflow-step-participation-index.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { makeInstructionContext, makeStep, makeWorkflowResumePointEntry } from './test-helpers.js';
import { attachWorkflowOpaqueRef } from '../shared/workflowConfigMetadata.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import { buildResumeReportConsumerKeyFromStack } from '../core/workflow/run/resume-report-consumer.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { formatMissingReportReference, resolveReportReferenceDetailed } from '../core/workflow/instruction/report-reference.js';

describe('resume snapshot for declared report references', () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  it.each([
    { changed: false, callInstance: 1 },
    { changed: false, callInstance: 2 },
    { changed: true, callInstance: 1 },
    { changed: true, callInstance: 2 },
  ])('transfers the saved mapping only for the same call instance (hash changed=$changed, call=$callInstance)', ({ changed, callInstance }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-resume-consumer-key-'));
    directories.push(cwd);
    const oldChild = attachWorkflowOpaqueRef<WorkflowConfig>({
      name: 'child', initialStep: 'write', maxSteps: 3,
      steps: [
        makeStep({ name: 'write', outputContracts: [{ name: 'declared.md', format: 'Declared' }] }),
        makeStep({ name: 'consume', instruction: '{report:sibling.md}\n{report:declared.md}',
          inputReports: { fromStep: 'write', reports: ['declared.md'] } }),
      ],
    }, 'old-child');
    const child = changed ? attachWorkflowOpaqueRef({ ...oldChild }, 'new-child') : oldChild;
    const parent: WorkflowConfig = {
      name: 'parent', initialStep: 'delegate-a', maxSteps: 3,
      steps: ['delegate-a', 'delegate-b'].map((name) => makeStep({ name, kind: 'workflow_call', call: 'child' })),
    };
    const call = buildWorkflowResumePointEntry(parent, 'delegate-a', 'workflow_call', 1, undefined, 1);
    const stack = [call, buildWorkflowResumePointEntry(oldChild, 'consume', 'agent', 1, new Map([['write', 1]]))];
    const namespace = buildWorkflowCallNamespaceSegment('delegate-a', child.name, 1);
    const selectedDirectory = `subworkflows/${namespace}`;
    const siblingDirectory = 'subworkflows/iteration-1--step-reviews--workflow-sibling';
    const otherDirectory = 'subworkflows/iteration-1--step-delegate-b--workflow-child';
    const origin = buildRunPaths(cwd, 'origin-run').reportsRootAbs;
    for (const directory of [selectedDirectory, siblingDirectory, otherDirectory]) mkdirSync(join(origin, directory), { recursive: true });
    writeFileSync(join(origin, selectedDirectory, 'declared.md'), 'DECLARED');
    writeFileSync(join(origin, siblingDirectory, 'sibling.md'), 'CHAINED REVIEW RESOLUTION');
    writeFileSync(join(origin, otherDirectory, 'sibling.md'), 'OTHER');
    const oldKey = buildResumeReportConsumerKeyFromStack(stack)!;
    const otherStack = [buildWorkflowResumePointEntry(parent, 'delegate-b', 'workflow_call', 1, undefined, 1), stack[1]!];
    inheritResumeReportSnapshot({
      cwd, sourceRunSlug: 'origin-run', targetRunSlug: 'source-run',
      resumeReportConsumers: [
        { consumerKey: oldKey, reportDirectories: [selectedDirectory, siblingDirectory],
          references: [{ reference: 'sibling.md', path: `${siblingDirectory}/sibling.md` }] },
        { consumerKey: buildResumeReportConsumerKeyFromStack(otherStack)!, reportDirectories: [otherDirectory],
          references: [{ reference: 'sibling.md', path: `${otherDirectory}/sibling.md` }] },
      ],
    });

    const currentCall = { ...call, call_instance: callInstance };
    const entry = buildResumeReportSnapshotConsumerEntry({
      cwd, projectCwd: cwd, sourceRunSlug: 'source-run', workflow: parent, workflowCallResolver: () => child,
      resumePoint: { version: 2, iteration: 2, elapsed_ms: 0, stack: [currentCall, stack[1]!],
        workflow_call_invocations: {
          [buildWorkflowCallInvocationIdentity(parent.name, 'delegate-a', [])]: {
            call_instance: callInstance, report_namespace_segment: namespace,
          },
        },
        workflow_step_participations: {
          [buildWorkflowStepParticipationIdentity(getWorkflowReference(oldChild), 'write', [currentCall])]: { report_names: ['declared.md'] },
        },
      },
    })!;

    expect(entry.consumerKey).toBe(buildResumeReportConsumerKeyFromStack([
      currentCall, buildWorkflowResumePointEntry(child, 'consume', 'agent', 1),
    ]));
    const manifest = inheritResumeReportSnapshot({
      cwd, sourceRunSlug: 'source-run', targetRunSlug: 'resumed-run', resumeReportConsumers: [entry],
    });
    const reports = buildRunPaths(cwd, 'resumed-run').reportsRootAbs;
    const currentReports = join(reports, selectedDirectory);
    const context = { stepName: 'consume', reportsRootDir: reports, resumeReportConsumerKey: entry.consumerKey };
    const resolved = resolveReportReferenceDetailed(currentReports, 'sibling.md', context);
    const prepared = new InstructionBuilder(child.steps[1]!, makeInstructionContext({
      cwd, reportDir: currentReports, ...context,
    })).prepare();
    const expectedReport = {
      reference: 'sibling.md',
      scope: callInstance === 1 ? 'resume-snapshot-readonly' : 'missing',
      content: callInstance === 1 ? 'CHAINED REVIEW RESOLUTION' : formatMissingReportReference('sibling.md'),
    };
    expect({
      directories: entry.reportDirectories,
      references: manifest.resumeReportConsumers?.[0]?.references,
      resolved,
      injected: prepared.injectedReports.find((report) => report.reference === 'sibling.md'),
    }).toEqual({
      directories: callInstance === 1 ? [selectedDirectory, siblingDirectory] : [selectedDirectory],
      references: callInstance === 1 ? [{ reference: 'sibling.md', path: `${siblingDirectory}/sibling.md` }] : [],
      resolved: { scope: expectedReport.scope, content: expectedReport.content },
      injected: expectedReport,
    });
  });

  it('resolves a saved body only when every ancestor call instance matches', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-resume-ancestor-calls-'));
    directories.push(cwd);
    const outer = makeWorkflowResumePointEntry({ workflow: 'parent', workflow_ref: 'parent', step: 'delegate', kind: 'workflow_call', occurrence: 2, call_instance: 1 });
    const inner = makeWorkflowResumePointEntry({ workflow: 'child', workflow_ref: 'child', step: 'delegate', kind: 'workflow_call', occurrence: 3, call_instance: 1 });
    const active = makeWorkflowResumePointEntry({ workflow: 'leaf', workflow_ref: 'leaf', step: 'consume' });
    const sourceReports = buildRunPaths(cwd, 'source-run').reportsRootAbs;
    const savedDirectory = 'subworkflows/saved-peer';
    mkdirSync(join(sourceReports, savedDirectory), { recursive: true });
    writeFileSync(join(sourceReports, savedDirectory, 'sibling.md'), 'SAVED');
    inheritResumeReportSnapshot({
      cwd, sourceRunSlug: 'source-run', targetRunSlug: 'resumed-run',
      resumeReportConsumers: [{
        consumerKey: buildResumeReportConsumerKeyFromStack([outer, inner, active])!,
        reportDirectories: [savedDirectory], references: [{ reference: 'sibling.md', path: `${savedDirectory}/sibling.md` }],
      }],
    });
    const reports = buildRunPaths(cwd, 'resumed-run').reportsRootAbs;
    const currentReports = join(reports, 'subworkflows/current');
    mkdirSync(currentReports, { recursive: true });
    for (const [stack, matches] of [
      [[outer, inner, active], true],
      [[{ ...outer, call_instance: 2 }, inner, active], false],
      [[outer, { ...inner, call_instance: 2 }, active], false],
    ] as const) {
      expect(resolveReportReferenceDetailed(currentReports, 'sibling.md', {
        stepName: 'consume', reportsRootDir: reports, resumeReportConsumerKey: buildResumeReportConsumerKeyFromStack(stack),
      })).toEqual(matches
        ? { scope: 'resume-snapshot-readonly', content: 'SAVED' }
        : { scope: 'missing', content: formatMissingReportReference('sibling.md') });
    }
  });

  it('does not bind a declared nested report to a same-name local file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-resume-declared-report-'));
    directories.push(cwd);
    const child: WorkflowConfig = {
      name: 'child', initialStep: 'write', maxSteps: 3,
      steps: [makeStep({ name: 'write', outputContracts: [{ name: 'review-summary.md', format: 'summary' }] })],
    };
    const workflow: WorkflowConfig = {
      name: 'parent', initialStep: 'source', maxSteps: 3,
      steps: [
        makeStep({ name: 'source', kind: 'workflow_call', call: 'child' }),
        makeStep({
          name: 'consumer',
          inputReports: { fromStep: 'source', reports: 'all' },
          instruction: '{report:review-summary.md}\n{report:local.md}',
        }),
      ],
    };
    const reports = buildRunPaths(cwd, 'source-run').reportsRootAbs;
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, 'review-summary.md'), 'UNRELATED-LOCAL');
    writeFileSync(join(reports, 'local.md'), 'LOCAL');
    const callPath = buildWorkflowResumePointEntry(workflow, 'source', 'workflow_call', 1, undefined, 1);
    const namespace = buildWorkflowCallNamespaceSegment('source', child.name, 1);
    const entry = buildResumeReportSnapshotConsumerEntry({
      cwd,
      projectCwd: cwd,
      sourceRunSlug: 'source-run',
      workflow,
      resumePoint: {
        version: 2,
        stack: [buildWorkflowResumePointEntry(workflow, 'consumer', 'agent', 1)],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {
          [buildWorkflowCallInvocationIdentity(workflow.name, 'source', [])]: {
            call_instance: 1,
            report_namespace_segment: namespace,
            completed: true,
          },
        },
        workflow_step_participations: {
          [buildWorkflowStepParticipationIdentity(child.name, 'write', [callPath])]: {
            report_names: ['review-summary.md'],
          },
        },
      },
      workflowCallResolver: () => child,
    });

    expect(entry?.references).toEqual([{ reference: 'local.md', path: 'local.md' }]);
  });

  it.each(['all', ['review-summary.md']] as const)(
    'keeps declared names reserved after a child workflow hash change with reports=%s', (reports) => {
      const cwd = mkdtempSync(join(tmpdir(), 'takt-resume-changed-report-'));
      directories.push(cwd);
      const oldChild: WorkflowConfig = attachWorkflowOpaqueRef({
        name: 'child', initialStep: 'write', maxSteps: 3,
        steps: [
          makeStep({ name: 'write', outputContracts: [{ name: 'review-summary.md', format: 'Summary' }] }),
          makeStep({ name: 'consume', instruction: '{report:review-summary.md}\n{report:local.md}',
            inputReports: { fromStep: 'write', reports: reports === 'all' ? 'all' : [...reports] } }),
        ],
      }, `builtin:v2:sha256:${'a'.repeat(64)}`);
      const currentChild = attachWorkflowOpaqueRef({ ...oldChild }, `builtin:v2:sha256:${'b'.repeat(64)}`);
      const parent: WorkflowConfig = {
        name: 'parent', initialStep: 'delegate', maxSteps: 3,
        steps: [makeStep({ name: 'delegate', kind: 'workflow_call', call: 'child' })],
      };
      const call = buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', 1, undefined, 1);
      const namespace = buildWorkflowCallNamespaceSegment('delegate', oldChild.name, 1);
      const directory = `subworkflows/${namespace}`;
      const sourceReports = buildRunPaths(cwd, 'source-run').reportsRootAbs;
      mkdirSync(join(sourceReports, directory), { recursive: true });
      writeFileSync(join(sourceReports, directory, 'review-summary.md'), 'DECLARED');
      writeFileSync(join(sourceReports, directory, 'local.md'), 'LOCAL');
      writeFileSync(join(sourceReports, 'review-summary.md'), 'UNRELATED');

      const entry = buildResumeReportSnapshotConsumerEntry({
        cwd, projectCwd: cwd, sourceRunSlug: 'source-run', workflow: parent,
        workflowCallResolver: () => currentChild,
        resumePoint: {
          version: 2, iteration: 2, elapsed_ms: 0,
          stack: [call, buildWorkflowResumePointEntry(oldChild, 'consume', 'agent', 1,
            new Map([['write', 1], ['consume', 1]]))],
          workflow_call_invocations: {
            [buildWorkflowCallInvocationIdentity(parent.name, 'delegate', [])]: {
              call_instance: 1, report_namespace_segment: namespace,
            },
          },
          workflow_step_participations: {
            [buildWorkflowStepParticipationIdentity(getWorkflowReference(oldChild), 'write', [call])]: {
              report_names: ['review-summary.md'],
            },
          },
        },
      });

      expect(entry).toBeDefined();
      expect(entry!.reportDirectories).toContain(directory);
      expect(entry!.references).toEqual([{ reference: 'local.md', path: `${directory}/local.md` }]);
    },
  );
});
