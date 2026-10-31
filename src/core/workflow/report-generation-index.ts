import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { WorkflowResumePoint, WorkflowResumePointEntry } from '../models/types.js';
import { workflowEntriesMatch } from './workflow-reference.js';

/** Reports whose latest generation attempt did not write a current body. */
export class ReportGenerationIndex {
  private readonly missing = new Map<string, {
    namespace: string;
    reportName: string;
    recovery?: WorkflowResumePointEntry[];
  }>();

  constructor(
    initial: WorkflowResumePoint['missing_report_generations'] = {},
    recoveries: WorkflowResumePoint['report_input_recoveries'] = {},
  ) {
    for (const [namespace, names] of Object.entries(initial)) {
      for (const name of names) {
        const path = normalize(join(namespace, name));
        if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
          throw new Error('Report generation path is outside the run reports root');
        }
        this.missing.set(path, {
          namespace, reportName: name,
          ...(Object.hasOwn(recoveries, path) ? { recovery: structuredClone(recoveries[path]!) } : {}),
        });
      }
    }
  }

  private namespace(reportsRootDir: string, reportDir: string): string {
    const path = relative(resolve(reportsRootDir), resolve(reportDir));
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error('Report generation directory is outside the run reports root');
    }
    return path;
  }

  record(
    reportsRootDir: string,
    reportDir: string,
    reportName: string,
    written: boolean,
    recovery?: readonly WorkflowResumePointEntry[],
  ): void {
    const namespace = this.namespace(reportsRootDir, reportDir);
    const path = this.namespace(reportsRootDir, resolve(reportDir, reportName));
    if (written) this.missing.delete(path);
    else this.missing.set(path, {
      namespace, reportName,
      ...(recovery === undefined ? {} : { recovery: structuredClone([...recovery]) }),
    });
  }

  canRecoverInput(
    reportsRootDir: string,
    reportDir: string,
    reportName: string,
    stack: readonly WorkflowResumePointEntry[] | undefined,
  ): boolean {
    const recovery = this.missing.get(this.namespace(reportsRootDir, resolve(reportDir, reportName)))?.recovery;
    return recovery !== undefined && recovery.length > 0
      && stack !== undefined && recovery.length === stack.length
      && recovery.every((entry, index) => {
        const current = stack[index]!;
        return workflowEntriesMatch(entry, current)
          && entry.kind === current.kind && entry.step === current.step
          && entry.occurrence === current.occurrence;
      });
  }

  serializedInputRecoveries(): NonNullable<WorkflowResumePoint['report_input_recoveries']> {
    return Object.fromEntries([...this.missing.entries()].flatMap(([path, entry]) => (
      entry.recovery === undefined ? [] : [[path, structuredClone(entry.recovery)]]
    )));
  }

  isMissing(reportsRootDir: string, reportDir: string, reportName: string): boolean {
    return this.missing.has(this.namespace(reportsRootDir, resolve(reportDir, reportName)));
  }

  missingNames(reportsRootDir: string, reportDir: string): string[] {
    const namespace = this.namespace(reportsRootDir, reportDir);
    const prefix = namespace === '' ? '' : `${namespace}${sep}`;
    return [...this.missing.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length).split(sep).join('/'));
  }

  serialized(): Record<string, string[]> {
    const byNamespace = new Map<string, string[]>();
    for (const { namespace, reportName } of this.missing.values()) {
      const names = byNamespace.get(namespace) ?? [];
      names.push(reportName);
      byNamespace.set(namespace, names);
    }
    return Object.fromEntries(byNamespace);
  }
}
