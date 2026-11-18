import { describe, expect, it } from 'vitest';
import { parseGitNulPaths } from '../shared/utils/gitNulPaths.js';

describe('Git NUL-delimited paths', () => {
  it('accepts an empty inventory', () => {
    expect(parseGitNulPaths(Buffer.alloc(0), 'git ls-files')).toEqual([]);
  });

  it('preserves UTF-8 names and embedded POSIX whitespace without splitting paths', () => {
    const paths = ['src/file.ts', '日本語.ts', 'line\nbreak\tpath.ts', 'replacement-\uFFFD.ts'];
    expect(parseGitNulPaths(Buffer.from(`${paths.join('\0')}\0`), 'git ls-files')).toEqual(paths);
  });

  it.each([
    { name: 'missing final delimiter', output: Buffer.from('path.ts') },
    { name: 'empty path', output: Buffer.from('path.ts\0\0') },
    { name: 'invalid UTF-8 colliding with a valid replacement character', output: Buffer.from([0xff, 0]) },
  ])('rejects $name instead of silently changing the inventory', ({ output }) => {
    expect(() => parseGitNulPaths(output, 'git ls-files')).toThrow();
  });
});
