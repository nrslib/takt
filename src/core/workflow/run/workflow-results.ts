import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v4';
import type { WorkflowConfig, WorkflowRestartPoint, WorkflowResumePoint, WorkflowState } from '../../models/types.js';
import { writeFileAtomic } from '../../../shared/utils/atomic-file.js';
import { warn } from '../../../shared/ui/LogManager.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import { getWorkflowReference } from '../workflow-reference.js';
import { resumeWorkflowMatches } from './resume-point.js';
import { parseWorkflowCallInvocationIdentity, type WorkflowExecutionCallIdentity } from '../workflow-execution-identity-codec.js';
import { parseWorkflowCallNamespaceSegment } from '../workflow-call-namespace.js';

const RESULTS_FILE = 'workflow-results.json';
const OCCURRENCES_DIRECTORY = 'workflow-results';
const scopes = z.record(z.string(), z.record(z.string(), z.unknown()));
const snapshotSchema = z.object({ context: scopes, effect: scopes, structured: scopes }).strict();
const resultsSchema = z.object({
  version: z.literal(2),
  workflow: z.string(),
  workflow_ref: z.string(),
  latest: snapshotSchema.nullable(),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type ResultSelection = { step: string; occurrence?: number };

interface ChildResultResume {
  source: WorkflowResumePoint | undefined;
  target: WorkflowRestartPoint | WorkflowResumePoint | undefined;
}

export class WorkflowResultsStore {
  constructor(
    private readonly contextDirectory: string,
    private readonly config: WorkflowConfig,
    private readonly state: WorkflowState,
  ) {}

  initialize(sourceContext: string, restore: boolean, inherit: boolean, occurrence?: number, children?: ChildResultResume): void {
    const path = join(sourceContext, RESULTS_FILE);
    if (restore || inherit) {
      const saved = this.load(path);
      if (saved !== undefined) {
        if (resumeWorkflowMatches(saved, this.config)) {
          if (inherit) {
            inheritChildWorkflowResults(sourceContext, this.contextDirectory, selectChildResults(children));
          }
          if (restore) {
            const directory = selectOccurrenceDirectory(sourceContext, { step: this.state.currentStep, occurrence });
            // An existing directory with no readable snapshot is a failed save, not an unstarted occurrence.
            const selected = directory === undefined ? saved : this.load(join(directory, RESULTS_FILE));
            const snapshot = selected?.latest;
            if (snapshot !== undefined && snapshot !== null) {
              for (const [scope, value] of Object.entries(snapshot.context)) this.state.systemContexts.set(scope, value);
              for (const [scope, value] of Object.entries(snapshot.effect)) this.state.effectResults.set(scope, value);
              for (const [scope, value] of Object.entries(snapshot.structured)) this.state.structuredOutputs.set(scope, value);
            } else this.warnUnavailable(path);
          }
        } else if (restore) {
          throw new Error(`Cannot resume workflow "${this.config.name}": saved results belong to "${saved.workflow}"`);
        }
      } else if (restore) this.warnUnavailable(path);
    }
    this.save();
  }

  private load(path: string): z.infer<typeof resultsSchema> | undefined {
    if (!existsSync(path)) return undefined;
    try {
      const parsed = resultsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      warn(`Failed to read workflow results at ${path}: ${getErrorMessage(error)}`);
      return undefined;
    }
  }

  private warnUnavailable(path: string): void {
    warn(`Saved workflow results are unavailable for "${this.config.name}" at "${this.state.currentStep}" (${path}); resuming with empty results.`);
  }

  startStep(step: string, occurrence: number): void {
    this.persist({ step, occurrence });
  }

  save(): void {
    this.persist();
  }

  private persist(start?: { step: string; occurrence: number }): void {
    const paths = [join(this.contextDirectory, RESULTS_FILE)];
    const occurrenceDirectory = start === undefined ? undefined
      : join(stepDirectory(this.contextDirectory, start.step), String(start.occurrence));
    if (occurrenceDirectory !== undefined) paths.push(join(occurrenceDirectory, RESULTS_FILE));
    // Results only support future resumes; persistence must not change the running step's outcome.
    try {
      if (occurrenceDirectory !== undefined) mkdirSync(occurrenceDirectory, { recursive: true });
      const latest = JSON.parse(JSON.stringify({
        context: Object.fromEntries(this.state.systemContexts),
        effect: Object.fromEntries(this.state.effectResults),
        structured: Object.fromEntries(this.state.structuredOutputs),
      })) as Snapshot;
      for (const path of paths) this.write(path, latest);
    } catch (error) {
      // Publish an invalid snapshot, or remove the old artifact if writing itself failed.
      for (const path of paths) {
        try {
          this.write(path, null);
        } catch {
          try {
            rmSync(path, { force: true });
          } catch (invalidationError) {
            warn(`Failed to invalidate workflow results at ${path}: ${getErrorMessage(invalidationError)}`);
          }
        }
      }
      warn(`Failed to save workflow results for "${this.config.name}"; future resumes may lack results: ${getErrorMessage(error)}`);
    }
  }

  private write(path: string, latest: Snapshot | null): void {
    const content = JSON.stringify({
      version: 2,
      workflow: this.config.name,
      workflow_ref: getWorkflowReference(this.config),
      latest,
    });
    if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
    writeFileAtomic(path, content, 0o600);
  }
}

function stepDirectory(context: string, step: string): string {
  return join(context, OCCURRENCES_DIRECTORY, `step-${encodeURIComponent(step)}`);
}

function selectOccurrenceDirectory(sourceContext: string, selection: ResultSelection): string | undefined {
  const directory = stepDirectory(sourceContext, selection.step);
  if (!existsSync(directory)) return undefined;
  const occurrence = selection.occurrence ?? Math.max(...readdirSync(directory).map(Number));
  const selected = join(directory, String(occurrence));
  return existsSync(selected) ? selected : undefined;
}

function selectChildResults(resume: ChildResultResume | undefined): ReadonlyMap<string, ResultSelection> {
  const selections = new Map<string, ResultSelection>();
  if (resume?.source === undefined || resume.target === undefined) return selections;
  const source = resume.source;
  const records = Object.entries(source.workflow_call_invocations).map(([identity, record]) => ({
    identity: parseWorkflowCallInvocationIdentity(identity)!, record,
  }));
  let calls: readonly WorkflowExecutionCallIdentity[] = [];
  let namespace = '';
  for (const [depth, frame] of resume.target.stack.entries()) {
    const invocation = records.find(({ identity }) => identity.step === frame.step
      && (identity.calls[0]?.workflow ?? identity.workflow) === source.stack[0]!.workflow_ref
      && JSON.stringify(identity.calls) === JSON.stringify(calls));
    if (depth > 0 && resume.target.stack[depth - 1]!.kind === 'workflow_call') selections.set(namespace, {
      step: frame.step,
      occurrence: 'occurrence' in frame ? frame.occurrence : frame.kind === 'workflow_call' ? invocation?.record.call_instance : undefined,
    });
    // Parallel ancestors identify a call site without opening a new results namespace.
    if (frame.kind === 'parallel' && 'occurrence' in frame) {
      calls = [...calls, {
        workflow: frame.workflow_ref, step: frame.step, kind: frame.kind, instance: frame.occurrence,
      }];
      continue;
    }
    const next = resume.target.stack[depth + 1];
    if (invocation === undefined || next === undefined
      || parseWorkflowCallNamespaceSegment(invocation.record.report_namespace_segment)?.workflowName !== next.workflow) break;
    namespace = join(namespace, 'subworkflows', invocation.record.report_namespace_segment);
    calls = [...calls, {
      workflow: invocation.identity.workflow, step: frame.step, kind: frame.kind, instance: invocation.record.call_instance,
    }];
  }
  return selections;
}

function inheritChildWorkflowResults(source: string, target: string, selections: ReadonlyMap<string, ResultSelection>, namespace = ''): void {
  try {
    const children = join(source, 'subworkflows');
    if (!existsSync(children)) return;
    for (const entry of readdirSync(children, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childNamespace = join(namespace, 'subworkflows', entry.name);
      copyWorkflowResults(join(children, entry.name), join(target, 'subworkflows', entry.name), selections, childNamespace);
    }
  } catch (error) {
    warn(`Failed to inherit workflow results; future resumes may lack results: ${getErrorMessage(error)}`);
  }
}

export function inheritWorkflowResults(sourceContext: string, targetContext: string): void {
  copyWorkflowResults(sourceContext, targetContext, new Map(), '');
}

function copyWorkflowResults(sourceContext: string, targetContext: string, selections: ReadonlyMap<string, ResultSelection>, namespace: string): void {
  if (sourceContext === targetContext) return;
  try {
    const selection = selections.get(namespace);
    const directory = selection === undefined ? undefined : selectOccurrenceDirectory(sourceContext, selection);
    const sourcePath = join(directory ?? sourceContext, RESULTS_FILE);
    mkdirSync(targetContext, { recursive: true });
    if (existsSync(sourcePath)) {
      writeFileAtomic(join(targetContext, RESULTS_FILE), readFileSync(sourcePath, 'utf8'), 0o600);
    }
    inheritChildWorkflowResults(sourceContext, targetContext, selections, namespace);
  } catch (error) {
    warn(`Failed to inherit workflow results; future resumes may lack results: ${getErrorMessage(error)}`);
  }
}
