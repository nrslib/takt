import type { WorkflowConfig } from '../../core/models/workflow-types.js';
import { previewPrompts } from '../../features/prompt/preview.js';
import { instructBranch } from '../../features/tasks/list/taskInstructionActions.js';
import { retryFailedTask } from '../../features/tasks/list/taskRetryActions.js';
import { doctorWorkflowCommand } from '../../features/workflowAuthoring/doctor.js';

const baseConfig = {
  name: 'dynamic-parallel-type-contract',
  initialStep: 'reviewers',
  maxSteps: 1,
} as const;

const validConfig: WorkflowConfig = {
  ...baseConfig,
  steps: [{
    name: 'reviewers',
    personaDisplayName: 'reviewers',
    instruction: 'review',
    parallel: {
      kind: 'dynamic',
      fixed: [{
        name: 'architecture',
        personaDisplayName: 'architecture',
        instruction: 'review architecture',
      }],
      pool: [{
        name: 'frontend',
        description: 'Review frontend changes',
        personaDisplayName: 'frontend',
        instruction: 'review frontend',
      }],
      selection: { mode: 'replace' },
    },
  }],
};

const systemParticipantConfig: WorkflowConfig = {
  ...baseConfig,
  steps: [{
    name: 'reviewers',
    personaDisplayName: 'reviewers',
    instruction: 'review',
    // @ts-expect-error Dynamic parallel participants must be normal agent steps.
    parallel: {
      kind: 'dynamic',
      fixed: [{
        name: 'cleanup',
        kind: 'system',
        personaDisplayName: 'cleanup',
        instruction: 'cleanup',
      }],
      pool: [{
        name: 'frontend',
        description: 'Review frontend changes',
        personaDisplayName: 'frontend',
        instruction: 'review frontend',
      }],
      selection: { mode: 'replace' },
    },
  }],
};

const workflowCallParticipantConfig: WorkflowConfig = {
  ...baseConfig,
  steps: [{
    name: 'reviewers',
    personaDisplayName: 'reviewers',
    instruction: 'review',
    // @ts-expect-error Dynamic parallel participants must be normal agent steps.
    parallel: {
      kind: 'dynamic',
      fixed: [],
      pool: [{
        name: 'delegate',
        description: 'Delegate the review',
        kind: 'workflow_call',
        call: 'child',
        personaDisplayName: 'delegate',
        instruction: '',
      }],
      selection: { mode: 'replace' },
    },
  }],
};

const missingDescriptionConfig: WorkflowConfig = {
  ...baseConfig,
  steps: [{
    name: 'reviewers',
    personaDisplayName: 'reviewers',
    instruction: 'review',
    // @ts-expect-error Dynamic parallel pool participants require a description.
    parallel: {
      kind: 'dynamic',
      fixed: [],
      pool: [
        {
          name: 'frontend',
          personaDisplayName: 'frontend',
          instruction: 'review frontend',
        },
      ],
      selection: { mode: 'replace' },
    },
  }],
};

void validConfig;
void systemParticipantConfig;
void workflowCallParticipantConfig;
void missingDescriptionConfig;

previewPrompts('/project');
previewPrompts('/project', 'workflow', { provider: 'mock', model: 'mock-selector' });
doctorWorkflowCommand(['workflow'], '/project');
doctorWorkflowCommand(['workflow'], '/project', { provider: 'mock', model: 'mock-selector' });

type RetryFailedTaskContract = (
  ...args: Parameters<typeof retryFailedTask> extends [infer Task, infer ProjectDir, ...unknown[]]
    ? [task: Task, projectDir: ProjectDir, agentOverrides?: { provider?: 'mock'; model?: string }]
    : never
) => ReturnType<typeof retryFailedTask>;
type InstructBranchContract = (
  ...args: Parameters<typeof instructBranch> extends [infer ProjectDir, infer Target, ...unknown[]]
    ? [projectDir: ProjectDir, target: Target, agentOverrides?: { provider?: 'mock'; model?: string }]
    : never
) => ReturnType<typeof instructBranch>;

const retryFailedTaskContract: RetryFailedTaskContract = retryFailedTask;
const instructBranchContract: InstructBranchContract = instructBranch;

void retryFailedTaskContract;
void instructBranchContract;
