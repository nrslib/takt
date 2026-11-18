import { runStepIdentity } from '../../core/workflow/run/step-executions.js';
import type {
  NdjsonStepComplete,
  NdjsonStepStart,
  NdjsonWorkflowCallComplete,
  NdjsonWorkflowStackEntry,
} from '../../shared/utils/index.js';

type StepStartRecord = Pick<NdjsonStepStart, 'step' | 'iteration' | 'timestamp' | 'workflow' | 'stack'>;
type StepCompleteRecord = Pick<NdjsonStepComplete, 'step' | 'stack'> & { readonly iteration?: number };
type WorkflowCallCompleteRecord = Pick<NdjsonWorkflowCallComplete, 'stack'>;

interface CurrentStepMeta {
  readonly workflow: string;
  readonly currentStep?: string;
  readonly currentIteration?: number;
}

interface CurrentStepFrame {
  readonly workflow: string;
  readonly step: string;
}

/**
 * executionCount 0 means the session log has step starts but none of them is
 * a start of the current position yet; null means there is no step start at all.
 */
interface CurrentLeafStep extends CurrentStepFrame {
  readonly startedAt: string | null;
  readonly executionCount: number | null;
}

/** Ordered from the run's top-level step to the running leaf step. */
export type CurrentStepPath = readonly [...CurrentStepFrame[], CurrentLeafStep];

interface CurrentStepProgress {
  readonly startedAt?: string;
  readonly executionCount?: number;
  readonly path?: CurrentStepPath;
}

interface PositionStart {
  readonly parents: readonly CurrentStepFrame[];
  readonly leaf: CurrentStepFrame;
  readonly startedAt: string;
  readonly executionCount: number;
}

interface TopLevelPositionStart extends PositionStart {
  /** Iterations of this start and of the parallel branches started under it. */
  readonly iterations: Set<number>;
}

interface ParallelBranchStart {
  readonly position: PositionStart;
  readonly iteration: number;
  readonly stack: readonly NdjsonWorkflowStackEntry[];
  /** A step_complete of this start, or a workflow_call_complete of a call around it, has been logged. */
  readonly ended: boolean;
}

function frameOf(entry: NdjsonWorkflowStackEntry): CurrentStepFrame {
  return { workflow: entry.workflow, step: entry.step };
}

function positionKey(frame: CurrentStepFrame): string {
  return JSON.stringify([frame.workflow, frame.step]);
}

/** The branch step when the start runs in a branch of a top-level parallel step. */
function topLevelParallelBranchOf(stack: readonly NdjsonWorkflowStackEntry[]): NdjsonWorkflowStackEntry | undefined {
  const [top, branch] = stack;
  return top?.kind === 'parallel' ? branch : undefined;
}

/**
 * A start inside a branch of a parallel step runs beside that step, which stays the current position.
 * Branches of a top-level parallel step are positions of their own, because the run metadata names
 * such a branch as the current step once its child workflow starts a step.
 */
function isParallelBranch(stack: readonly NdjsonWorkflowStackEntry[]): boolean {
  return stack.slice(1, -1).some((frame) => frame.kind === 'parallel');
}

function sameFrame(left: NdjsonWorkflowStackEntry, right: NdjsonWorkflowStackEntry): boolean {
  return left.workflow === right.workflow && left.workflow_ref === right.workflow_ref && left.step === right.step
    && left.kind === right.kind && left.occurrence === right.occurrence;
}

function startsWithStack(stack: readonly NdjsonWorkflowStackEntry[], prefix: readonly NdjsonWorkflowStackEntry[]): boolean {
  return prefix.length <= stack.length && prefix.every((frame, index) => sameFrame(frame, stack[index]!));
}

/**
 * Resolves the current step position from the records after the latest workflow_start. Step starts must be
 * observed in log order. A completion ends only the start or the call it names, so completions may be observed
 * after the starts.
 */
export class CurrentStepTracker {
  private readonly startCounts = new Map<string, number>();
  private hasStarts = false;
  private readonly latestByTopLevelStep = new Map<string, TopLevelPositionStart>();
  /**
   * The latest start of each branch of the top-level parallel step that runs now. While it runs, the run metadata
   * pairs a branch with the iteration of whichever branch or parent step last reported progress, and names a branch
   * before the session log records the start it reports, so any start of the branch in this run of the parallel step
   * is current. The next top-level start ends that run of the parallel step.
   */
  private readonly latestByParallelBranch = new Map<string, ParallelBranchStart>();

