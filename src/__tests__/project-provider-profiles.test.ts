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
        '    step_permission_overrides:',
        '      implement: full',
      ].join('\n'),
      'utf-8',
    );

    const config = loadProjectConfig(testDir);

    expect(config.providerProfiles?.codex?.defaultPermissionMode).toBe('full');
    expect(config.providerProfiles?.codex?.stepPermissionOverrides?.implement).toBe('full');
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

    expect(config.providerProfiles?.codex?.stepPermissionOverrides?.implement).toBe('full');
  });

  it('rejects the removed provider profile override key in project config', () => {
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

    expect(() => loadProjectConfig(testDir)).toThrow(/movement_permission_overrides/i);
  });

  it('rejects duplicate step_permission_overrides keys in project config', () => {
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
        '    step_permission_overrides:',
        '      fix: edit',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadProjectConfig(testDir)).toThrow(/Map keys must be unique/i);
  });

  it('rejects duplicate step_permission_overrides keys before custom validation', () => {
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
        '    step_permission_overrides:',
        '      implement: edit',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadProjectConfig(testDir)).toThrow(/Map keys must be unique/i);
  });

  it('saves providerProfiles as provider_profiles', () => {
    saveProjectConfig(testDir, {
      providerProfiles: {
        codex: {
          defaultPermissionMode: 'full',
          stepPermissionOverrides: {
            fix: 'full',
          },
        },
      },
    });

    const config = loadProjectConfig(testDir);
    expect(config.providerProfiles?.codex?.defaultPermissionMode).toBe('full');
    expect(config.providerProfiles?.codex?.stepPermissionOverrides?.fix).toBe('full');
  });

  it('saves providerProfiles with canonical step_permission_overrides key', () => {
    saveProjectConfig(testDir, {
      providerProfiles: {
        codex: {
          defaultPermissionMode: 'full',
          stepPermissionOverrides: {
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
