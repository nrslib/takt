import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { WorkflowResumePoint } from '../models/types.js';

/** Reports whose latest generation attempt did not write a current body. */
export class ReportGenerationIndex {
  private readonly missing = new Map<string, { namespace: string; reportName: string }>();

  constructor(initial: WorkflowResumePoint['missing_report_generations'] = {}) {
    for (const [namespace, names] of Object.entries(initial)) {
      for (const name of names) {
        const path = normalize(join(namespace, name));
        if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
          throw new Error('Report generation path is outside the run reports root');
        }
        this.missing.set(path, { namespace, reportName: name });
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

  record(reportsRootDir: string, reportDir: string, reportName: string, written: boolean): void {
    const namespace = this.namespace(reportsRootDir, reportDir);
    const path = this.namespace(reportsRootDir, resolve(reportDir, reportName));
    if (written) this.missing.delete(path);
    else this.missing.set(path, { namespace, reportName });
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
