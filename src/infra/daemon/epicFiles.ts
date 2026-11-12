import { lstat, readdir } from 'node:fs/promises';
import { constants as bufferConstants } from 'node:buffer';
import { join } from 'node:path';
import { EpicIdSchema, EpicSchema, type EpicView } from '../epics/schema.js';
import { epicView, finishEpic } from '../epics/state.js';
import { hasCode, readPrivateFile } from './privateFile.js';

/** 読取中に祖先が差し替わった場合も、結果を公開しない。 */
export class DaemonEpicFiles {
  constructor(private readonly directory: string) {}

  private paths(workspaceId: string, epicId?: string): string[] {
    const workspace = join(this.directory, 'workspaces', EpicIdSchema.parse(workspaceId));
    const paths = [this.directory, join(this.directory, 'workspaces'), workspace, join(workspace, 'epics')];
    if (epicId !== undefined) paths.push(join(workspace, 'epics', EpicIdSchema.parse(epicId)));
    return paths;
  }

  private async directories(paths: string[]): Promise<string[]> {
    const stamps: string[] = [];
    for (const path of paths) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid Epic directory: ${path}`);
      stamps.push(`${stat.dev}:${stat.ino}`);
    }
    return stamps;
  }

  async get(workspaceId: string, epicId: string): Promise<EpicView> {
    const paths = this.paths(workspaceId, epicId);
    const before = await this.directories(paths);
    // 保存側と同じ Buffer の上限を使い、Epic 独自の容量制限を加えない。
    const content = await readPrivateFile(join(paths.at(-1)!, 'epic.json'), bufferConstants.MAX_LENGTH);
    if (content === undefined) throw new Error(`Epic file disappeared: ${epicId}`);
    const after = await this.directories(paths);
    if (before.some((stamp, index) => stamp !== after[index])) throw new Error('Epic directory changed during read');
    const epic = EpicSchema.parse(JSON.parse(content.toString('utf8')) as unknown);
    if (epic.id !== epicId || epic.workspaceId !== workspaceId) throw new Error('Epic ownership mismatch');
    if (epic.status === 'completed') finishEpic(epic);
    return epicView(epic);
  }

  async *list(workspaceId: string): AsyncGenerator<EpicView> {
    const paths = this.paths(workspaceId);
    let before: string[];
    // 新規 workspace には epics ディレクトリがまだ存在しない。
    try { before = await this.directories(paths); }
    catch (error) {
      if (hasCode(error, 'ENOENT')) {
        await this.directories(paths.slice(0, -1));
        return;
      }
      throw error;
    }
    const entries = await readdir(paths.at(-1)!, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!EpicIdSchema.safeParse(entry.name).success) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid Epic entry');
      yield await this.get(workspaceId, entry.name);
    }
    const after = await this.directories(paths);
    if (before.some((stamp, index) => stamp !== after[index])) throw new Error('Epic directory changed during listing');
  }
}
