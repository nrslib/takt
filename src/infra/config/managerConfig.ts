import { loadProjectConfig } from './project/projectConfig.js';
import { loadGlobalConfig } from './global/globalConfig.js';
import type { ManagerNotificationKind, ManagerPermission, ManagerWorkflowsConfig } from '../../core/models/config-types.js';
import type { ProviderType } from '../../shared/types/provider.js';

function providerPermission(permissions: Record<string, ManagerPermission> | undefined, provider: ProviderType | undefined): ManagerPermission | undefined {
  if (permissions === undefined || provider === undefined) return undefined;
  const exact = Object.hasOwn(permissions, provider) ? permissions[provider] : undefined;
  if (provider === 'claude' || provider === 'claude-sdk') {
    return exact ?? permissions[provider === 'claude' ? 'claude-sdk' : 'claude'];
  }
  return exact;
}

export function resolveManagerConfig(cwd: string, provider?: ProviderType): {
  permission: ManagerPermission;
  autoRun: boolean; defaultWorkflow?: string; mainMerge: 'auto' | 'approve';
  workflows?: ManagerWorkflowsConfig;
  notifications: Record<ManagerNotificationKind, boolean>;
} {
  const project = loadProjectConfig(cwd).manager;
  const global = loadGlobalConfig().manager;
  return {
    permission: providerPermission(project?.providerPermissions, provider)
      ?? providerPermission(global?.providerPermissions, provider)
      ?? project?.permission ?? global?.permission ?? 'auto',
    autoRun: project?.autoRun ?? global?.autoRun ?? true,
    defaultWorkflow: project?.defaultWorkflow ?? global?.defaultWorkflow,
    workflows: project?.workflows ?? global?.workflows,
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
