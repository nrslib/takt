import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCompanionDefinition } from '../infra/config/loaders/companionDefinitionLoader.js';
import { buildCompanionLookupDirs } from '../infra/config/loaders/companionLookupDirectories.js';
import { getBuiltinCompanionsDir } from '../infra/config/paths.js';
import { MAX_COMPANION_INTERVAL_MS } from '../core/models/companion-types.js';

function writeDefinition(root: string, description: string, extra = ''): string {
  const path = join(root, 'security-reviewer.yaml');
  mkdirSync(root, { recursive: true });
  writeFileSync(path, [
    'name: security-reviewer',
    `description: ${description}`,
    'persona: security-reviewer',
    'policy: [review]',
    'knowledge: [security]',
    'interval_ms: 15000',
    extra,
    '',
  ].join('\n'), 'utf-8');
  return path;
}

describe('CT-COMP-02 companion definition loading', () => {
  let root: string;
  let projectDir: string;
  let userDir: string;
  let builtinDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-companion-loader-'));
    projectDir = join(root, 'project');
    userDir = join(root, 'user');
    builtinDir = join(root, 'builtins', 'en');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should order lookup directories as project, user, then builtin without repertoire', () => {
    const dirs = buildCompanionLookupDirs({ projectDir, userDir, builtinDir });

    expect(dirs).toEqual([
      join(projectDir, '.takt', 'companions'),
      join(userDir, 'companions'),
      join(builtinDir, 'companions'),
    ]);
    expect(dirs.every((path) => !path.includes('repertoire'))).toBe(true);
  });

  it('should use the first matching project definition without merging lower layers', () => {
    const projectPath = writeDefinition(join(projectDir, '.takt', 'companions'), 'project-reviewer');
    writeDefinition(join(userDir, 'companions'), 'user-reviewer');
    writeDefinition(join(builtinDir, 'companions'), 'builtin-reviewer');

    const definition = loadCompanionDefinition('security-reviewer', {
      candidateDirs: buildCompanionLookupDirs({ projectDir, userDir, builtinDir }),
      language: 'en',
    });

    expect(definition).toMatchObject({
      name: 'security-reviewer',
      description: 'project-reviewer',
      sourcePath: projectPath,
      intervalMs: 15_000,
    });
  });

  it('should fall through to the user layer when the project definition is absent', () => {
    const userPath = writeDefinition(join(userDir, 'companions'), 'user-reviewer');
    writeDefinition(join(builtinDir, 'companions'), 'builtin-reviewer');

    const definition = loadCompanionDefinition('security-reviewer', {
      candidateDirs: buildCompanionLookupDirs({ projectDir, userDir, builtinDir }),
      language: 'en',
    });

    expect(definition.sourcePath).toBe(userPath);
    expect(definition.description).toBe('user-reviewer');
  });

  it.each(['ja', 'en'] as const)(
    'should isolate builtin %s companion reviewers from the general review workflow policy',
    (language) => {
      for (const name of [
        'ai-antipattern-review-companion',
        'testing-review-companion',
      ]) {
        const definition = loadCompanionDefinition(name, {
          candidateDirs: [getBuiltinCompanionsDir(language)],
          language,
        });

        expect(definition.policy).toContain('companion-review');
        expect(definition.policy).not.toContain('review');
      }
    },
  );

  it.each(['ja', 'en'] as const)(
    'should keep builtin %s companion finding adjudication owned by the moderator',
    (language) => {
      const definition = loadCompanionDefinition('review-companion-moderator', {
        candidateDirs: [getBuiltinCompanionsDir(language)],
        language,
      });

      expect(definition.policy).toContain('companion-round-adjudication');
      expect(definition.policy).not.toContain('companion-review');
      expect(definition.policy).not.toContain('review');
    },
  );

  it('should reject a symlinked companion lookup directory before loading a candidate', () => {
    const realDirectory = join(root, 'real-companions');
    mkdirSync(realDirectory);
    writeFileSync(join(realDirectory, 'security-reviewer.yaml'), [
      'name: security-reviewer',
      'description: linked reviewer',
      '',
    ].join('\n'), 'utf8');
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    symlinkSync(realDirectory, join(projectDir, '.takt', 'companions'));

    expect(() => loadCompanionDefinition('security-reviewer', {
      candidateDirs: buildCompanionLookupDirs({ projectDir, userDir, builtinDir }),
      language: 'en',
    })).toThrow(/symlink/i);
  });

  it('should reject provider execution fields instead of silently discarding them', () => {
    writeDefinition(
      join(projectDir, '.takt', 'companions'),
      'invalid-reviewer',
      'provider: codex',
    );

    expect(() => loadCompanionDefinition('security-reviewer', {
      candidateDirs: buildCompanionLookupDirs({ projectDir, userDir, builtinDir }),
      language: 'en',
    })).toThrow(/provider/);
  });

  it('should reject an undefined name at the resource-loading boundary', () => {
    expect(() => loadCompanionDefinition('missing-reviewer', {
      candidateDirs: buildCompanionLookupDirs({ projectDir, userDir, builtinDir }),
      language: 'en',
    })).toThrow(/missing-reviewer/);
  });

  it('should reject a definition whose declared name differs from its reference name', () => {
    const path = join(projectDir, '.takt', 'companions', 'security-reviewer.yaml');
    mkdirSync(join(projectDir, '.takt', 'companions'), { recursive: true });
    writeFileSync(path, 'name: design-reviewer\ndescription: wrong name\n', 'utf-8');

    expect(() => loadCompanionDefinition('security-reviewer', {
      candidateDirs: buildCompanionLookupDirs({ projectDir, userDir, builtinDir }),
      language: 'en',
    })).toThrow(/security-reviewer.*design-reviewer|design-reviewer.*security-reviewer/);
  });

  it('should accept the maximum platform-safe companion interval', () => {
    const directory = join(projectDir, '.takt', 'companions');
    const path = join(directory, 'security-reviewer.yaml');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, [
      'name: security-reviewer',
      'description: boundary interval',
      `interval_ms: ${MAX_COMPANION_INTERVAL_MS}`,
      '',
    ].join('\n'), 'utf8');

    const definition = loadCompanionDefinition('security-reviewer', {
      candidateDirs: buildCompanionLookupDirs({ projectDir, userDir, builtinDir }),
      language: 'en',
    });

    expect(definition.intervalMs).toBe(MAX_COMPANION_INTERVAL_MS);
  });

  it.each([
    MAX_COMPANION_INTERVAL_MS + 1,
    0,
    -1,
    1.5,
  ])('should reject an unsupported companion interval: %s', (intervalMs) => {
    const directory = join(projectDir, '.takt', 'companions');
    const path = join(directory, 'security-reviewer.yaml');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, [
      'name: security-reviewer',
      'description: invalid interval',
      `interval_ms: ${intervalMs}`,
      '',
    ].join('\n'), 'utf8');

    expect(() => loadCompanionDefinition('security-reviewer', {
      candidateDirs: buildCompanionLookupDirs({ projectDir, userDir, builtinDir }),
      language: 'en',
    })).toThrow();
  });
});
