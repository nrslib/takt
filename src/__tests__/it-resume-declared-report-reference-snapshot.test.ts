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
import { makeStep } from './test-helpers.js';

describe('resume snapshot for declared report references', () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

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
});
