/**
 * Shared helpers for unit tests and integration tests.
 *
 * Unlike engine-test-helpers.ts, this file has no mock dependencies and
 * can be safely imported from any test file without requiring vi.mock() setup.
 */

import type {
  WorkflowConfig,
  WorkflowResumePointEntry,
  WorkflowRule,
  WorkflowState,
  WorkflowStep,
} from '../core/models/types.js';
import { parseWorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';
import type { Provider } from '../infra/providers/types.js';
import type { SessionContext } from '../features/interactive/aiCaller.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';
import { WorkflowResumeContinuation } from '../core/workflow/engine/workflow-resume-continuation.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { getWorkflowResumeFrameKind } from '../core/workflow/step-kind.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';

/**
 * A provider double for tests that only need a session context to exist.
 *
 * Typed rather than cast, so a change to the provider contract shows up as a
 * type error in every test that builds one — which is the point of listing
 * these tests in `tsconfig.tests.json`.
 */
export function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    supportsStructuredOutput: false,
    supportsNativeImageInput: false,
    keepsAllowedToolWithoutEdit: () => false,
    getRuntimeInstructions: () => null,
    setup: () => ({
      call: () => Promise.reject(new Error('the provider double was asked to call')),
    }),
    ...overrides,
  };
}

/** The interactive session context, with the provider double in place. */
export function makeSessionContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    provider: makeProvider(),
    providerType: 'mock',
    model: 'mock-model',
    lang: 'en',
    personaName: 'interactive',
    sessionId: undefined,
    ...overrides,
  };
}

export function makeRule(condition: string, next: string, extra: Partial<WorkflowRule> = {}): WorkflowRule {
  return { condition: parseWorkflowRuleCondition(condition), next, ...extra };
}

export function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  // `WorkflowStep` is a union of step shapes; spreading a partial over the base
  // widens past every member, so the factory names the result it builds.
  return {
    name: 'test-step',
    personaDisplayName: 'tester',
    instruction: '',
    passPreviousResponse: false,
    ...overrides,
  } as WorkflowStep;
}

export function makeInstructionContext(overrides: Partial<InstructionContext> = {}): InstructionContext {
  return {
    task: 'test task',
    iteration: 1,
    maxSteps: 10,
    stepIteration: 1,
    cwd: '/tmp/test',
    projectCwd: '/tmp/project',
    userInputs: [],
    ...overrides,
  };
}

export function makeWorkflowResumePointEntry(
  overrides: Partial<WorkflowResumePointEntry> = {},
): WorkflowResumePointEntry {
  return {
    workflow: 'test-workflow',
    workflow_ref: 'test-workflow',
    step: 'test-step',
    kind: 'agent',
    occurrence: 1,
    ...overrides,
  };
}

export function makeFileRunMetaPathFields(cwd: string, slug: string) {
  const paths = buildRunPaths(cwd, slug);
  return {
    runSlug: paths.slug,
    runRoot: paths.runRootRel,
    reportDirectory: paths.reportsRootRel,
    contextDirectory: paths.contextRel,
    logsDirectory: paths.logsRel,
  };
}

export function createWorkflowOccurrenceTestHarness(
  workflow: WorkflowConfig,
  state: WorkflowState,
  resumeStackPrefix: readonly WorkflowResumePointEntry[],
) {
  const continuation = new WorkflowResumeContinuation(workflow, undefined);
  let activeWorkflowStack: WorkflowResumePointEntry[] | undefined;

  return {
    claimStepOccurrence: (step: WorkflowStep): number => (
      continuation.claimStepOccurrence({
        step,
        resumeStackPrefix,
        state,
      })
    ),
    setActiveStep: (
      step: WorkflowStep,
      _iteration: number,
      occurrence: number,
    ): undefined => {
      activeWorkflowStack = [
        ...resumeStackPrefix,
        buildWorkflowResumePointEntry(
          workflow,
          step.name,
          getWorkflowResumeFrameKind(step),
          occurrence,
          state.stepIterations,
        ),
      ];
      return undefined;
    },
    cancelPendingStepActivation: () => {},
    getCurrentWorkflowStack: (): WorkflowResumePointEntry[] | undefined => (
      activeWorkflowStack
    ),
  };
}

export function createWorkflowRunLoopTestContract(
  workflow: WorkflowConfig,
  state: WorkflowState,
  task: string,
) {
  return {
    ...createWorkflowOccurrenceTestHarness(workflow, state, []),
    getTask: () => task,
  };
}
