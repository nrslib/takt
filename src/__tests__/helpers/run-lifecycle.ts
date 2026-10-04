import { createHash } from 'node:crypto';
import { buildRunPaths } from '../../core/workflow/run/run-paths.js';
import { generateReportDir, isValidReportDirName } from '../../shared/utils/index.js';
import { RunMetaManager } from '../../features/tasks/execute/runMeta.js';
import type {
  WorkflowRunBootstrap,
  WorkflowRunHandle,
  WorkflowRunLifecycleComposition,
  WorkflowRunLifecycleCompositionInput,
} from '../../features/tasks/execute/workflowRunLifecycle.js';
import { projectWorkflowTerminalStage } from '../../features/tasks/execute/workflowTerminalProjection.js';

export function createWorkflowRunLifecycleCompositionTestDouble(
  createComposition: (
    input: WorkflowRunLifecycleCompositionInput,
  ) => WorkflowRunLifecycleComposition,
  input: WorkflowRunLifecycleCompositionInput,
  options: {
    readonly sessionId: string;
    readonly startedAt: string;
    readonly projectTerminalArtifacts: boolean;
  },
): WorkflowRunLifecycleComposition {
  const composition = createComposition(input);
  return {
    ...composition,
    lifecycle: {
      beginRun: async (runInput): Promise<WorkflowRunHandle> => {
        const runSlug = runInput.requestedRunSlug
          ?? generateReportDir(runInput.task);
        if (!isValidReportDirName(runSlug)) {
          throw new Error(`Invalid reportDirName: ${runSlug}`);
        }
        const runPaths = buildRunPaths(input.cwd, runSlug);
        let runMetaManager: RunMetaManager | undefined;
        const bootstrap: WorkflowRunBootstrap = {
          runSlug,
          runPaths,
          startedAt: options.startedAt,
          sessionId: options.sessionId,
          publishRunMeta: (metaInput) => {
            if (runMetaManager !== undefined) {
              return runMetaManager;
            }
            runMetaManager = new RunMetaManager(
              metaInput.runPaths,
              metaInput.task,
              metaInput.workflowName,
              metaInput.resumeSource,
              metaInput.options,
            );
            return runMetaManager;
          },
        };
        return {
          runSlug,
          runPaths,
          bootstrap,
          finish: async (outcome, payload) => {
            if (runMetaManager === undefined) {
              throw new Error('Run meta projection is not bound');
            }
            runMetaManager.projectTerminal({
              status: payload.status,
              iterations: payload.iterations,
              ...(payload.reason === undefined
                ? {}
                : { reason: payload.reason }),
              ...(payload.failure === undefined
                ? {}
                : { failure: payload.failure }),
              endTime: payload.endTime,
            });
            if (options.projectTerminalArtifacts) {
              for (const stage of ['session', 'trace'] as const) {
                projectWorkflowTerminalStage(stage, payload, {
                  runPaths,
                  metaProjection: {
                    project: () => {},
                  },
                  publicationId: 'mock-publication',
                });
              }
            }
            const payloadSha256 = createHash('sha256')
              .update(JSON.stringify(payload))
              .digest('hex');
            return {
              receipt: {
                runId: runSlug,
                publicationId: `mock-file-terminal:${runSlug}:${payloadSha256}`,
                runStatus: outcome.status,
                iteration: outcome.iteration,
                payloadSha256,
              },
              issues: [],
            };
          },
          bindExecution: async () => ({
            execution: {
              run: async (operation) => operation(new AbortController()),
            },
          }),
        };
      },
    },
  };
}
