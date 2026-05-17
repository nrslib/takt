import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MAX_ASSISTANT_INIT_CONTEXT_BYTES,
  MAX_ASSISTANT_INIT_FILE_BYTES,
} from '../core/models/assistant-config.js';
import { loadAssistantInitContext } from '../features/interactive/assistantInitFiles.js';

describe('loadAssistantInitContext', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-assistant-init-files-'));
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeProjectConfig(initFiles: string[]): void {
    const lines = [
      'assistant:',
      '  init_files:',
      ...initFiles.map((file) => `    - ${file}`),
    ];
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), lines.join('\n'), 'utf-8');
  }

  function writeConfiguredFile(path: string, content: string): void {
    mkdirSync(dirname(join(projectDir, path)), { recursive: true });
    writeFileSync(join(projectDir, path), content, 'utf-8');
  }

  it('should return undefined when assistant.init_files is not configured', () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), 'default context must not load', 'utf-8');
    writeFileSync(join(projectDir, 'AGENTS.md'), 'default agents must not load', 'utf-8');

    const result = loadAssistantInitContext(projectDir);

    expect(result).toBeUndefined();
  });

  it('should return undefined when assistant.init_files is empty', () => {
    writeFileSync(
      join(projectDir, '.takt', 'config.yaml'),
      ['assistant:', '  init_files: []'].join('\n'),
      'utf-8',
    );

    const result = loadAssistantInitContext(projectDir);

    expect(result).toBeUndefined();
  });

  it('should load only configured files in config order', () => {
    writeConfiguredFile('docs/assistant-context.md', 'first configured context');
    writeConfiguredFile('.takt/assistant-notes.md', 'second configured context');
    writeFileSync(join(projectDir, 'TAKT.md'), 'default file must not load', 'utf-8');
    writeProjectConfig(['docs/assistant-context.md', '.takt/assistant-notes.md']);

    const result = loadAssistantInitContext(projectDir);

    expect(result).toBeDefined();
    expect(result).toContain('Assistant Init Context');
    expect(result).toContain('docs/assistant-context.md');
    expect(result).toContain('.takt/assistant-notes.md');
    expect(result).toContain('first configured context');
    expect(result).toContain('second configured context');
    expect(result).not.toContain('default file must not load');
    expect(result).not.toContain('Source Context');
    expect(result).not.toContain('untrusted reference data');
    expect(result!.indexOf('first configured context')).toBeLessThan(
      result!.indexOf('second configured context'),
    );
  });

  it('should load explicitly configured assistant notes inside .takt', () => {
    writeConfiguredFile('docs/assistant-context.md', 'first configured context');
    writeConfiguredFile('.takt/assistant-notes.md', 'second configured context');
    writeProjectConfig(['docs/assistant-context.md', '.takt/assistant-notes.md']);

    const result = loadAssistantInitContext(projectDir);

    expect(result).toContain('docs/assistant-context.md');
    expect(result).toContain('.takt/assistant-notes.md');
    expect(result).toContain('first configured context');
    expect(result).toContain('second configured context');
  });

  it('should reject a missing configured file', () => {
    writeProjectConfig(['docs/missing.md']);

    expect(() => loadAssistantInitContext(projectDir)).toThrow(/docs\/missing\.md/);
  });

  it('should reject a configured directory', () => {
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    writeProjectConfig(['docs']);

    expect(() => loadAssistantInitContext(projectDir)).toThrow(/docs|directory|ディレクトリ/i);
  });

  it('should reject an unreadable configured file', () => {
    const filePath = join(projectDir, 'docs', 'unreadable.md');
    writeConfiguredFile('docs/unreadable.md', 'unreadable context');
    writeProjectConfig(['docs/unreadable.md']);

    chmodSync(filePath, 0o000);
    try {
      expect(() => loadAssistantInitContext(projectDir)).toThrow(/docs\/unreadable\.md|read/i);
    } finally {
      chmodSync(filePath, 0o600);
    }
  });

  it('should load a configured file when it matches .gitignore', () => {
    writeFileSync(join(projectDir, '.gitignore'), 'local-notes.md\n', 'utf-8');
    writeFileSync(join(projectDir, 'local-notes.md'), 'local secret notes', 'utf-8');
    writeProjectConfig(['local-notes.md']);

    const result = loadAssistantInitContext(projectDir);

    expect(result).toContain('local-notes.md');
    expect(result).toContain('local secret notes');
  });

  it.each([
    { path: '.env.local', content: 'TOKEN=secret', error: /\.env\.local|sensitive/i },
    { path: '.ENV.local', content: 'TOKEN=secret', error: /\.ENV\.local|sensitive/i },
    { path: '.npmrc', content: '//registry.example/:_authToken=secret', error: /\.npmrc|sensitive/i },
    { path: '.NPMRC', content: '//registry.example/:_authToken=secret', error: /\.NPMRC|sensitive/i },
    { path: '.pypirc', content: 'password = secret', error: /\.pypirc|sensitive/i },
    { path: '.netrc', content: 'machine example login user password secret', error: /\.netrc|sensitive/i },
    { path: 'docs/private.pem', content: 'private key', error: /docs\/private\.pem|sensitive/i },
    { path: 'docs/PRIVATE.PEM', content: 'private key', error: /docs\/PRIVATE\.PEM|sensitive/i },
    { path: 'docs/private.key', content: 'private key', error: /docs\/private\.key|sensitive/i },
    { path: 'docs/PRIVATE.KEY', content: 'private key', error: /docs\/PRIVATE\.KEY|sensitive/i },
  ])('should reject configured file $path when it matches a sensitive file pattern', ({ path, content, error }) => {
    writeConfiguredFile(path, content);
    writeProjectConfig([path]);

    expect(() => loadAssistantInitContext(projectDir)).toThrow(error);
  });

  it('should reject configured files inside .git as sensitive paths', () => {
    writeConfiguredFile('.git/config', 'repository config');
    writeProjectConfig(['.git/config']);

    expect(() => loadAssistantInitContext(projectDir)).toThrow(/\.git\/config|sensitive/i);
  });

  it('should reject configured files inside case-varied .git directories as sensitive paths', () => {
    writeConfiguredFile('metadata/.GIT/config', 'repository config');
    writeProjectConfig(['metadata/.GIT/config']);

    expect(() => loadAssistantInitContext(projectDir)).toThrow(/metadata\/\.GIT\/config|sensitive/i);
  });

  it('should load a configured symlink when the target stays inside the project root', () => {
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    writeConfiguredFile('private-context.md', 'private local context');
    symlinkSync(join(projectDir, 'private-context.md'), join(projectDir, 'docs', 'context.md'));
    writeProjectConfig(['docs/context.md']);

    const result = loadAssistantInitContext(projectDir);

    expect(result).toContain('docs/context.md');
    expect(result).toContain('private local context');
  });

  it('should reject a configured file that exceeds the per-file size limit', () => {
    writeConfiguredFile('docs/too-large.md', 'a'.repeat(MAX_ASSISTANT_INIT_FILE_BYTES + 1));
    writeProjectConfig(['docs/too-large.md']);

    expect(() => loadAssistantInitContext(projectDir)).toThrow(/too-large\.md|too large/i);
  });

  it('should reject configured files that exceed the total context size limit', () => {
    const files = ['first.md', 'second.md', 'third.md', 'fourth.md', 'fifth.md'];
    for (const file of files.slice(0, 4)) {
      writeConfiguredFile(`docs/${file}`, 'a'.repeat(MAX_ASSISTANT_INIT_FILE_BYTES));
    }
    writeConfiguredFile('docs/fifth.md', 'a'.repeat(1));
    writeProjectConfig(files.map((file) => `docs/${file}`));

    expect(() => loadAssistantInitContext(projectDir)).toThrow(/too large|total limit/i);
  });

  it('should reject absolute paths', () => {
    const absolutePath = resolve(projectDir, 'docs', 'assistant-context.md');
    writeProjectConfig([absolutePath]);

    expect(() => loadAssistantInitContext(projectDir)).toThrow(/absolute|絶対パス/i);
  });

  it('should reject paths outside the project root', () => {
    writeProjectConfig(['../outside.md']);

    expect(() => loadAssistantInitContext(projectDir)).toThrow(/outside|project root|プロジェクトルート/i);
  });

  it('should reject symlinks that resolve outside the project root', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-assistant-init-outside-'));
    const outsideFile = join(outsideDir, 'outside.md');
    writeFileSync(outsideFile, 'outside context', 'utf-8');
    symlinkSync(outsideFile, join(projectDir, 'linked-context.md'));
    writeProjectConfig(['linked-context.md']);

    try {
      expect(() => loadAssistantInitContext(projectDir)).toThrow(/outside|project root|プロジェクトルート/i);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
