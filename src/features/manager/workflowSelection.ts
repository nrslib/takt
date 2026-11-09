import type { ManagerWorkflowsConfig } from '../../core/models/config-types.js';
import { loadWorkflowByIdentifier } from '../../infra/config/loaders/workflowLoader.js';

export interface ManagerWorkflow {
  name: string;
  description?: string;
  usageDescription?: string;
}

const defaultWorkflows = {
  ja: [
    { default: '普通の機能追加や不具合の修正。計画からレビューまで一通り行う' },
    { simple: '1〜2 ファイルで済む小さな修正。軽い流れで進める' },
  ],
  en: [
    { default: 'Regular features and bug fixes, covering planning through review.' },
    { simple: 'Small changes in one or two files, using a lightweight workflow.' },
  ],
} satisfies Record<'ja' | 'en', ManagerWorkflowsConfig>;

export function resolveManagerWorkflowSelection(
  cwd: string,
  config: { workflows?: ManagerWorkflowsConfig; defaultWorkflow?: string },
  language: 'ja' | 'en',
): { workflows?: ManagerWorkflow[]; missingWorkflows: string[] } {
  const configured = config.workflows ?? defaultWorkflows[language];
  if (configured === 'all') return { missingWorkflows: [] };
  const entries = new Map<string, string | undefined>();
  for (const entry of configured) {
    if (typeof entry === 'string') entries.set(entry, undefined);
    else for (const [name, description] of Object.entries(entry)) entries.set(name, description);
  }
  if (config.defaultWorkflow !== undefined && !entries.has(config.defaultWorkflow)) {
    entries.set(config.defaultWorkflow, undefined);
  }
  const workflows: ManagerWorkflow[] = [];
  const missingWorkflows: string[] = [];
  for (const [name, usageDescription] of entries) {
    const workflow = loadWorkflowByIdentifier(name, cwd);
    if (workflow === null) missingWorkflows.push(name);
    else workflows.push({ name, description: workflow.description, ...(usageDescription === undefined ? {} : { usageDescription }) });
  }
  return { workflows, missingWorkflows };
}
