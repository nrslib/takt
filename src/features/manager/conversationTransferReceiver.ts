import { z } from 'zod/v4';
import { isAbsolute } from 'node:path';
import { conversationId } from '../../infra/conversations/identity.js';
import { ApprovalSchema, ConversationAssignmentSchema, ConversationIdSchema, PendingSummarySchema,
  RunningOperationSchema } from '../../infra/conversations/schema.js';
import { GoalNotificationInputSchema, GoalQuestionSchema, GoalRecordObjectSchema, GoalSchema } from '../../infra/goals/schema.js';
import type { ConversationState, OutputVersion, PortOutput, SnapshotItem } from './conversationPort.js';
import type { ManagerAssignment } from './startupResolution.js';

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const repository = z.string().refine(isAbsolute);
const version = { revision: sequence, stateSequence: sequence, operationId: z.uuid().nullable() };
export const ConversationReadMetadataSchema = z.object({ ...version, transferId: z.uuid(), conversationId: ConversationIdSchema }).strict();
export type ConversationReadMetadata = z.infer<typeof ConversationReadMetadataSchema>;
const stateSchema = z.object({ conversationId: ConversationIdSchema, assignment: ConversationAssignmentSchema,
  revision: sequence, pending: PendingSummarySchema.nullable(), approval: ApprovalSchema.nullable(),
  running: RunningOperationSchema.omit({ owner: true }).nullable(), interrupted: z.boolean() }).strict()
  .superRefine((state, ctx) => {
    if (conversationId(state.assignment) !== state.conversationId || state.pending !== null && state.pending.revision !== state.revision) {
      ctx.addIssue({ code: 'custom', message: 'Inconsistent conversation state' });
    }
    const assignment = state.assignment;
    if (assignment.kind === 'repository' && [state.pending, state.approval].some((value) =>
      value !== null && value.repositoryDirectory !== assignment.repositoryDirectory)) {
      ctx.addIssue({ code: 'custom', message: 'Inconsistent repository state' });
    }
  });
const targetSchema = z.union([
  z.object({ goalId: z.uuid(), repositoryDirectory: repository }).strict(),
  z.object({ goalId: z.null(), owner: ConversationAssignmentSchema }).strict(),
]);
const inquirySchema = z.object({ target: targetSchema, question: GoalQuestionSchema.refine((question) =>
  question.recipient === 'human' && question.status === 'pending'), objective: z.string().optional() }).strict()
  .refine((inquiry) => inquiry.target.goalId === null || inquiry.objective !== undefined,
    { message: 'Missing inquiry objective' });
const noticeSchema = z.object({ id: z.string().min(1), message: z.string() }).strict();
const displayAssignmentSchema = z.union([
  z.object({ kind: z.literal('repository'), repositoryDirectory: repository, repositoryDirectories: z.array(repository) }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId: z.uuid(), name: z.string(), repositoryDirectories: z.array(repository) }).strict(),
]);
const snapshotItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), state: stateSchema }).strict(),
  z.object({ kind: z.literal('assignment'), assignment: displayAssignmentSchema }).strict(),
  z.object({ kind: z.literal('goal'), goal: GoalRecordObjectSchema.pick({ id: true, objective: true, status: true, executionStatus: true })
    .extend({ repositoryDirectory: repository }).strict() }).strict(),
  z.object({ kind: z.literal('inquiry'), inquiry: inquirySchema }).strict(),
  z.object({ kind: z.literal('notice'), notice: noticeSchema.extend({ repositoryDirectory: repository, project: z.string(),
    goalId: z.uuid(), objective: z.string(), kind: GoalNotificationInputSchema.shape.kind.exclude(['question']), recordedAt: z.iso.datetime() }).strict() }).strict(),
  z.object({ kind: z.literal('display_event'), event: z.object({ id: z.string(), message: z.string(), suppressInitialDisplay: z.literal(true).optional() }).strict() }).strict(),
]);
const operationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), message: z.string() }).strict(),
  z.object({ kind: z.literal('goal_registered'), goal: GoalSchema }).strict(),
  z.object({ kind: z.literal('answer_saved'), answerSaved: z.boolean(), message: z.string() }).strict(),
  z.object({ kind: z.literal('error'), code: z.string(), message: z.string(), answerSaved: z.boolean().optional(),
    permissionAppended: z.boolean().optional() }).strict(),
]);
const outputItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notice'), ...noticeSchema.shape }).strict(),
  ...(['reply', 'progress'] as const).map((kind) => z.object({ kind: z.literal(kind), operationId: z.uuid(), message: z.string() }).strict()),
  ...(['pending', 'running'] as const).map((kind) => z.object({ kind: z.literal(kind), state: stateSchema }).strict()),
  z.object({ kind: z.literal('inquiry'), target: targetSchema, question: inquirySchema.shape.question }).strict(),
  z.object({ kind: z.literal('result'), operationId: z.uuid(), result: operationResultSchema }).strict(),
]);
const transferSchema = z.object({ protocolVersion: z.literal(1), type: z.literal('event'), conversationId: ConversationIdSchema,
  output: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('transfer_start'), transferId: z.uuid(), purpose: z.enum(['snapshot', 'output']), ...version }).strict(),
    z.object({ kind: z.literal('transfer_data'), transferId: z.uuid(), itemIndex: sequence, fragmentIndex: sequence,
      finalFragment: z.boolean(), data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
    z.object({ kind: z.literal('transfer_end'), transferId: z.uuid(), itemCount: sequence }).strict(),
    z.object({ kind: z.literal('transfer_error'), transferId: z.uuid(), code: z.string() }).strict(),
  ]) }).strict();
