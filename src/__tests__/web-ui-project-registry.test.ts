import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readProjectRegistry,
  registerProject,
  resolveRegisteredProject,
} from '../infra/config/global/projectRegistry.js';

describe('Web UI project registry', () => {
  it('stores one atomic registration file per canonical project path', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-project-registry-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-project-'));

    const registered = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'run',
    });
    const snapshot = await readProjectRegistry(globalConfigDirectory);

    expect(snapshot.projects).toEqual([registered]);
    expect(snapshot.projects[0]).toMatchObject({
      displayName: basename(projectDirectory),
      projectDirectory,
      lastCommand: 'run',
      available: true,
    });
    expect(JSON.parse(await readFile(
      join(globalConfigDirectory, 'projects', `${registered.id}.json`),
      'utf8',
    ))).toMatchObject({ id: registered.id, projectDirectory });
  });

  it('rejects an unregistered id and ignores symlinked registry entries', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-project-registry-'));
    const registryDirectory = join(globalConfigDirectory, 'projects');
    await mkdir(registryDirectory, { recursive: true });
    const target = join(globalConfigDirectory, 'target.json');
    await writeFile(target, '{}');
    await symlink(target, join(registryDirectory, `${'a'.repeat(64)}.json`));

    const snapshot = await readProjectRegistry(globalConfigDirectory);

    expect(snapshot.projects).toEqual([]);
    expect(snapshot.warnings).toHaveLength(1);
    await expect(resolveRegisteredProject(globalConfigDirectory, 'b'.repeat(64)))
      .rejects.toThrow('Project is not registered');
  });

  it('keeps a state unavailable when the canonical directory fingerprint changes', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-project-registry-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-project-'));
    const registered = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui',
    });
    const path = join(globalConfigDirectory, 'projects', `${registered.locationId}.json`);
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    stored.fingerprint = { dev: registered.fingerprint.dev, ino: registered.fingerprint.ino + 1 };
    await writeFile(path, JSON.stringify(stored));

    await expect((await readProjectRegistry(globalConfigDirectory)).projects[0]).toMatchObject({
      stateId: registered.stateId,
      available: false,
    });
  });

  it('repairs an unsupported same-location record only during explicit registration', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-project-registry-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-project-'));
    const registered = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui',
    });
    const target = join(globalConfigDirectory, 'projects', `${registered.locationId}.json`);

    await writeFile(target, JSON.stringify({
      version: 1,
      locationId: registered.locationId,
      canonicalDirectory: registered.canonicalDirectory,
    }));
    expect((await readProjectRegistry(globalConfigDirectory)).warnings).toHaveLength(1);

    const repaired = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui-recovery',
    });

    expect(repaired.version).toBe(2);
    expect(repaired.locationId).toBe(registered.locationId);
    expect(repaired.stateId).not.toBe(registered.stateId);
    expect(repaired.canonicalDirectory).toBe(registered.canonicalDirectory);
    expect(repaired.lastCommand).toBe('ui-recovery');
    expect((await readProjectRegistry(globalConfigDirectory)).warnings).toEqual([]);
  });

  it('retains the state id when explicitly registering a valid existing location', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-project-registry-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-project-'));
    const registered = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui',
    });

    const reRegistered = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui-again',
    });

    expect(reRegistered.stateId).toBe(registered.stateId);
    expect(reRegistered.lastCommand).toBe('ui-again');
  });

  it('repairs corrupt bytes for the requested location but preserves another location record', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-project-registry-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-project-'));
    const registered = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui',
    });
    const target = join(globalConfigDirectory, 'projects', `${registered.locationId}.json`);

    await writeFile(target, '{corrupt');
    await expect(registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui-recovery',
    })).resolves.toMatchObject({ version: 2, locationId: registered.locationId });

    const otherLocationId = 'b'.repeat(64);
    const otherRecord = {
      version: 2,
      locationId: otherLocationId,
      canonicalDirectory: '/another-project',
      stateId: registered.stateId,
    };
    await writeFile(target, JSON.stringify(otherRecord));
    await expect(registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui-recovery',
    })).rejects.toThrow('registration identity does not match its path');
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(otherRecord);
  });

  it('does not repair an unsupported record whose canonical identity disagrees', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-project-registry-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-project-'));
    const registered = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui',
    });
    const target = join(globalConfigDirectory, 'projects', `${registered.locationId}.json`);
    const conflictingRecord = {
      version: 1,
      locationId: registered.locationId,
      canonicalDirectory: '/different-project',
    };
    await writeFile(target, JSON.stringify(conflictingRecord));

    await expect(registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui-recovery',
    })).rejects.toThrow('registration version is unsupported');
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(conflictingRecord);
  });

  it('does not repair an unsupported record with conflicting id aliases', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-project-registry-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-project-'));
    const registered = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui',
    });
    const target = join(globalConfigDirectory, 'projects', `${registered.locationId}.json`);
    const conflictingRecord = {
      version: 1,
      locationId: registered.locationId,
      id: 'c'.repeat(64),
      canonicalDirectory: registered.canonicalDirectory,
    };
    await writeFile(target, JSON.stringify(conflictingRecord));

    await expect(registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui-recovery',
    })).rejects.toThrow('registration version is unsupported');
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(conflictingRecord);
  });

  it('does not repair a current-version record with a malformed fingerprint', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-project-registry-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-project-'));
    const registered = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui',
    });
    const target = join(globalConfigDirectory, 'projects', `${registered.locationId}.json`);
    const currentRecord = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
    currentRecord.fingerprint = { dev: registered.fingerprint.dev };
    await writeFile(target, JSON.stringify(currentRecord));

    await expect(registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui-recovery',
    })).rejects.toThrow('fingerprint is invalid');
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(currentRecord);
  });

  it('does not replace a registration path that is not a regular file', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-project-registry-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-project-'));
    const registered = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui',
    });
    const target = join(globalConfigDirectory, 'projects', `${registered.locationId}.json`);
    await unlink(target);
    await mkdir(target);

    await expect(registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'ui-recovery',
    })).rejects.toThrow('Project registration must be a regular file');
  });
});
