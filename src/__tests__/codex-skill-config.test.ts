import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexSkillConfig } from '../infra/codex/skill-config.js';

const tempRoots = new Set<string>();

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-codex-skills-'));
  tempRoots.add(root);
  return root;
}

function createSkill(root: string, name: string): string {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, `# ${name}\n`, 'utf-8');
  return realpathSync(skillPath);
}

function disabledPaths(config: ReturnType<typeof buildCodexSkillConfig>): string[] {
  const skills = config?.skills as { config?: Array<{ path: string; enabled: boolean }> } | undefined;
  return skills?.config?.map((entry) => entry.path) ?? [];
}

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe('buildCodexSkillConfig', () => {
  it('両 scope を継承すると filesystem を探索せず override を返さない', () => {
    expect(buildCodexSkillConfig({
      cwd: '/path/that/does/not/exist',
      env: {},
      inheritance: { repo: true, user: true },
    })).toBeUndefined();
  });

  it('実行 CWD から repository root までの REPO Skill を無効化する', () => {
    const root = createTempRoot();
    mkdirSync(join(root, '.git'));
    const rootSkill = createSkill(join(root, '.agents', 'skills'), 'root-skill');
    const cwd = join(root, 'packages', 'app');
    mkdirSync(cwd, { recursive: true });
    const nestedSkill = createSkill(join(cwd, '.agents', 'skills'), 'nested-skill');
    const home = join(root, 'home');
    createSkill(join(home, '.agents', 'skills'), 'user-skill');

    const config = buildCodexSkillConfig({
      cwd,
      env: { HOME: home },
      inheritance: { repo: false, user: true },
    });

    expect(disabledPaths(config)).toEqual([nestedSkill, rootSkill].sort());
    expect(config).toEqual({
      skills: {
        config: [nestedSkill, rootSkill]
          .sort()
          .map((path) => ({ path, enabled: false })),
      },
    });
  });

  it('USER Skill と互換 CODEX_HOME Skill を無効化し SYSTEM Skill は除外する', () => {
    const root = createTempRoot();
    const cwd = join(root, 'work');
    const home = join(root, 'home');
    const codexHome = join(root, 'codex-home');
    mkdirSync(cwd, { recursive: true });
    const agentsSkill = createSkill(join(home, '.agents', 'skills'), 'agents-user');
    const legacySkill = createSkill(join(codexHome, 'skills'), 'legacy-user');
    createSkill(join(codexHome, 'skills', '.system'), 'system-skill');

    const config = buildCodexSkillConfig({
      cwd,
      env: { HOME: home, CODEX_HOME: codexHome },
      inheritance: { repo: true, user: false },
    });

    expect(disabledPaths(config)).toEqual([agentsSkill, legacySkill].sort());
  });

  it('.agents が通常ファイルでも Skill root なしとして扱う', () => {
    const root = createTempRoot();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.agents'), 'not a directory', 'utf-8');

    expect(buildCodexSkillConfig({
      cwd: root,
      env: { HOME: join(root, 'home') },
      inheritance: { repo: false, user: true },
    })).toBeUndefined();
  });

  it('Codex と同じ探索深度より深い directory は走査しない', () => {
    const root = createTempRoot();
    mkdirSync(join(root, '.git'));
    const skillsRoot = join(root, '.agents', 'skills');
    const withinLimit = createSkill(
      join(skillsRoot, 'one', 'two', 'three', 'four', 'five'),
      'within-limit',
    );
    createSkill(
      join(skillsRoot, 'one', 'two', 'three', 'four', 'five', 'six'),
      'beyond-limit',
    );

    const config = buildCodexSkillConfig({
      cwd: root,
      env: { HOME: join(root, 'home') },
      inheritance: { repo: false, user: true },
    });

    expect(disabledPaths(config)).toEqual([withinLimit]);
  });

  it.skipIf(process.platform === 'win32')(
    'symlink を実体パスへ正規化し、重複と directory cycle を除去する',
    () => {
      const root = createTempRoot();
      const cwd = join(root, 'work');
      mkdirSync(join(cwd, '.git'), { recursive: true });
      const skillsRoot = join(cwd, '.agents', 'skills');
      const skillPath = createSkill(skillsRoot, 'original');
      symlinkSync(join(skillsRoot, 'original'), join(skillsRoot, 'alias'));
      symlinkSync(skillsRoot, join(skillsRoot, 'cycle'));

      const config = buildCodexSkillConfig({
        cwd,
        env: { HOME: join(root, 'home') },
        inheritance: { repo: false, user: true },
      });

      expect(disabledPaths(config)).toEqual([skillPath]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    '解決できない nested .git marker を無視して上位 repository root を使う',
    () => {
      const root = createTempRoot();
      mkdirSync(join(root, '.git'));
      const rootSkill = createSkill(join(root, '.agents', 'skills'), 'root-skill');
      const brokenRoot = join(root, 'broken');
      const cyclicRoot = join(root, 'cyclic');
      mkdirSync(join(brokenRoot, 'deep'), { recursive: true });
      mkdirSync(join(cyclicRoot, 'deep'), { recursive: true });
      symlinkSync('missing-target', join(brokenRoot, '.git'));
      symlinkSync('.git', join(cyclicRoot, '.git'));

      for (const cwd of [join(brokenRoot, 'deep'), join(cyclicRoot, 'deep')]) {
        const config = buildCodexSkillConfig({
          cwd,
          env: { HOME: join(root, 'home') },
          inheritance: { repo: false, user: true },
        });
        expect(disabledPaths(config)).toEqual([rootSkill]);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'hidden directory は走査せず visible symlink から hidden 実体を走査する',
    () => {
      const root = createTempRoot();
      mkdirSync(join(root, '.git'));
      const skillsRoot = join(root, '.agents', 'skills');
      const hiddenSkill = createSkill(join(skillsRoot, '.hidden'), 'linked-skill');
      symlinkSync(join(skillsRoot, '.hidden'), join(skillsRoot, 'visible-link'));
      createSkill(join(skillsRoot, '.ignored'), 'ignored-skill');

      const config = buildCodexSkillConfig({
        cwd: root,
        env: { HOME: join(root, 'home') },
        inheritance: { repo: false, user: true },
      });

      expect(disabledPaths(config)).toEqual([hiddenSkill]);
    },
  );
});
