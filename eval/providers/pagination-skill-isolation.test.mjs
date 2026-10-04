import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSkillOverrides } from './cli-review.mjs';

test('opt-in isolation disables discovered user skills without changing other reviewer suites', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pagination-skills-'));
  try {
    const project = join(directory, 'project');
    const skill = join(directory, '.codex', 'skills', 'external-coding', 'SKILL.md');
    mkdirSync(project);
    mkdirSync(join(directory, '.codex', 'skills', 'external-coding'), { recursive: true });
    writeFileSync(skill, '---\nname: external-coding\ndescription: External test skill\n---\nExternal rules.\n');
    const env = { HOME: directory, CODEX_HOME: join(directory, '.codex') };
    assert.deepEqual(codexSkillOverrides({}, project, env), []);
    const overrides = codexSkillOverrides({ disable_inherited_skills: true }, project, env);
    assert.equal(overrides[0], '-c');
    assert.ok(overrides[1].includes(`path = ${JSON.stringify(realpathSync(skill))}`));
    assert.ok(overrides[1].includes('enabled = false'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
