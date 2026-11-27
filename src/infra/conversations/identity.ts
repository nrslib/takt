import { createHash } from 'node:crypto';
import type { ConversationAssignment } from './schema.js';

export function conversationIdentity(assignment: ConversationAssignment): readonly string[] {
  if (assignment.kind === 'daemon') return ['director', 'daemon'];
  return assignment.kind === 'workspace'
    ? ['manager', 'workspace', assignment.workspaceId]
    : ['manager', 'repository', assignment.repositoryDirectory];
}

export function conversationId(assignment: ConversationAssignment): string {
  return `${assignment.kind === 'daemon' ? 'director' : 'manager'}-${createHash('sha256').update(JSON.stringify(conversationIdentity(assignment)), 'utf8').digest('hex')}`;
}
