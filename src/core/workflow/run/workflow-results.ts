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
const occurrenceSchema = z.object({ step: z.string(), occurrence: z.number().int().positive() });
const resultsSchema = z.object({
  version: z.literal(2),
  workflow: z.string(),
  workflow_ref: z.string(),
  latest: snapshotSchema.nullable(),
  failed_occurrences: z.array(occurrenceSchema).optional(),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type ResultSelection = { step: string; occurrence?: number };

interface ChildResultResume {
  source: WorkflowResumePoint | undefined;
  target: WorkflowRestartPoint | WorkflowResumePoint | undefined;
}

export class WorkflowResultsStore {
  private readonly failedOccurrences = new Map<string, { step: string; occurrence: number }>();

  constructor(
    private readonly contextDirectory: string,
    private readonly config: WorkflowConfig,
    private readonly state: WorkflowState,
  ) {}

  initialize(sourceContext: string, restore: boolean, inherit: boolean, occurrence?: number, children?: ChildResultResume): void {
    const path = join(sourceContext, RESULTS_FILE);
    if (restore || inherit) {
      const saved = this.load(path);
      let selected = saved;
      if (restore) {
        try {
          const selectedPath = selectResultsPath(sourceContext, { step: this.state.currentStep, occurrence }, saved?.failed_occurrences);
          selected = selectedPath === undefined ? undefined : selectedPath === path ? saved : this.load(selectedPath);
        } catch (error) {
          warn(`Failed to select workflow results at ${path}: ${getErrorMessage(error)}`);
          selected = undefined;
        }
      }
      const identity = saved ?? selected;
      if (identity !== undefined) {
        if (resumeWorkflowMatches(identity, this.config)) {
          if (selected !== undefined && selected !== identity && !resumeWorkflowMatches(selected, this.config)) {
            throw new Error(`Cannot resume workflow "${this.config.name}": saved results belong to "${selected.workflow}"`);
          }
          if (inherit) {
            const selections = selectChildResults(children);
            if (selections !== undefined) inheritChildWorkflowResults(sourceContext, this.contextDirectory, selections);
          }
          if (restore) {
            const snapshot = selected?.latest;
            if (snapshot !== undefined && snapshot !== null) {
              for (const [scope, value] of Object.entries(snapshot.context)) this.state.systemContexts.set(scope, value);
              for (const [scope, value] of Object.entries(snapshot.effect)) this.state.effectResults.set(scope, value);
              for (const [scope, value] of Object.entries(snapshot.structured)) this.state.structuredOutputs.set(scope, value);
            } else this.warnUnavailable(path);
          }
        } else if (restore) {
          throw new Error(`Cannot resume workflow "${this.config.name}": saved results belong to "${identity.workflow}"`);
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
      // A failed directory creation must remain distinguishable from an unstarted occurrence.
      if (start !== undefined) this.failedOccurrences.set(JSON.stringify(start), start);
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
      ...(path === join(this.contextDirectory, RESULTS_FILE) && this.failedOccurrences.size > 0
        ? { failed_occurrences: [...this.failedOccurrences.values()] } : {}),
    });
    if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
    writeFileAtomic(path, content, 0o600);
  }
}

function stepDirectory(context: string, step: string): string {
  return join(context, OCCURRENCES_DIRECTORY, `step-${encodeURIComponent(step)}`);
}

function selectResultsPath(
  sourceContext: string,
  selection: ResultSelection,
  failures: readonly { step: string; occurrence: number }[] | undefined,
): string | undefined {
  const directory = stepDirectory(sourceContext, selection.step);
  const failed = failures?.filter((entry) => entry.step === selection.step) ?? [];
  let occurrence = selection.occurrence;
  if (occurrence === undefined) {
    occurrence = 0;
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory)) occurrence = Math.max(occurrence, Number(entry));
    }
    for (const entry of failed) occurrence = Math.max(occurrence, entry.occurrence);
  }
  const selected = join(directory, String(occurrence));
  // Failed saves never fall back to results from a different point in time.
  if (failed.some((entry) => entry.occurrence === occurrence)) return undefined;
  return join(existsSync(selected) ? selected : sourceContext, RESULTS_FILE);
}

function selectChildResults(resume: ChildResultResume | undefined): ReadonlyMap<string, ResultSelection> | undefined {
  const selections = new Map<string, ResultSelection>();
  if (resume?.source === undefined || resume.target === undefined) return selections;
  const source = resume.source;
  const records = [];
  for (const [id, record] of Object.entries(source.workflow_call_invocations)) {
    const identity = parseWorkflowCallInvocationIdentity(id);
    if (identity === undefined) {
      warn('Cannot inherit child workflow results: invalid workflow call invocation ID');
      return undefined;
    }
    records.push({ identity, record });
  }
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
    const rootPath = join(sourceContext, RESULTS_FILE);
    const root = existsSync(rootPath) ? resultsSchema.parse(JSON.parse(readFileSync(rootPath, 'utf8'))) : undefined;
    const sourcePath = selection === undefined ? rootPath : selectResultsPath(sourceContext, selection, root?.failed_occurrences);
    if (sourcePath === undefined) throw new Error(`Selected child workflow results were not saved at ${sourceContext}`);
    mkdirSync(targetContext, { recursive: true });
    if (existsSync(sourcePath)) {
      const selected = resultsSchema.parse(JSON.parse(readFileSync(sourcePath, 'utf8')));
      delete selected.failed_occurrences;
      writeFileAtomic(join(targetContext, RESULTS_FILE), JSON.stringify(selected), 0o600);
    }
    inheritChildWorkflowResults(sourceContext, targetContext, selections, namespace);
  } catch (error) {
    warn(`Failed to inherit workflow results; future resumes may lack results: ${getErrorMessage(error)}`);
  }
}