type Transfer = { metadata: ConversationReadMetadata; purpose: 'snapshot' | 'output'; itemIndex: number;
  fragmentIndex: number; parts: Buffer[]; length: number; assignment?: ManagerAssignment };

export interface ConversationTransferObserver {
  state(state: ConversationState, version: OutputVersion): void;
  item(item: Exclude<SnapshotItem, { kind: 'state' }>, transferId: string): void;
  output(output: Exclude<PortOutput, { kind: 'snapshot' }>, version: OutputVersion): void;
  read(status: 'reading' | 'complete' | 'incomplete', transferId: string): void;
}

export class ConversationTransferReceiver {
  private transfers = new Map<string, Transfer>();
  private expected: ConversationReadMetadata | undefined;
  private snapshot: string | undefined;
  private revision = -1;
  private sequence = -1;
  private snapshotSequence = -1;

  constructor(private readonly conversationId: string, private readonly observer: ConversationTransferObserver) {}

  expectRead(metadata: ConversationReadMetadata): void {
    if (metadata.conversationId !== this.conversationId) throw new Error('Unexpected conversation');
    if (this.snapshot !== undefined) this.transfers.delete(this.snapshot);
    this.expected = metadata;
    this.snapshot = metadata.transferId;
    this.snapshotSequence = metadata.stateSequence;
    this.observer.read('reading', metadata.transferId);
  }

  disconnect(): void {
    this.transfers.clear();
    this.expected = undefined;
    if (this.snapshot !== undefined) this.observer.read('incomplete', this.snapshot);
  }

  authenticated(): void {
    this.disconnect();
    this.sequence = -1;
    this.snapshotSequence = -1;
  }

