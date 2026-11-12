import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertPrivateDirectoryReadSnapshot, capturePrivateDirectoryReadSnapshot,
  ensurePrivateDirectory, readPrivateFileState, writeNewPrivateFileWithMode, writePrivateFile,
} from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';
import { EpicIdSchema, EpicSchema, type Epic } from './schema.js';
import { finishEpic } from './state.js';

const EPIC_FILE_NAME = 'epic.json';
class InvalidEpicFileError extends Error {}

export class EpicStore {
  private readonly root: string;
  private readonly workspaceId: string;

  constructor(configDirectory: string, workspaceId: string) {
    this.workspaceId = EpicIdSchema.parse(workspaceId);
    this.root = join(configDirectory, 'workspaces', this.workspaceId, 'epics');
  }

  async create(input: unknown): Promise<Epic> {
    const epic = this.validate(input);
    const path = this.filePath(epic.id);
    assertSafePath(path, false);
    ensurePrivateDirectory(dirname(path));
    writeNewPrivateFileWithMode(path, JSON.stringify(epic), 0o600);
    return epic;
  }

  async get(id: string): Promise<Epic> {
    const epic = this.read(id);
    if (epic === undefined) throw new Error(`Epic does not exist: ${id}`);
    return epic;
  }

  save(input: Epic): Epic {
    const epic = this.validate(input);
    const path = this.filePath(epic.id);
    assertSafePath(path, false);
    if (this.read(epic.id) === undefined) throw new Error(`Epic does not exist: ${epic.id}`);
    writePrivateFile(path, JSON.stringify(epic));
    return epic;
  }

  async list(page?: { offset: number; limit: number }): Promise<{ epics: Epic[]; totalCount: number; errors: { epicId: string; error: Error }[] }> {
    assertSafePath(this.root, true);
    if (lstatOrUndefined(this.root) === undefined) return { epics: [], totalCount: 0, errors: [] };
    const snapshot = capturePrivateDirectoryReadSnapshot(this.root);
    const epics: Epic[] = [];
    const errors: { epicId: string; error: Error }[] = [];
    let totalCount = 0;
    for (const entry of readdirSync(this.root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const parsedId = EpicIdSchema.safeParse(entry.name);
      if (!parsedId.success) continue;
      const id = parsedId.data;
      try {
        const epic = this.read(id);
        if (epic !== undefined) {
          if (page === undefined || totalCount >= page.offset && totalCount - page.offset < page.limit) epics.push(epic);
          totalCount++;
        }
      } catch (error) {
        if (!(error instanceof InvalidEpicFileError)) throw error;
        errors.push({ epicId: id, error });
      }
    }
    assertPrivateDirectoryReadSnapshot(snapshot);
    return { epics, totalCount, errors };
  }

  private validate(input: unknown): Epic {
    const epic = EpicSchema.parse(input);
    if (epic.workspaceId !== this.workspaceId) throw new Error('Epic belongs to another workspace');
    if (epic.status === 'completed') finishEpic(epic);
    return epic;
  }

  private filePath(id: string): string {
    return join(this.root, EpicIdSchema.parse(id), EPIC_FILE_NAME);
  }

  private read(id: string): Epic | undefined {
    const path = this.filePath(id);
    assertSafePath(path, false);
    if (lstatOrUndefined(dirname(path)) === undefined) return undefined;
    const snapshot = readPrivateFileState(path);
    if (!('content' in snapshot)) return undefined;
    try {
      const raw: unknown = JSON.parse(snapshot.content.toString('utf8'));
      const epic = this.validate(raw);
      if (epic.id !== id) throw new Error('Saved Epic ID differs from its directory');
      return epic;
    } catch (error) {
      throw new InvalidEpicFileError(`Invalid Epic file: ${path}`, { cause: error });
    }
  }
}
