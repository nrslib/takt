import { describe, expect, it } from 'vitest';

import { resolveStepPermissionMode } from '../core/workflow/permission-profile-resolution.js';

describe('resolveStepPermissionMode', () => {
  it('applies required_permission_mode as minimum floor', () => {
    const mode = resolveStepPermissionMode({
      stepName: 'implement',
      requiredPermissionMode: 'full',
      provider: 'codex',
      projectProviderProfiles: {
        codex: {
          defaultPermissionMode: 'readonly',
        },
      },
    });

    expect(mode).toBe('full');
  });

  it('resolves by priority: project override > global override > project default > global default', () => {
    const mode = resolveStepPermissionMode({
      stepName: 'supervise',
      provider: 'codex',
      projectProviderProfiles: {
        codex: {
          defaultPermissionMode: 'edit',
          stepPermissionOverrides: {
            supervise: 'full',
          },
        },
      },
      globalProviderProfiles: {
        codex: {
          defaultPermissionMode: 'readonly',
          stepPermissionOverrides: {
            supervise: 'edit',
          },
        },
      },
    });

    expect(mode).toBe('full');
  });

  it('falls back to readonly when unresolved', () => {
    const mode = resolveStepPermissionMode({
      stepName: 'fix',
      provider: 'codex',
    });

    expect(mode).toBe('readonly');
  });

  it('resolves from required_permission_mode when provider is omitted', () => {
    const mode = resolveStepPermissionMode({
      stepName: 'fix',
      requiredPermissionMode: 'edit',
    });

    expect(mode).toBe('edit');
  });

  it('uses claude-sdk profile entry when step runs on SDK provider', () => {
    const mode = resolveStepPermissionMode({
      stepName: 'implement',
      provider: 'claude-sdk',
      projectProviderProfiles: {
        'claude-sdk': {
          defaultPermissionMode: 'full',
        },
      },
    });

    expect(mode).toBe('full');
  });

  it('uses headless claude profile entry separately from claude-sdk', () => {
    const sdkMode = resolveStepPermissionMode({
      stepName: 'm1',
      provider: 'claude-sdk',
      projectProviderProfiles: {
        'claude-sdk': { defaultPermissionMode: 'full' },
        claude: { defaultPermissionMode: 'readonly' },
      },
    });
    const headlessMode = resolveStepPermissionMode({
      stepName: 'm1',
      provider: 'claude',
      projectProviderProfiles: {
        'claude-sdk': { defaultPermissionMode: 'full' },
        claude: { defaultPermissionMode: 'readonly' },
      },
    });

    expect(sdkMode).toBe('full');
    expect(headlessMode).toBe('readonly');
  });

  it('applies required_permission_mode floor after resolving the headless claude profile', () => {
    const mode = resolveStepPermissionMode({
      stepName: 'review',
      provider: 'claude',
      requiredPermissionMode: 'full',
      projectProviderProfiles: {
        claude: {
          defaultPermissionMode: 'readonly',
        },
      },
    });

    expect(mode).toBe('full');
  });
});
