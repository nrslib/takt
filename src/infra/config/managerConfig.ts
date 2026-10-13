import { loadProjectConfig } from './project/projectConfig.js';
import { loadGlobalConfig } from './global/globalConfig.js';
import type { ManagerNotificationKind } from '../../core/models/config-types.js';

export function resolveManagerConfig(cwd: string): {
  autoRun: boolean; defaultWorkflow?: string; mainMerge: 'auto' | 'approve';
  notifications: Record<ManagerNotificationKind, boolean>;
} {
  const project = loadProjectConfig(cwd).manager;
  const global = loadGlobalConfig().manager;
  return {
    autoRun: project?.autoRun ?? global?.autoRun ?? true,
    defaultWorkflow: project?.defaultWorkflow ?? global?.defaultWorkflow,
    mainMerge: project?.mainMerge ?? 'approve',
    notifications: {
      question: project?.notifications?.question ?? global?.notifications?.question ?? true,
      awaiting_merge: project?.notifications?.awaiting_merge ?? global?.notifications?.awaiting_merge ?? true,
      completed: project?.notifications?.completed ?? global?.notifications?.completed ?? true,
      progress: project?.notifications?.progress ?? global?.notifications?.progress ?? true,
      blocked: project?.notifications?.blocked ?? global?.notifications?.blocked ?? true,
      custom: project?.notifications?.custom ?? global?.notifications?.custom ?? true,
    },
  };
}