  receive(value: unknown): void {
    const event = transferSchema.parse(value);
    if (event.conversationId !== this.conversationId) throw new Error('Unexpected conversation');
    const output = event.output;
    if (output.kind === 'transfer_start') {
      if (this.transfers.has(output.transferId)) throw new Error('Repeated transfer start');
      const metadata = { conversationId: event.conversationId, transferId: output.transferId,
        revision: output.revision, stateSequence: output.stateSequence, operationId: output.operationId };
      if (output.purpose === 'snapshot') {
        if (this.expected !== undefined) {
          if (output.transferId !== this.expected.transferId) return;
          for (const key of ['revision', 'stateSequence', 'operationId'] as const) {
            if (metadata[key] !== this.expected[key]) throw new Error('Read metadata mismatch');
          }
          this.expected = undefined;
        } else {
          if (metadata.revision < this.revision || metadata.stateSequence < this.sequence || metadata.stateSequence < this.snapshotSequence) return;
          if (this.snapshot !== undefined) this.transfers.delete(this.snapshot);
          this.snapshot = output.transferId;
          this.snapshotSequence = metadata.stateSequence;
          this.observer.read('reading', output.transferId);
        }
      }
      if (output.purpose === 'output' && [...this.transfers.values()].some((transfer) => transfer.purpose === 'output')) {
        throw new Error('Overlapping output transfers');
      }
      this.transfers.set(output.transferId, { metadata, purpose: output.purpose, itemIndex: 0, fragmentIndex: 0, parts: [], length: 0 });
      return;
    }
    const transfer = this.transfers.get(output.transferId);
    if (transfer === undefined) return;
    try {
      if (output.kind === 'transfer_error') {
        this.transfers.delete(output.transferId);
        if (this.snapshot === output.transferId) this.observer.read('incomplete', output.transferId);
        return;
      }
      if (output.kind === 'transfer_end') {
        if (transfer.fragmentIndex !== 0 || output.itemCount !== transfer.itemIndex
          || (transfer.purpose === 'snapshot' ? output.itemCount < 1 : output.itemCount !== 1)) throw new Error('Incomplete transfer');
        this.transfers.delete(output.transferId);
        if (output.transferId === this.snapshot) this.observer.read('complete', output.transferId);
        return;
      }
      if (output.itemIndex !== transfer.itemIndex || output.fragmentIndex !== transfer.fragmentIndex || output.data.length === 0) {
        throw new Error('Out of order transfer fragment');
      }
      const bytes = Buffer.from(output.data, 'base64');
      if (bytes.toString('base64') !== output.data) throw new Error('Noncanonical base64');
      transfer.parts.push(bytes);
      transfer.length += bytes.length;
      transfer.fragmentIndex++;
      if (!output.finalFragment) return;
      const item: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(Buffer.concat(transfer.parts, transfer.length)));
      transfer.parts = [];
      transfer.length = 0;
      transfer.fragmentIndex = 0;
      if (transfer.purpose === 'snapshot') {
        const parsed = snapshotItemSchema.parse(item);
        if ((transfer.itemIndex === 0) !== (parsed.kind === 'state')) throw new Error('Snapshot must start with state');
        if (parsed.kind === 'state') this.applyState(parsed.state, transfer.metadata);
        else if (this.snapshot === output.transferId) {
          if (parsed.kind === 'assignment') {
            const identity = parsed.assignment.kind === 'workspace'
              ? { kind: 'workspace' as const, workspaceId: parsed.assignment.workspaceId }
              : { kind: 'repository' as const, repositoryDirectory: parsed.assignment.repositoryDirectory };
            if (conversationId(identity) !== this.conversationId) throw new Error('Display assignment mismatch');
            transfer.assignment = parsed.assignment;
          } else if (parsed.kind === 'inquiry' && parsed.inquiry.target.goalId === null) {
            if (conversationId(parsed.inquiry.target.owner) !== this.conversationId) throw new Error('Inquiry owner mismatch');
          }
          const directory = parsed.kind === 'goal' ? parsed.goal.repositoryDirectory : parsed.kind === 'notice' ? parsed.notice.repositoryDirectory
            : parsed.kind === 'inquiry' && parsed.inquiry.target.goalId !== null ? parsed.inquiry.target.repositoryDirectory : undefined;
          if (directory !== undefined && (transfer.assignment === undefined || !transfer.assignment.repositoryDirectories.includes(directory))) {
            throw new Error('Display repository outside assignment');
          }
          this.observer.item(parsed, output.transferId);
        }
      } else {
        if (transfer.itemIndex !== 0) throw new Error('Repeated output item');
        const parsed = outputItemSchema.parse(item);
        if (parsed.kind === 'pending' || parsed.kind === 'running') this.applyState(parsed.state, transfer.metadata);
        else {
          if ('operationId' in parsed && parsed.operationId !== transfer.metadata.operationId) throw new Error('Output operation mismatch');
          this.observer.output(parsed, transfer.metadata);
        }
      }
      transfer.itemIndex++;
    } catch (error) {
      this.transfers.delete(output.transferId);
      if (this.snapshot === output.transferId) this.observer.read('incomplete', output.transferId);
      throw error;
    }
  }

  private applyState(state: ConversationState, metadata: ConversationReadMetadata): void {
    if (state.conversationId !== this.conversationId || state.revision !== metadata.revision
      || state.running !== null && state.running.operationId !== metadata.operationId) throw new Error('State metadata mismatch');
    if (metadata.revision < this.revision || metadata.stateSequence <= this.sequence) return;
    this.revision = metadata.revision;
    this.sequence = metadata.stateSequence;
    this.observer.state(state, metadata);
  }
}
