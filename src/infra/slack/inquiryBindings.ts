import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod/v4';
import { ManagerConversationAssignmentSchema } from '../conversations/schema.js';
import { GoalIdSchema } from '../goals/schema.js';
import { readPrivateFile, writePrivateFile } from '../daemon/privateFile.js';
import { FileAsyncLock } from '../daemon/lock.js';

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
  private readonly path: string;

  constructor(configDirectory: string, repositoryDirectory: string) {
    this.path = join(configDirectory, 'slack-inquiries', `${createHash('sha256').update(repositoryDirectory).digest('hex')}.json`);
  }

  async find(channelId: string, parentTs: string): Promise<SlackInquiryBinding | undefined> {
    return (await this.read()).find((binding) => binding.channelId === channelId && binding.parentTs === parentTs);
  }

  async question(channelId: string, target: SlackInquiryBinding['target'], questionId: string): Promise<SlackInquiryBinding | undefined> {
    const key = slackInquiryKey(target, questionId);
    return (await this.read()).find((binding) => binding.channelId === channelId && slackInquiryKey(binding.target, binding.questionId) === key);
  }

  async save(value: SlackInquiryBinding): Promise<void> {
    const binding = bindingSchema.parse(value);
    await new FileAsyncLock().exclusive(`${this.path}.lock`, async () => {
      const bindings = await this.read();
      const key = slackInquiryKey(binding.target, binding.questionId);
      if (bindings.some((entry) => entry.channelId === binding.channelId
        && (entry.parentTs === binding.parentTs || slackInquiryKey(entry.target, entry.questionId) === key))) {
        throw new Error('Slack inquiry is already bound');
      }
      const content = JSON.stringify([...bindings, binding]);
      if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Slack inquiry bindings exceed storage capacity');
      await writePrivateFile(this.path, content);
    }, { signal: new AbortController().signal, timeoutMs: 5000 });
  }

  private async read(): Promise<SlackInquiryBinding[]> {
    const content = await readPrivateFile(this.path, 1024 * 1024);
    return content === undefined ? [] : bindingsSchema.parse(JSON.parse(content.toString('utf8')) as unknown);
  }
}
