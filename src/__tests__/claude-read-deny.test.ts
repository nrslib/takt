import { describe, expect, it, vi } from 'vitest';
import { resolveClaudeDenyRules } from '../infra/claude/read-deny.js';

const SETTINGS_PATH = '/home/tester/.claude/settings.json';

type ClaudePermissionsInput = Parameters<typeof resolveClaudeDenyRules>[0];

function createFileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: cannot read settings`), { code });
}

function resolveWithFile(permissions: ClaudePermissionsInput, fileContent: string | Error) {
  const readFile = vi.fn((_path: string): string => {
    if (fileContent instanceof Error) {
      throw fileContent;
    }
    return fileContent;
  });
  const warn = vi.fn<(message: string) => void>();
  const result = resolveClaudeDenyRules(permissions, { settingsPath: SETTINGS_PATH, readFile, warn });
  return { result, readFile, warn };
}

function settingsJson(deny: unknown): string {
  return JSON.stringify({ permissions: { deny } });
}

function expectSameRules(actual: readonly string[] | undefined, expected: readonly string[]): void {
  expect(actual).toBeDefined();
  expect(actual).toHaveLength(expected.length);
  expect(new Set(actual)).toEqual(new Set(expected));
}

describe('resolveClaudeDenyRules', () => {
  describe('union of the TAKT config deny and the imported Read( deny', () => {
    it('Given import on, When TAKT deny and the file deny overlap, Then returns the union without the non-Read( rules and without duplicates', () => {
      const { result, warn } = resolveWithFile(
        { deny: ['Read(./.env)', 'Read(~/.ssh/**)'], importUserReadDeny: true },
        settingsJson(['Read(./.env)', 'Bash(rm -rf:*)', 'mcp__example']),
      );

      expectSameRules(result, ['Read(./.env)', 'Read(~/.ssh/**)']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('Given import on, When the file has Read( rules that TAKT deny does not have, Then they are added to the TAKT deny', () => {
      const { result } = resolveWithFile(
        { deny: ['Read(~/.ssh/**)'], importUserReadDeny: true },
        settingsJson(['Read(./.env)', 'Read(**/*.pem)']),
      );

      expectSameRules(result, ['Read(~/.ssh/**)', 'Read(./.env)', 'Read(**/*.pem)']);
    });

    it('Given import on and no TAKT deny, When the file has Read( rules, Then only the Read( rules are imported', () => {
      const { result } = resolveWithFile(
        { importUserReadDeny: true },
        settingsJson(['Read(./.env)', 'Bash(rm -rf:*)', 'mcp__example']),
      );

      expectSameRules(result, ['Read(./.env)']);
    });

    it('Given import off, When the file has Read( rules, Then only the TAKT deny is returned and the file is not read', () => {
      const { result, readFile, warn } = resolveWithFile(
        { deny: ['Read(~/.ssh/**)'], importUserReadDeny: false },
        settingsJson(['Read(./.env)']),
      );

      expectSameRules(result, ['Read(~/.ssh/**)']);
      expect(readFile).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('Given the import switch is not set, When TAKT deny is set, Then the file is not read', () => {
      const { result, readFile } = resolveWithFile(
        { deny: ['Read(~/.ssh/**)'] },
        settingsJson(['Read(./.env)']),
      );

      expectSameRules(result, ['Read(~/.ssh/**)']);
      expect(readFile).not.toHaveBeenCalled();
    });

    it('Given the same rule is written twice in TAKT deny, When resolving, Then it is returned once', () => {
      const { result } = resolveWithFile(
        { deny: ['Read(./.env)', 'Read(./.env)'] },
        settingsJson([]),
      );

      expectSameRules(result, ['Read(./.env)']);
    });

    it('Given a TAKT deny rule that does not start with Read(, When resolving, Then it is passed as written', () => {
      const { result } = resolveWithFile(
        { deny: ['Bash(rm:*)', 'Read(./.env)'] },
        settingsJson([]),
      );

      expectSameRules(result, ['Bash(rm:*)', 'Read(./.env)']);
    });

    it('Given a frozen TAKT deny array, When resolving with import on, Then the caller-owned array is left untouched', () => {
      const taktDeny = Object.freeze(['Read(./.env)']) as unknown as string[];

      const { result } = resolveWithFile(
        { deny: taktDeny, importUserReadDeny: true },
        settingsJson(['Read(~/.aws/**)']),
      );

      expectSameRules(result, ['Read(./.env)', 'Read(~/.aws/**)']);
      expect(taktDeny).toEqual(['Read(./.env)']);
    });
  });

  describe('only rules that start with Read( are imported from the file', () => {
    it('Given deny entries that only look like Read( rules, When importing, Then nothing is imported and no warning is issued', () => {
      const { result, warn } = resolveWithFile(
        { importUserReadDeny: true },
        settingsJson(['Bash(cat Read(./.env))', 'read(./.env)', ' Read(./.env)', 'READ(./.env)']),
      );

      expect(result).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('Given a mix of Read( rules and non-string entries, When importing, Then only the Read( strings are imported', () => {
      const { result } = resolveWithFile(
        { importUserReadDeny: true },
        settingsJson([42, 'Read(./.env)', null, 'Bash(curl:*)', 'Read(~/.aws/**)']),
      );

      expectSameRules(result, ['Read(./.env)', 'Read(~/.aws/**)']);
    });
  });

  describe('a settings file that cannot be imported does not stop the launch', () => {
    it.each([
      ['does not exist', createFileError('ENOENT')],
      ['cannot be read for lack of permission', createFileError('EACCES')],
      ['is not valid JSON', '{ "permissions": { "deny": [ "Read(./.env)" '],
    ])('Given import on, When the settings file %s, Then it warns once and returns only the TAKT deny', (_state, fileContent) => {
      const { result, warn, readFile } = resolveWithFile(
        { deny: ['Read(~/.ssh/**)'], importUserReadDeny: true },
        fileContent,
      );

      expectSameRules(result, ['Read(~/.ssh/**)']);
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(readFile.mock.calls[0]![0]).toBe(SETTINGS_PATH);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(SETTINGS_PATH);
    });

    it.each([
      ['does not exist', createFileError('ENOENT')],
      ['is not valid JSON', 'not json at all'],
    ])('Given import on and no TAKT deny, When the settings file %s, Then it warns once and no deny is passed', (_state, fileContent) => {
      const { result, warn } = resolveWithFile({ importUserReadDeny: true }, fileContent);

      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['permissions.deny is a string', JSON.stringify({ permissions: { deny: 'Read(./.env)' } })],
      ['permissions.deny is an object', JSON.stringify({ permissions: { deny: { 0: 'Read(./.env)' } } })],
      ['permissions is a string', JSON.stringify({ permissions: 'Read(./.env)' })],
    ])('Given import on, When %s, Then it does not throw and returns only the TAKT deny', (_state, fileContent) => {
      const { result } = resolveWithFile(
        { deny: ['Read(~/.ssh/**)'], importUserReadDeny: true },
        fileContent,
      );

      expectSameRules(result, ['Read(~/.ssh/**)']);
    });

    it.each(['null', '[]', '42', '"text"'])(
      'Given import on, When the file is JSON %s that is not a settings object, Then it does not throw and keeps the TAKT deny',
      (fileContent) => {
        const { result } = resolveWithFile(
          { deny: ['Read(~/.ssh/**)'], importUserReadDeny: true },
          fileContent,
        );

        expectSameRules(result, ['Read(~/.ssh/**)']);
      },
    );

    it('Given import on, When resolving twice with the file missing, Then it warns on each resolution', () => {
      const readFile = vi.fn((_path: string): string => {
        throw createFileError('ENOENT');
      });
      const warn = vi.fn<(message: string) => void>();
      const deps = { settingsPath: SETTINGS_PATH, readFile, warn };

      resolveClaudeDenyRules({ importUserReadDeny: true }, deps);
      resolveClaudeDenyRules({ importUserReadDeny: true }, deps);

      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('a readable file without Read( rules adds nothing', () => {
    it.each([
      ['only non-Read( rules', settingsJson(['Bash(rm -rf:*)'])],
      ['an empty deny array', settingsJson([])],
      ['no deny key', JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } })],
      ['no permissions key', JSON.stringify({ model: 'sonnet' })],
    ])('Given import on and no TAKT deny, When the file has %s, Then no deny is passed and no warning is issued', (_state, fileContent) => {
      const { result, warn } = resolveWithFile({ importUserReadDeny: true }, fileContent);

      expect(result).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('Given import on and a TAKT deny, When the file has only non-Read( rules, Then only the TAKT deny is returned', () => {
      const { result, warn } = resolveWithFile(
        { deny: ['Read(~/.ssh/**)'], importUserReadDeny: true },
        settingsJson(['Bash(rm -rf:*)', 'mcp__example']),
      );

      expectSameRules(result, ['Read(~/.ssh/**)']);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('nothing specified keeps the current behavior', () => {
    it.each<[string, ClaudePermissionsInput]>([
      ['permissions is undefined', undefined],
      ['permissions is empty', {}],
      ['import is off and deny is not set', { importUserReadDeny: false }],
      ['deny is an empty array and import is off', { deny: [], importUserReadDeny: false }],
    ])('Given %s, When resolving, Then no deny is passed, the file is not read, and no warning is issued', (_state, permissions) => {
      const { result, readFile, warn } = resolveWithFile(permissions, settingsJson(['Read(./.env)']));

      expect(result).toBeUndefined();
      expect(readFile).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('resolution happens for every launch', () => {
    it('Given the file changes between two launches, When resolving each launch, Then each result reflects the file at that launch', () => {
      let fileContent = settingsJson(['Read(./.env)']);
      const readFile = vi.fn((_path: string): string => fileContent);
      const warn = vi.fn<(message: string) => void>();
      const deps = { settingsPath: SETTINGS_PATH, readFile, warn };

      const first = resolveClaudeDenyRules({ importUserReadDeny: true }, deps);
      fileContent = settingsJson(['Read(~/.aws/**)']);
      const second = resolveClaudeDenyRules({ importUserReadDeny: true }, deps);

      expectSameRules(first, ['Read(./.env)']);
      expectSameRules(second, ['Read(~/.aws/**)']);
    });
  });
});
