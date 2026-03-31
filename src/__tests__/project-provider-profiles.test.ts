import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

  it('loads step_permission_overrides from project config', () => {
    const taktDir = join(testDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      join(taktDir, 'config.yaml'),
      [
        'provider_profiles:',
        '  codex:',
        '    default_permission_mode: full',
        '    step_permission_overrides:',
        '      implement: full',
      ].join('\n'),
      'utf-8',
    );

    const config = loadProjectConfig(testDir);

    expect(config.providerProfiles?.codex?.movementPermissionOverrides?.implement).toBe('full');
  });

  it('prefers step_permission_overrides when both project config keys match', () => {
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
        '    step_permission_overrides:',
        '      implement: full',
      ].join('\n'),
      'utf-8',
    );

    const config = loadProjectConfig(testDir);

    expect(config.providerProfiles?.codex?.movementPermissionOverrides).toEqual({
      implement: 'full',
    });
  });

  it('accepts matching project config permission override aliases regardless of key order', () => {
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
        '      fix: edit',
        '    step_permission_overrides:',
        '      fix: edit',
        '      implement: full',
      ].join('\n'),
      'utf-8',
    );

    const config = loadProjectConfig(testDir);

    expect(config.providerProfiles?.codex?.movementPermissionOverrides).toEqual({
      implement: 'full',
      fix: 'edit',
    });
  });

  it('fails fast when project config permission override aliases differ', () => {
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
        '    step_permission_overrides:',
        '      implement: edit',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadProjectConfig(testDir)).toThrow(
      'Configuration error: provider_profiles.codex step_permission_overrides must match movement_permission_overrides when both are set.',
    );
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

  it('saves providerProfiles with canonical step_permission_overrides key', () => {
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

    const raw = readFileSync(join(testDir, '.takt', 'config.yaml'), 'utf-8');

    expect(raw).toContain('step_permission_overrides:');
    expect(raw).not.toContain('movement_permission_overrides:');
  });
});
