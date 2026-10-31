import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod/v4';
import { ManagerConversationAssignmentSchema } from '../conversations/schema.js';
import { GoalIdSchema } from '../goals/schema.js';
import { ensurePrivateDirectory, readPrivateFileState } from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';
import { writeFileAtomic } from '../config/project/sessionStore.js';

const targetSchema = z.union([
  z.object({ goalId: GoalIdSchema, repositoryDirectory: z.string().refine(isAbsolute) }).strict(),
  z.object({ goalId: z.null(), owner: ManagerConversationAssignmentSchema }).strict(),
]);
const identity = { channelId: z.string().min(1), target: targetSchema, questionId: z.uuid() };
const bindingSchema = z.object({ ...identity, parentTs: z.string().min(1) }).strict();
const bindingsSchema = z.array(bindingSchema);
export type SlackInquiryBinding = z.infer<typeof bindingSchema>;

export function slackInquiryKey(target: SlackInquiryBinding['target'], questionId: string): string {
  const owner = target.goalId !== null ? target.repositoryDirectory : target.owner.kind === 'workspace'
    ? ['workspace', target.owner.workspaceId] : ['repository', target.owner.repositoryDirectory];
  return JSON.stringify([target.goalId, owner, questionId]);
}

export class SlackInquiryBindings {
  private readonly directory: string;
  private readonly path: string;

  constructor(configDirectory: string, repositoryDirectory: string) {
    this.directory = join(configDirectory, 'slack-inquiries');
    this.path = join(this.directory, `${createHash('sha256').update(repositoryDirectory).digest('hex')}.json`);
  }

  find(channelId: string, parentTs: string): SlackInquiryBinding | undefined {
    return this.read().find((binding) => binding.channelId === channelId && binding.parentTs === parentTs);
  }

  question(channelId: string, target: SlackInquiryBinding['target'], questionId: string): SlackInquiryBinding | undefined {
    const key = slackInquiryKey(target, questionId);
    return this.read().find((binding) => binding.channelId === channelId && slackInquiryKey(binding.target, binding.questionId) === key);
  }

  save(value: SlackInquiryBinding): void {
    const binding = bindingSchema.parse(value);
    const bindings = this.read();
    const key = slackInquiryKey(binding.target, binding.questionId);
    if (bindings.some((entry) => entry.channelId === binding.channelId
      && (entry.parentTs === binding.parentTs || slackInquiryKey(entry.target, entry.questionId) === key))) {
      throw new Error('Slack inquiry is already bound');
    }
    this.write([...bindings, binding]);
  }

  private write(bindings: SlackInquiryBinding[]): void {
    ensurePrivateDirectory(this.directory);
    assertSafePath(this.path, false);
    writeFileAtomic(this.path, JSON.stringify(bindings), 0o600);
  }

  private read(): SlackInquiryBinding[] {
    assertSafePath(this.directory, true);
    if (lstatOrUndefined(this.directory) === undefined) return [];
    const snapshot = readPrivateFileState(this.path);
    if (!('content' in snapshot)) return [];
    return bindingsSchema.parse(JSON.parse(snapshot.content.toString('utf8')) as unknown);
  }
}
