import { describe, expect, it } from 'vitest';

import { resolveMovementPermissionMode } from '../core/piece/permission-profile-resolution.js';

describe('resolveMovementPermissionMode', () => {
  it('applies required_permission_mode as minimum floor', () => {
    const mode = resolveMovementPermissionMode({
      movementName: 'implement',
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
    const mode = resolveMovementPermissionMode({
      movementName: 'supervise',
      provider: 'codex',
      projectProviderProfiles: {
        codex: {
          defaultPermissionMode: 'edit',
          movementPermissionOverrides: {
            supervise: 'full',
          },
        },
      },
      globalProviderProfiles: {
        codex: {
          defaultPermissionMode: 'readonly',
          movementPermissionOverrides: {
            supervise: 'edit',
          },
        },
      },
    });

    expect(mode).toBe('full');
  });

  it('falls back to readonly when unresolved', () => {
    const mode = resolveMovementPermissionMode({
      movementName: 'fix',
      provider: 'codex',
    });

    expect(mode).toBe('readonly');
  });

  it('resolves from required_permission_mode when provider is omitted', () => {
    const mode = resolveMovementPermissionMode({
      movementName: 'fix',
      requiredPermissionMode: 'edit',
    });

    expect(mode).toBe('edit');
  });

  it('uses claude-sdk profile entry when movement runs on SDK provider', () => {
    const mode = resolveMovementPermissionMode({
      movementName: 'implement',
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
    const sdkMode = resolveMovementPermissionMode({
      movementName: 'm1',
      provider: 'claude-sdk',
      projectProviderProfiles: {
        'claude-sdk': { defaultPermissionMode: 'full' },
        claude: { defaultPermissionMode: 'readonly' },
      },
    });
    const headlessMode = resolveMovementPermissionMode({
      movementName: 'm1',
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
    const mode = resolveMovementPermissionMode({
      movementName: 'review',
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
