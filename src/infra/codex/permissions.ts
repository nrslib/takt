import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk';
import type { PermissionMode } from '../../core/models/index.js';
import { serializeCodexConfig } from './mcp-isolation.js';
import { mapToCodexSandboxMode, type CodexCallOptions } from './types.js';

type PermissionThreadOptions = Pick<ThreadOptions, 'sandboxMode' | 'networkAccessEnabled' | 'webSearchMode' | 'approvalPolicy'>;

interface CodexPermissions {
  threadOptions: PermissionThreadOptions;
  config: NonNullable<CodexOptions['config']>;
  configOverrides: string[];
  execArgs: readonly string[];
}

type CodexPermissionPolicy =
  | { control: 'codex' }
  | { control: 'auto' }
  | { control: 'takt'; readonlyPermissionBase: string }
  | {
    control: 'takt';
    permissionMode: PermissionMode;
    networkAccess: boolean | undefined;
    sideEffects: 'standard' | 'mcp-only';
    readonlyPermissionBase?: undefined;
  };

function isInternalReadonlyCall(options: CodexCallOptions): boolean {
  return options.executionPhase === 2 || options.internalAgentIsolation === 'strict-readonly';
}

function deriveReadonlyPermissionProfile(baseName: string): string[] {
  // The prefix keeps the generated name distinct from the base profile name and TAKT's existing profile names.
  const profileName = `takt-readonly-base-${baseName}`;
  return serializeCodexConfig({
    default_permissions: profileName,
    permissions: {
      [profileName]: {
        extends: baseName,
        filesystem: {
          ':workspace_roots': { '.': 'read' },
          ':slash_tmp': 'read',
          ':tmpdir': 'read',
        },
        network: { enabled: false },
      },
    },
  });
}

function resolvePermissionPolicy(options: CodexCallOptions): CodexPermissionPolicy {
  if (options.mcpOnlySideEffects) {
    return { control: 'takt', permissionMode: 'readonly', networkAccess: false, sideEffects: 'mcp-only' };
  }
  if (isInternalReadonlyCall(options)) {
    if (options.permissionControl === 'codex' && options.readonlyPermissionBase !== undefined) {
      return { control: 'takt', readonlyPermissionBase: options.readonlyPermissionBase };
    }
    return { control: 'takt', permissionMode: 'readonly', networkAccess: false, sideEffects: 'standard' };
  }
  if (options.aiReviewPermissions) {
    return { control: 'auto' };
  }
  if (options.permissionControl === 'codex') {
    return { control: 'codex' };
  }
  return {
    control: 'takt',
    permissionMode: options.executionPhase === 1 && options.edit === false
      ? 'readonly'
      : options.permissionMode ?? 'edit',
    networkAccess: options.networkAccess,
    sideEffects: 'standard',
  };
}

export function resolveCodexPermissions(options: CodexCallOptions): CodexPermissions {
  const policy = resolvePermissionPolicy(options);
  if (policy.control === 'auto') {
    return {
      threadOptions: { sandboxMode: 'workspace-write', networkAccessEnabled: true, approvalPolicy: 'on-request' },
      config: { approvals_reviewer: 'auto_review' },
      configOverrides: [],
      execArgs: ['--ignore-rules'],
    };
  }
  // Non-interactive calls can approve escalations only through AI review.
  if (policy.control === 'codex') {
    return { threadOptions: { approvalPolicy: 'never' }, config: {}, configOverrides: [], execArgs: [] };
  }
  if (policy.readonlyPermissionBase !== undefined) {
    return {
      threadOptions: { approvalPolicy: 'never' },
      config: {},
      configOverrides: deriveReadonlyPermissionProfile(policy.readonlyPermissionBase),
      execArgs: ['--ignore-rules'],
    };
  }
  const execArgs = ['--ignore-rules'];
  if (policy.permissionMode === 'readonly' && policy.networkAccess === true) {
    // The legacy read-only sandbox ignores sandbox_workspace_write.network_access.
    // A permission profile enables network without granting filesystem writes.
    const profileName = 'takt-readonly-network';
    return {
      threadOptions: { approvalPolicy: 'never' },
      config: {
        default_permissions: profileName,
        permissions: { [profileName]: { extends: ':read-only', network: { enabled: true } } },
      },
      configOverrides: [],
      execArgs,
    };
  }
  const sandboxMode = mapToCodexSandboxMode(policy.permissionMode);
  return {
    threadOptions: {
      sandboxMode,
      approvalPolicy: 'never',
      ...(policy.networkAccess === undefined ? {} : { networkAccessEnabled: policy.networkAccess }),
      ...(policy.sideEffects === 'mcp-only' ? { webSearchMode: 'disabled' } : {}),
    },
    config: policy.sideEffects === 'mcp-only' ? {
      sandbox_mode: sandboxMode,
      sandbox_workspace_write: { network_access: false },
      web_search: 'disabled',
    } : {},
    configOverrides: [],
    execArgs,
  };
}
