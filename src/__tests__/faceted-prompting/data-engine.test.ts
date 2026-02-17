/**
 * Unit tests for faceted-prompting DataEngine implementations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileDataEngine, CompositeDataEngine } from '../../faceted-prompting/index.js';
import type { DataEngine, FacetKind } from '../../faceted-prompting/index.js';

import { existsSync, readFileSync, readdirSync } from 'node:fs';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('FileDataEngine', () => {
  const engine = new FileDataEngine('/root');

  describe('resolve', () => {
    it('should return FacetContent when file exists', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('persona body');

      const result = await engine.resolve('personas', 'coder');
      expect(result).toEqual({
        body: 'persona body',
        sourcePath: '/root/personas/coder.md',
      });
    });

    it('should return undefined when file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await engine.resolve('policies', 'missing');
      expect(result).toBeUndefined();
    });

    it('should resolve correct directory for each facet kind', async () => {
      const kinds: FacetKind[] = ['personas', 'policies', 'knowledge', 'instructions', 'output-contracts'];
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('content');

      for (const kind of kinds) {
        const result = await engine.resolve(kind, 'test');
        expect(result?.sourcePath).toBe(`/root/${kind}/test.md`);
      }
    });
  });

  describe('list', () => {
    it('should return facet keys from directory', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['coder.md', 'architect.md', 'readme.txt'] as unknown as ReturnType<typeof readdirSync>);

      const result = await engine.list('personas');
      expect(result).toEqual(['coder', 'architect']);
    });

    it('should return empty array when directory does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await engine.list('policies');
      expect(result).toEqual([]);
    });

    it('should filter non-.md files', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['a.md', 'b.txt', 'c.md'] as unknown as ReturnType<typeof readdirSync>);

      const result = await engine.list('knowledge');
      expect(result).toEqual(['a', 'c']);
    });
  });
});

describe('CompositeDataEngine', () => {
  it('should throw when constructed with empty engines array', () => {
    expect(() => new CompositeDataEngine([])).toThrow(
      'CompositeDataEngine requires at least one engine',
    );
  });

  describe('resolve', () => {
    it('should return result from first engine that resolves', async () => {
      const engine1: DataEngine = {
        resolve: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      };
      const engine2: DataEngine = {
        resolve: vi.fn().mockResolvedValue({ body: 'from engine2', sourcePath: '/e2/p.md' }),
        list: vi.fn().mockResolvedValue([]),
      };

      const composite = new CompositeDataEngine([engine1, engine2]);
      const result = await composite.resolve('personas', 'coder');

      expect(result).toEqual({ body: 'from engine2', sourcePath: '/e2/p.md' });
      expect(engine1.resolve).toHaveBeenCalledWith('personas', 'coder');
      expect(engine2.resolve).toHaveBeenCalledWith('personas', 'coder');
    });

    it('should return first match (first-wins)', async () => {
      const engine1: DataEngine = {
        resolve: vi.fn().mockResolvedValue({ body: 'from engine1' }),
        list: vi.fn().mockResolvedValue([]),
      };
      const engine2: DataEngine = {
        resolve: vi.fn().mockResolvedValue({ body: 'from engine2' }),
        list: vi.fn().mockResolvedValue([]),
      };

      const composite = new CompositeDataEngine([engine1, engine2]);
      const result = await composite.resolve('personas', 'coder');

      expect(result?.body).toBe('from engine1');
      expect(engine2.resolve).not.toHaveBeenCalled();
    });

    it('should return undefined when no engine resolves', async () => {
      const engine1: DataEngine = {
        resolve: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      };

      const composite = new CompositeDataEngine([engine1]);
      const result = await composite.resolve('policies', 'missing');

      expect(result).toBeUndefined();
    });
  });

  describe('list', () => {
    it('should return deduplicated keys from all engines', async () => {
      const engine1: DataEngine = {
        resolve: vi.fn(),
        list: vi.fn().mockResolvedValue(['a', 'b']),
      };
      const engine2: DataEngine = {
        resolve: vi.fn(),
        list: vi.fn().mockResolvedValue(['b', 'c']),
      };

      const composite = new CompositeDataEngine([engine1, engine2]);
      const result = await composite.list('personas');

      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('should preserve order with first-seen priority', async () => {
      const engine1: DataEngine = {
        resolve: vi.fn(),
        list: vi.fn().mockResolvedValue(['x', 'y']),
      };
      const engine2: DataEngine = {
        resolve: vi.fn(),
        list: vi.fn().mockResolvedValue(['y', 'z']),
      };

      const composite = new CompositeDataEngine([engine1, engine2]);
      const result = await composite.list('knowledge');

      expect(result).toEqual(['x', 'y', 'z']);
    });
  });
});
