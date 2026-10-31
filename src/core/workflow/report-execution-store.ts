import { randomUUID } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { REPORT_EXECUTIONS_DIRECTORY, classifyReportRelativePath } from '../models/reserved-report-names.js';
import { ensurePrivateDirectory, readPrivateFileState, writePrivateFile } from '../../shared/utils/private-file.js';
import { runPrivateFileExclusive } from '../../shared/utils/private-file-lock.js';
import { pinReportContent } from './report-writer.js';
import { buildWorkflowCallNamespaceSegment, parseWorkflowCallNamespaceSegment } from './workflow-call-namespace.js';
import { parseWorkflowExecutionIdentity } from './workflow-execution-identity-codec.js';

const publicName = z.string().refine((value) => classifyReportRelativePath(value).kind === 'public');
const versionPath = z.string().refine((value) => value.startsWith(`${REPORT_EXECUTIONS_DIRECTORY}/versions/`)
  && !value.includes('\\')
  && value.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0));
const executionSchema = z.object({
  id: z.string().uuid(),
  identity: z.string(),
  producer: z.string(),
  namespace: z.string().refine((value) => value === '' || classifyReportRelativePath(value).kind === 'public'),
  sequence: z.number().int().positive(),
  completionOrder: z.number().int().positive().optional(),
  completed: z.boolean(),
  reports: z.record(publicName, versionPath.nullable()),
}).strict();
const storeSchema = z.object({
  lineage: z.string().uuid(),
  executions: z.array(executionSchema),
}).strict();
type ReportExecution = z.infer<typeof executionSchema>;

export interface ReportExecutionMetadata {
  readonly id: string;
  readonly producer: string;
  readonly order: number;
  readonly completionOrder?: number;
}

function nextExecutionOrder(executions: readonly ReportExecution[]): number {
  return executions.reduce((order, entry) => Math.max(order, entry.sequence, entry.completionOrder ?? 0), 0) + 1;
}

function reportOrigin(executions: readonly ReportExecution[], version: string): ReportExecution {
  return executions.filter((entry) => Object.values(entry.reports).includes(version))
    .sort((left, right) => right.namespace.length - left.namespace.length || right.sequence - left.sequence)[0]!;
}

function reportExecutionMetadata(lineage: string, entry: ReportExecution): ReportExecutionMetadata {
  return {
    id: `${lineage}/${entry.id}`, producer: entry.producer, order: entry.sequence,
    ...(entry.completionOrder === undefined ? {} : { completionOrder: entry.completionOrder }),
  };
}

function reportProducerPath(path: string): string {
  const parts = path.split('/');
  return parts.map((segment, index) => {
    if (parts[index - 1] !== 'subworkflows' || index === parts.length - 1) return segment;
    const call = parseWorkflowCallNamespaceSegment(segment);
    return call === undefined ? segment : buildWorkflowCallNamespaceSegment(call.stepName, call.workflowName, 1);
  }).join('/');
}

/** Durable execution identities and immutable bodies; latest participation indexes stay separate. */
export class ReportExecutionStore {
  private readonly active = new Set<string>();
  private readonly directory: string;
  private readonly indexPath: string;

  constructor(private readonly reportsRoot: string) {
    this.directory = resolve(reportsRoot, REPORT_EXECUTIONS_DIRECTORY);
    this.indexPath = resolve(this.directory, 'index.json');
  }

  private read(): z.infer<typeof storeSchema> | undefined {
    const snapshot = readPrivateFileState(this.indexPath);
    return snapshot.state.exists && 'content' in snapshot
      ? storeSchema.parse(JSON.parse(snapshot.content.toString('utf8')))
      : undefined;
  }

  private update<T>(change: (state: z.infer<typeof storeSchema>) => T): T {
    ensurePrivateDirectory(this.directory);
    return runPrivateFileExclusive(resolve(this.directory, 'index.lock'), () => {
      const state = this.read() ?? { lineage: randomUUID(), executions: [] };
      const result = change(state);
      writePrivateFile(this.indexPath, JSON.stringify(state));
      return result;
    });
  }

  begin(identity: string, producer: string, reportDir: string, reportNames: readonly string[], resume = false): string {
    const namespace = relative(resolve(this.reportsRoot), resolve(reportDir)).split(sep).join('/');
    if (namespace.startsWith('..') || resolve(this.reportsRoot, namespace) !== resolve(reportDir)) {
      throw new Error('Report execution directory escapes its run');
    }
    const id = this.update((state) => {
      for (const entry of state.executions) {
        if (entry.identity === identity) this.active.delete(entry.id);
      }
      const interrupted = state.executions.filter((entry) => entry.identity === identity).at(-1);
      if (resume && interrupted !== undefined && !interrupted.completed) return interrupted.id;
      const execution: ReportExecution = {
        id: randomUUID(), identity, producer, namespace,
        sequence: nextExecutionOrder(state.executions),
        completed: false,
        reports: Object.fromEntries(reportNames.map((name) => {
          if (classifyReportRelativePath(name).kind !== 'public') throw new Error(`Invalid report name: ${name}`);
          return [publicName.parse(reportProducerPath(name)), null];
        })),
      };
      state.executions.push(execution);
      return execution.id;
    });
    this.active.add(id);
    return id;
  }

