import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { ConversationError } from '../manager/conversationErrors.js';
import type { ConversationDisplayAssignment } from '../manager/conversationPort.js';
import { readDaemonProjectRoutes } from './projects.js';
import { listWatchEntries, readSmallJson } from './watchers/files.js';
import { z } from 'zod/v4';

export const projectKey = (directory: string): string => createHash('sha256').update(directory).digest('hex');
export const routeAssignment = (route: { repositoryDirectory: string; workspaceId: string | null }): ConversationAssignment =>
  route.workspaceId === null ? { kind: 'repository', repositoryDirectory: route.repositoryDirectory } : { kind: 'workspace', workspaceId: route.workspaceId };

export class DaemonRouting {
  constructor(readonly directory: string) {}

  routes() { return readDaemonProjectRoutes(this.directory); }

  async assignments(): Promise<readonly ConversationAssignment[]> {
    const assignments = new Map<string, ConversationAssignment>();
    for (const route of await this.routes()) {
      const assignment = routeAssignment(route);
      assignments.set(conversationId(assignment), assignment);
    }
    for (const entry of await listWatchEntries(join(this.directory, 'workspaces'))) {
      if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
      const workspace = await this.workspace(entry.name);
      const assignment: ConversationAssignment = { kind: 'workspace', workspaceId: workspace.id };
      assignments.set(conversationId(assignment), assignment);
    }
    return [...assignments.values()];
  }

  async resolve(selected: ConversationAssignment): Promise<ConversationAssignment> {
    if (selected.kind === 'daemon') return selected;
    const routes = await this.routes();
    if (selected.kind === 'workspace') {
      if (!routes.some((route) => route.workspaceId === selected.workspaceId)) {
        // 空の workspace も director/TUI の有効な会話先。
        await this.workspace(selected.workspaceId);
      }
      return selected;
    }
    const canonical = await realpath(selected.repositoryDirectory);
    const route = routes.find((entry) => entry.repositoryDirectory === canonical);
    if (route === undefined) throw new ConversationError('invalid_assignment');
    return routeAssignment(route);
  }

  async workspace(id: string) {
    const value = z.object({ id: z.uuid(), name: z.string().min(1), repositoryDirectories: z.array(z.string()) }).parse(
      await readSmallJson(join(this.directory, 'workspaces', z.uuid().parse(id), 'workspace.json')));
    if (value.id !== id) throw new ConversationError('invalid_assignment');
    return value;
  }

  async display(assignment: ConversationAssignment): Promise<ConversationDisplayAssignment> {
    if (assignment.kind === 'daemon') return { kind: 'daemon', repositoryDirectories: [] };
    if (assignment.kind === 'repository') return { ...assignment, repositoryDirectories: [assignment.repositoryDirectory] };
    const workspace = await this.workspace(assignment.workspaceId);
    return { ...assignment, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories };
  }

  async permits(assignment: ConversationAssignment, id: string): Promise<boolean> {
    try { return conversationId(await this.resolve(assignment)) === id; }
    catch (error) { if (error instanceof ConversationError) return false; throw error; }
  }
}