  constructor(private readonly meta: CurrentStepMeta) {}

  observeStart(start: StepStartRecord): void {
    this.hasStarts = true;
    const stack = start.stack ?? [];
    const branch = topLevelParallelBranchOf(stack);
    if (branch === undefined) this.latestByParallelBranch.clear();
    if (isParallelBranch(stack)) {
      if (branch === undefined) this.latestByTopLevelStep.get(positionKey(frameOf(stack[0]!)))?.iterations.add(start.iteration);
      return;
    }
    // Logs written without a workflow stack carry the workflow only for steps outside the run's top level.
    const { identity, workflow } = runStepIdentity(stack, start.workflow ?? this.meta.workflow, start.step);
    const executionCount = (this.startCounts.get(identity) ?? 0) + 1;
    this.startCounts.set(identity, executionCount);
    const position = {
      parents: stack.slice(0, -1).map(frameOf),
      leaf: { workflow, step: start.step },
      startedAt: start.timestamp,
      executionCount,
    };
    if (branch !== undefined) {
      this.latestByParallelBranch.set(positionKey(frameOf(branch)), {
        position, iteration: start.iteration, stack, ended: false,
      });
      return;
    }
    const top = stack[0] === undefined ? position.leaf : frameOf(stack[0]);
    this.latestByTopLevelStep.set(positionKey(top), { ...position, iterations: new Set([start.iteration]) });
  }

  /** The session logger writes a step_complete with the stack and iteration of the start it completes. */
  observeStepComplete(complete: StepCompleteRecord): void {
    const { stack } = complete;
    if (stack === undefined) return;
    this.endParallelBranchStart(stack, (start) => start.position.leaf.step === complete.step && start.iteration === complete.iteration
      && start.stack.length === stack.length && startsWithStack(start.stack, stack));
  }

  /** A workflow call ends every step started inside it, including one that failed without a step_complete. */
  observeWorkflowCallComplete(complete: WorkflowCallCompleteRecord): void {
    this.endParallelBranchStart(complete.stack, (start) => startsWithStack(start.stack, complete.stack));
  }

  result(): CurrentStepProgress {
    const { workflow, currentStep } = this.meta;
    if (currentStep === undefined) return {};
    const key = positionKey({ workflow, step: currentStep });
    const current = this.currentParallelBranchPosition(key) ?? this.currentTopLevelStart(key);
    if (current !== undefined) {
      const { startedAt, executionCount } = current;
      return { startedAt, executionCount, path: [...current.parents, { ...current.leaf, startedAt, executionCount }] };
    }
    const executionCount = this.hasStarts ? 0 : undefined;
    return { executionCount, path: [{ workflow, step: currentStep, startedAt: null, executionCount: executionCount ?? null }] };
  }

  private endParallelBranchStart(
    stack: readonly NdjsonWorkflowStackEntry[],
    endedBy: (start: ParallelBranchStart) => boolean,
  ): void {
    const branch = topLevelParallelBranchOf(stack);
    if (branch === undefined) return;
    const key = positionKey(frameOf(branch));
    const start = this.latestByParallelBranch.get(key);
    if (start !== undefined && endedBy(start)) this.latestByParallelBranch.set(key, { ...start, ended: true });
  }

  /**
   * Once the latest step started in the branch has ended, no running step of the branch is known until its next
   * start, so the top-level parallel step of the same run is the position.
   */
  private currentParallelBranchPosition(key: string): PositionStart | undefined {
    const start = this.latestByParallelBranch.get(key);
    if (start === undefined || !start.ended) return start?.position;
    return this.latestByTopLevelStep.get(positionKey(frameOf(start.stack[0]!)));
  }

  /**
   * Run metadata is updated before the session log, so the latest start may still belong to an earlier run of the step.
   * Child workflows in parallel branches advance the iteration beside their parent.
   */
  private currentTopLevelStart(key: string): PositionStart | undefined {
    const { currentIteration } = this.meta;
    const latest = this.latestByTopLevelStep.get(key);
    return latest !== undefined && currentIteration !== undefined && latest.iterations.has(currentIteration)
      ? latest
      : undefined;
  }
}
