import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skillDoc = readFileSync(join(process.cwd(), 'builtins', 'skill-codex', 'SKILL.md'), 'utf-8');
const engineDoc = readFileSync(join(process.cwd(), 'builtins', 'skill-codex', 'references', 'engine.md'), 'utf-8');
const schemaDoc = readFileSync(join(process.cwd(), 'builtins', 'skill-codex', 'references', 'yaml-schema.md'), 'utf-8');
const sharedSchemaDoc = readFileSync(join(process.cwd(), 'builtins', 'skill', 'references', 'yaml-schema.md'), 'utf-8');

describe('skill-codex document safety guidance', () => {
  it('should define required YAML frontmatter for Codex SKILL.md', () => {
    expect(skillDoc).toMatch(/^---\nname: takt\n/);
    expect(skillDoc).toContain('description: >');
    expect(skillDoc).toContain('\n---\n');
  });

  it('should describe codex exec workflow and permission mapping', () => {
    expect(skillDoc).toContain('Write tool + Bash tool (`codex exec`)');
    expect(skillDoc).toContain('codex exec --sandbox danger-full-access');
    expect(skillDoc).toContain('codex exec --full-auto');
    expect(skillDoc).toContain('codex exec (オプションなし)');
  });

  it('should consistently use ~/.agents/skills/takt path base for codex skill resources', () => {
    expect(skillDoc).toContain('~/.agents/skills/takt/');
    expect(engineDoc).toContain('~/.agents/skills/takt/');
    expect(skillDoc).not.toContain('~/.claude/skills/takt/');
    expect(engineDoc).not.toContain('~/.claude/skills/takt/');
  });

  it('should remove Task tool instructions from codex-specific engine docs', () => {
    expect(engineDoc).not.toContain('Task tool');
    expect(engineDoc).not.toContain('TeamCreate');
    expect(engineDoc).not.toContain('TeamDelete');
    expect(engineDoc).toContain('codex exec');
  });

  it('should require random temp file names instead of movement or substep names', () => {
    expect(skillDoc).toContain('movement名やsubstep名をファイル名に含めず');
    expect(engineDoc).toContain('movement名を含めない安全なランダム名');
  });

  it('should avoid examples that interpolate movement or substep names into shell paths', () => {
    expect(skillDoc).not.toMatch(/takt-\{movement/i);
    expect(skillDoc).not.toMatch(/takt-\{substep/i);
    expect(engineDoc).not.toMatch(/takt-\{movement/i);
    expect(engineDoc).not.toMatch(/takt-\{substep/i);
  });

  it('should show quoted temp-file variable usage for codex exec stdin redirection', () => {
    expect(skillDoc).toContain('< "$tmp_prompt_file"');
    expect(engineDoc).toContain('< "$tmp_prompt_file"');
  });

  it('should keep yaml schema identical to shared schema reference', () => {
    expect(schemaDoc).toBe(sharedSchemaDoc);
  });
});