  capture(reportDir: string, reportName: string, content: string): void {
    if (classifyReportRelativePath(reportName).kind !== 'public') throw new Error(`Invalid report name: ${reportName}`);
    this.update((state) => {
      const matching = state.executions.filter((entry) => {
        if (!this.active.has(entry.id)) return false;
        const directory = resolve(this.reportsRoot, entry.namespace);
        const target = resolve(reportDir);
        return target === directory || target.startsWith(`${directory}${sep}`);
      });
      if (matching.length === 0) return;
      const path = relative(this.reportsRoot, pinReportContent(this.reportsRoot, reportName, content)).split(sep).join('/');
      for (const execution of matching) {
        const name = relative(resolve(this.reportsRoot, execution.namespace), resolve(reportDir, reportName)).split(sep).join('/');
        const producerName = publicName.parse(reportProducerPath(name));
        if (parseWorkflowExecutionIdentity(execution.identity)?.parallel_parent !== undefined
          && !Object.hasOwn(execution.reports, producerName)) continue;
        execution.reports[producerName] = path;
      }
    });
  }

  finish(id: string, completed: boolean): void {
    this.update((state) => {
      const execution = state.executions.find((entry) => entry.id === id);
      if (execution === undefined) throw new Error(`Unknown report execution "${id}"`);
      execution.completed = completed;
      if (completed) execution.completionOrder = nextExecutionOrder(state.executions);
      else delete execution.completionOrder;
    });
    this.active.delete(id);
  }

  executions(identity: string): readonly ReportExecution[] {
    return this.read()?.executions.filter((entry) => entry.identity === identity) ?? [];
  }

  current(identity: string, reportName: string): {
    content: string;
    path: string;
    execution: ReportExecutionMetadata;
    origin: ReportExecutionMetadata;
  } | undefined {
    const state = this.read();
    const executions = state?.executions.filter((entry) => entry.identity === identity) ?? [];
    if (executions.length === 0) return undefined;
    const current = executions.filter((entry) => entry.completed).at(-1);
    if (current === undefined) throw new Error(`Report input source "${identity}" has no completed execution`);
    const version = current.reports[reportProducerPath(reportName)];
    if (version == null) throw new Error(`Current report "${reportName}" is missing from execution ${current.id}`);
    const path = resolve(this.reportsRoot, version);
    const snapshot = readPrivateFileState(path);
    if (!snapshot.state.exists || !('content' in snapshot)) throw new Error(`Current report version is missing: ${path}`);
    const origin = reportOrigin(state!.executions, version);
    return {
      content: snapshot.content.toString('utf8'), path,
      execution: reportExecutionMetadata(state!.lineage, current),
      origin: reportExecutionMetadata(state!.lineage, origin),
    };
  }

  history(identity: string, reportName: string, previous: number): string {
    const state = this.read();
    const executions = state?.executions.filter((entry) => entry.identity === identity) ?? [];
    const completed = executions.filter((entry) => entry.completed);
    const prior = previous === 0 ? [] : completed.slice(0, -1).slice(-previous);
    const lines = [`History: ${prior.length} / ${previous} completed previous executions${executions.length === 0 ? '; execution history unavailable' : ''}`];
    for (const entry of prior) {
      const version = entry.reports[reportProducerPath(reportName)];
      const path = version == null ? undefined : resolve(this.reportsRoot, version);
      const snapshot = path === undefined ? undefined : readPrivateFileState(path);
      const available = snapshot?.state.exists === true && 'content' in snapshot;
      const origin = version == null ? undefined : reportExecutionMetadata(state!.lineage, reportOrigin(state!.executions, version));
      lines.push(`- execution=${state!.lineage}/${entry.id} order=${entry.sequence} completion_order=${entry.completionOrder ?? 'unavailable'} status=completed producer=${entry.producer} origin_execution=${origin?.id ?? 'unavailable'} origin_producer=${origin?.producer ?? 'unavailable'} origin_order=${origin?.order ?? 'unavailable'} origin_completion_order=${origin?.completionOrder ?? 'unavailable'} ${available ? `path=\`${path}\`` : 'report=missing'}`);
    }
    const incomplete = executions.filter((entry) => !entry.completed);
    if (incomplete.length > 0) lines.push('Incomplete executions (excluded from completed history):');
    for (const entry of incomplete) {
      lines.push(`- execution=${state!.lineage}/${entry.id} order=${entry.sequence} status=incomplete producer=${entry.producer} (excluded from completed history)`);
    }
    return lines.join('\n');
  }
}
