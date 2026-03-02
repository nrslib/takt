import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { loadProjectConfig, saveProjectConfig } from '../infra/config/project/projectConfig.js';

describe('project provider_profiles', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-project-profile-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('loads provider_profiles from project config', () => {
    const taktDir = join(testDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      join(taktDir, 'config.yaml'),
      [
        'provider_profiles:',
        '  codex:',
        '    default_permission_mode: full',
        '    movement_permission_overrides:',
        '      implement: full',
      ].join('\n'),
      'utf-8',
    );

    const config = loadProjectConfig(testDir);

    expect(config.providerProfiles?.codex?.defaultPermissionMode).toBe('full');
    expect(config.providerProfiles?.codex?.movementPermissionOverrides?.implement).toBe('full');
  });

  it('saves providerProfiles as provider_profiles', () => {
    saveProjectConfig(testDir, {
      providerProfiles: {
        codex: {
          defaultPermissionMode: 'full',
          movementPermissionOverrides: {
            fix: 'full',
          },
        },
      },
    });

    const config = loadProjectConfig(testDir);
    expect(config.providerProfiles?.codex?.defaultPermissionMode).toBe('full');
    expect(config.providerProfiles?.codex?.movementPermissionOverrides?.fix).toBe('full');
  });
});
