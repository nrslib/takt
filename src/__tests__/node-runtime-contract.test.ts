import { backup, constants, DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const temporaryDirectories: string[] = [];

function readRepositoryFile(path: string): string {
  return readFileSync(join(repositoryRoot, path), 'utf-8');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Node runtime contract', () => {
  it('pins Node 24 in CI, Docker, and Nix', () => {
    const workflows = readdirSync(join(repositoryRoot, '.github/workflows'))
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => readRepositoryFile(join('.github/workflows', name)));
    const configuredNodeVersions = workflows.flatMap((workflow) => (
      [...workflow.matchAll(/node-version:\s*['"]?([^'"\s]+)/g)].map((match) => match[1])
    ));

    expect(configuredNodeVersions.length).toBeGreaterThan(0);
    expect(new Set(configuredNodeVersions)).toEqual(new Set(['24']));
    expect(readRepositoryFile('Dockerfile')).toContain('FROM node:24-alpine');
    expect(readRepositoryFile('flake.nix')).toContain('nodejs = pkgs.nodejs_24');
    expect(readRepositoryFile('README.md')).toContain('Node.js `>=24.15.0`');
    expect(readRepositoryFile('docs/README.ja.md')).toContain('Node.js `>=24.15.0`');
    expect(readRepositoryFile('AGENTS.md')).toContain('Node `>=24.15.0`');
    expect(readRepositoryFile('scripts/canary-coder.mjs')).not.toMatch(
      /engines下限の Node 20/,
    );
  });

  it('supports DatabaseSync timeout, authorizer, and backup from node:sqlite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-node-sqlite-contract-'));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'source.sqlite');
    const backupPath = join(directory, 'backup.sqlite');
    const source = new DatabaseSync(sourcePath, { timeout: 5 });
    source.enableDefensive(true);
    source.exec('CREATE TABLE canary (value TEXT NOT NULL) STRICT');
    source.prepare('INSERT INTO canary (value) VALUES (?)').run('available');
    source.setAuthorizer((action) => (
      action === constants.SQLITE_SELECT || action === constants.SQLITE_READ
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY
    ));
    expect(source.prepare('SELECT value FROM canary').get()).toEqual({ value: 'available' });
    expect(() => source.prepare("UPDATE canary SET value = 'blocked'").run()).toThrow(
      /not authorized/i,
    );
    source.setAuthorizer(null);

    await backup(source, backupPath);
    source.close();

    const copy = new DatabaseSync(backupPath, { timeout: 5 });
    expect(copy.prepare('SELECT value FROM canary').get()).toEqual({ value: 'available' });
    copy.close();
  });
});
