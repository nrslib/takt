import { createHash } from 'node:crypto';
import type { ConversationAssignment } from './schema.js';

export function conversationIdentity(assignment: ConversationAssignment): readonly string[] {
  return assignment.kind === 'workspace'
    ? ['manager', 'workspace', assignment.workspaceId]
    : ['manager', 'repository', assignment.repositoryDirectory];
}

export function conversationId(assignment: ConversationAssignment): string {
  return `manager-${createHash('sha256').update(JSON.stringify(conversationIdentity(assignment)), 'utf8').digest('hex')}`;
}
