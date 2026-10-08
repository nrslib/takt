import { loadProjectConfig } from './project/projectConfig.js';
import { loadGlobalConfig } from './global/globalConfig.js';

export function resolveManagerConfig(cwd: string): { autoRun: boolean; defaultWorkflow?: string; mainMerge: 'auto' | 'approve' } {
  const project = loadProjectConfig(cwd).manager;
  const global = loadGlobalConfig().manager;
  return {
    autoRun: project?.autoRun ?? global?.autoRun ?? true,
    defaultWorkflow: project?.defaultWorkflow ?? global?.defaultWorkflow,
    mainMerge: project?.mainMerge ?? 'approve',
  };
}
