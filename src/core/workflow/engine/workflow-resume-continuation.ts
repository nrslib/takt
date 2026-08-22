import type {
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { getWorkflowResumeFrameKind, isWorkflowCallStep } from '../step-kind.js';
import type { ResumeArtifactOccurrenceIndex } from '../run/resume-artifact-occurrence-index.js';
import { matchesResumeStackPrefix } from '../run/resume-point.js';
import {
  workflowEntriesMatch,
  workflowEntryMatchesWorkflow,
} from '../workflow-reference.js';
import { buildWorkflowStackStepIterationIdentity } from '../step-iteration-identity.js';
import { incrementStepIteration } from './state-manager.js';

export class WorkflowResumeContinuation {
  readonly #workflow: WorkflowConfig;
  readonly #source: WorkflowResumePoint | undefined;
  readonly #resumeArtifactOccurrences: ResumeArtifactOccurrenceIndex | undefined;
  readonly #consumedFrameIndices = new Set<number>();
  readonly #claimedWorkflowCallFrames = new Map<
    number,
    WorkflowResumePointEntry
  >();

  constructor(
    workflow: WorkflowConfig,
    source: WorkflowResumePoint | undefined,
    resumeArtifactOccurrences?: ResumeArtifactOccurrenceIndex,
  ) {
    this.#workflow = workflow;
    this.#source = source;
    this.#resumeArtifactOccurrences = resumeArtifactOccurrences;
  }

  claimStepOccurrence(input: {
    readonly step: WorkflowStep;
    readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
    readonly state: WorkflowState;
    readonly isOccurrenceNamespaceReserved?: (occurrence: number) => boolean;
  }): number {
    const frameIndex = input.resumeStackPrefix.length;
    const stepIterationIdentity = buildWorkflowStackStepIterationIdentity(
      this.#workflow,
      input.step.name,
      input.resumeStackPrefix,
    );
    const source = this.#source;
    const sourceFrame = source?.stack[frameIndex];
    if (
      source === undefined
      || sourceFrame === undefined
      || this.#consumedFrameIndices.has(frameIndex)
      || !matchesResumeStackPrefix(
        source.stack,
        input.resumeStackPrefix,
      )
      || !workflowEntryMatchesWorkflow(sourceFrame, this.#workflow)
      || sourceFrame.step !== input.step.name
      || sourceFrame.kind !== getWorkflowResumeFrameKind(input.step)
    ) {
      if (isWorkflowCallStep(input.step)) {
        const inheritedMax = this.#resumeArtifactOccurrences?.getMaxOccurrence(
          this.#workflow,
          input.step.name,
          input.resumeStackPrefix,
        );
        const current = input.state.stepIterations.get(stepIterationIdentity) ?? 0;
        if (inheritedMax !== undefined && inheritedMax > current) {
          input.state.stepIterations.set(stepIterationIdentity, inheritedMax);
        }
      }
      let occurrence = incrementStepIteration(input.state, stepIterationIdentity);
      while (input.isOccurrenceNamespaceReserved?.(occurrence) === true) {
        occurrence = incrementStepIteration(input.state, stepIterationIdentity);
      }
      return occurrence;
    }

    const restoredOccurrence = input.state.stepIterations.get(stepIterationIdentity);
    if (
      restoredOccurrence !== undefined
      && restoredOccurrence !== sourceFrame.occurrence
      && restoredOccurrence + 1 !== sourceFrame.occurrence
    ) {
      throw new Error(
        `Workflow resume occurrence mismatch for "${this.#workflow.name}/${input.step.name}"`,
      );
    }
    input.state.stepIterations.set(stepIterationIdentity, sourceFrame.occurrence);
    this.#consumedFrameIndices.add(frameIndex);
    if (sourceFrame.kind === 'workflow_call') {
      this.#claimedWorkflowCallFrames.set(frameIndex, sourceFrame);
    }
    return sourceFrame.occurrence;
  }

  consumeWorkflowCallFrame(input: {
    readonly step: WorkflowStep;
    readonly occurrence: number;
    readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
  }): WorkflowResumePointEntry | undefined {
    const frameIndex = input.resumeStackPrefix.length;
    const frame = this.#claimedWorkflowCallFrames.get(frameIndex);
    if (frame === undefined) {
      return undefined;
    }
    const source = this.#source;
    if (
      source === undefined
      || frame.kind !== 'workflow_call'
      || frame.step !== input.step.name
      || frame.occurrence !== input.occurrence
      || !workflowEntryMatchesWorkflow(frame, this.#workflow)
      || !matchesResumeStackPrefix(
        source.stack,
        input.resumeStackPrefix,
      )
    ) {
      throw new Error(
        `Workflow resume continuation mismatch for "${this.#workflow.name}/${input.step.name}"`,
      );
    }
    const sourceFrame = source.stack[frameIndex];
    if (
      sourceFrame === undefined
      || !workflowEntriesMatch(sourceFrame, frame)
      || sourceFrame.step !== frame.step
      || sourceFrame.kind !== frame.kind
      || sourceFrame.occurrence !== frame.occurrence
    ) {
      throw new Error(
        `Workflow resume continuation source changed for "${this.#workflow.name}/${input.step.name}"`,
      );
    }
    this.#claimedWorkflowCallFrames.delete(frameIndex);
    return frame;
  }
}
