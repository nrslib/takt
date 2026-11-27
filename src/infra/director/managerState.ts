import { join } from 'node:path';
import { z } from 'zod/v4';
import { readPrivateFile, writePrivateFile } from '../daemon/privateFile.js';

const managerIdSchema = z.string().regex(/^manager-[a-f0-9]{64}$/);
const stateSchema = z.object({ managerId: managerIdSchema, fired: z.boolean() }).strict();

export class DirectorManagerStateStore {
  constructor(private readonly configDirectory: string) {}

  private path(managerId: string): string {
    return join(this.configDirectory, 'director', 'managers', `${managerIdSchema.parse(managerId)}.json`);
  }

  async isFired(managerId: string): Promise<boolean> {
    const content = await readPrivateFile(this.path(managerId), 4096);
    if (content === undefined) return false;
    const state = stateSchema.parse(JSON.parse(content.toString('utf8')) as unknown);
    if (state.managerId !== managerId) throw new Error('Director manager state identity mismatch');
    return state.fired;
  }

  async setFired(managerId: string, fired: boolean, signal: AbortSignal): Promise<void> {
    const state = stateSchema.parse({ managerId, fired });
    await writePrivateFile(this.path(managerId), JSON.stringify(state), signal);
  }
}
