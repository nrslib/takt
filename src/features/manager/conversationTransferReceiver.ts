import { z } from 'zod/v4';
import { isAbsolute } from 'node:path';
import { conversationId } from '../../infra/conversations/identity.js';
import { ApprovalSchema, ConversationAssignmentSchema, ManagerConversationAssignmentSchema, ConversationIdSchema, PendingSummarySchema,
  RunningOperationSchema } from '../../infra/conversations/schema.js';
import { GoalQuestionSchema, GoalRecordObjectSchema, GoalSchema } from '../../infra/goals/schema.js';
import type { ConversationState, OutputVersion, PortOutput, SnapshotValue, SnapshotMode } from './conversationPort.js';
import { snapshotItemKey } from './snapshotChanges.js';
import type { ConversationDisplayAssignment } from './conversationPort.js';

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const repository = z.string().refine(isAbsolute);
const version = { revision: sequence, stateSequence: sequence, operationId: z.uuid().nullable() };
const mode = z.enum(['initial', 'delta']);
export const ConversationReadMetadataSchema = z.object({ ...version, transferId: z.uuid(), conversationId: ConversationIdSchema, mode }).strict();
export type ConversationReadMetadata = z.infer<typeof ConversationReadMetadataSchema>;
const stateSchema = z.object({ conversationId: ConversationIdSchema, assignment: ConversationAssignmentSchema,
  revision: sequence, pending: PendingSummarySchema.nullable(), approval: ApprovalSchema.nullable(),
  running: RunningOperationSchema.omit({ owner: true }).nullable(), interrupted: z.boolean() }).strict()
  .superRefine((state, ctx) => {
    if (state.assignment.kind === 'daemon' && (state.pending !== null || state.approval !== null
      || state.running !== null && state.running.kind !== 'message')) {
      ctx.addIssue({ code: 'custom', message: 'Director state contains manager operations' });
    }
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
  z.object({ goalId: z.null(), owner: ManagerConversationAssignmentSchema }).strict(),
]);
const inquirySchema = z.object({ target: targetSchema, question: GoalQuestionSchema.refine((question) =>
  question.recipient === 'human' && question.status === 'pending'), objective: z.string().optional() }).strict()
  .refine((inquiry) => inquiry.target.goalId === null || inquiry.objective !== undefined,
    { message: 'Missing inquiry objective' });
const noticeSchema = z.object({ id: z.string().min(1), message: z.string() }).strict();
const displayAssignmentSchema = z.union([
  z.object({ kind: z.literal('daemon'), repositoryDirectories: z.array(repository).length(0) }).strict(),
  z.object({ kind: z.literal('repository'), repositoryDirectory: repository, repositoryDirectories: z.array(repository) }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId: z.uuid(), name: z.string(), repositoryDirectories: z.array(repository) }).strict(),
]);
const snapshotItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), state: stateSchema }).strict(),
  z.object({ kind: z.literal('assignment'), assignment: displayAssignmentSchema }).strict(),
  z.object({ kind: z.literal('goal'), goal: GoalRecordObjectSchema.pick({ id: true, objective: true, status: true, executionStatus: true })
    .extend({ repositoryDirectory: repository }).strict() }).strict(),
  z.object({ kind: z.literal('inquiry'), inquiry: inquirySchema }).strict(),
  z.object({ kind: z.literal('display_event'), event: z.object({ id: z.string(), message: z.string() }).strict() }).strict(),
  z.object({ kind: z.literal('remove'), key: z.string().min(1) }).strict(),
]);
const operationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), message: z.string() }).strict(),
  z.object({ kind: z.literal('goal_registered'), goal: GoalSchema }).strict(),
  z.object({ kind: z.literal('answer_saved'), answerSaved: z.boolean(), message: z.string() }).strict(),
  z.object({ kind: z.literal('error'), code: z.string(), message: z.string(), answerSaved: z.boolean().optional(),
    permissionAppended: z.boolean().optional() }).strict(),
]);
const outputItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user_message'), operationId: z.uuid(), message: z.string() }).strict(),
  z.object({ kind: z.literal('notice'), ...noticeSchema.shape }).strict(),
  ...(['reply', 'progress'] as const).map((kind) => z.object({ kind: z.literal(kind), operationId: z.uuid(), message: z.string() }).strict()),
  ...(['pending', 'running'] as const).map((kind) => z.object({ kind: z.literal(kind), state: stateSchema }).strict()),
  z.object({ kind: z.literal('inquiry'), target: targetSchema, question: inquirySchema.shape.question }).strict(),
  z.object({ kind: z.literal('result'), operationId: z.uuid(), result: operationResultSchema }).strict(),
]);
const transferSchema = z.object({ protocolVersion: z.literal(1), type: z.literal('event'), conversationId: ConversationIdSchema,
  output: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('transfer_start'), transferId: z.uuid(), purpose: z.enum(['snapshot', 'output']), mode: mode.optional(), ...version }).strict(),
    z.object({ kind: z.literal('transfer_data'), transferId: z.uuid(), itemIndex: sequence, fragmentIndex: sequence,
      finalFragment: z.boolean(), data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
    z.object({ kind: z.literal('transfer_end'), transferId: z.uuid(), itemCount: sequence }).strict(),
    z.object({ kind: z.literal('transfer_error'), transferId: z.uuid(), code: z.string() }).strict(),
  ]) }).strict();
type TransferMetadata = OutputVersion & { transferId: string; conversationId: string; mode?: SnapshotMode };
type Transfer = { metadata: TransferMetadata; purpose: 'snapshot' | 'output'; itemIndex: number;
  fragmentIndex: number; parts: Buffer[]; length: number; assignment?: ConversationDisplayAssignment; seen: Set<string> };

export interface ConversationTransferObserver {
  state(state: ConversationState, version: OutputVersion): void;
  item(item: Exclude<SnapshotValue, { kind: 'state' }>, transferId: string): void;
  remove(key: string, transferId: string): void;
  output(output: Exclude<PortOutput, { kind: 'snapshot' }>, version: OutputVersion): void;
  read(status: 'reading' | 'complete' | 'incomplete', transferId: string, mode: SnapshotMode): void;
}

function validateReadMetadata(actual: ConversationReadMetadata, expected: ConversationReadMetadata): void {
  for (const key of ['revision', 'stateSequence', 'operationId', 'mode'] as const) {
    if (actual[key] !== expected[key]) throw new Error('Read metadata mismatch');
  }
}

export class ConversationTransferReceiver {
  private transfers = new Map<string, Transfer>();
  private awaitingStart = false;
  private snapshot: ConversationReadMetadata | undefined;
  private revision = -1;
  private sequence = -1;
  private completed: { assignment?: ConversationDisplayAssignment } | undefined;

  constructor(private readonly conversationId: string, private readonly observer: ConversationTransferObserver) {}

  expectRead(metadata: ConversationReadMetadata): void {
    if (metadata.conversationId !== this.conversationId) throw new Error('Unexpected conversation');
    if (this.snapshot?.transferId === metadata.transferId) {
      validateReadMetadata(metadata, this.snapshot);
      return;
    }
    if (this.snapshot !== undefined) this.transfers.delete(this.snapshot.transferId);
    this.awaitingStart = true;
    this.snapshot = metadata;
    this.observer.read('reading', metadata.transferId, metadata.mode);
  }

  disconnect(): void {
    this.transfers.clear();
    this.awaitingStart = false;
    if (this.snapshot !== undefined) this.observer.read('incomplete', this.snapshot.transferId, this.snapshot.mode);
  }

  authenticated(): void {
    this.disconnect();
    this.sequence = -1;
    this.snapshot = undefined;
    this.completed = undefined;
  }

  receive(value: unknown): void {
    const event = transferSchema.parse(value);
    if (event.conversationId !== this.conversationId) throw new Error('Unexpected conversation');
    const output = event.output;
    if (output.kind === 'transfer_start') {
      if (this.transfers.has(output.transferId)) throw new Error('Repeated transfer start');
      const metadata = { conversationId: event.conversationId, transferId: output.transferId,
        revision: output.revision, stateSequence: output.stateSequence, operationId: output.operationId, mode: output.mode };
      if (output.purpose === 'snapshot') {
        const readMetadata = ConversationReadMetadataSchema.parse(metadata);
        if (readMetadata.mode === 'delta' && this.completed === undefined) throw new Error('Delta before initial snapshot');
        if (this.awaitingStart) {
          if (output.transferId !== this.snapshot!.transferId) return;
          validateReadMetadata(readMetadata, this.snapshot!);
          this.awaitingStart = false;
        } else {
          if (metadata.revision < this.revision || metadata.stateSequence < this.sequence
            || this.snapshot !== undefined && metadata.stateSequence < this.snapshot.stateSequence) return;
          if (this.snapshot !== undefined) this.transfers.delete(this.snapshot.transferId);
          this.snapshot = readMetadata;
          this.observer.read('reading', output.transferId, readMetadata.mode);
        }
      }
      if (output.purpose === 'output' && output.mode !== undefined) throw new Error('Output cannot have snapshot mode');
      if (output.purpose === 'output' && [...this.transfers.values()].some((transfer) => transfer.purpose === 'output')) {
        throw new Error('Overlapping output transfers');
      }
      this.transfers.set(output.transferId, { metadata, purpose: output.purpose, itemIndex: 0, fragmentIndex: 0, parts: [], length: 0,
        seen: new Set(),
        assignment: output.mode === 'delta' ? this.completed?.assignment : undefined });
      return;
    }
    const transfer = this.transfers.get(output.transferId);
    if (transfer === undefined) return;
    try {
      if (output.kind === 'transfer_error') {
        this.transfers.delete(output.transferId);
        if (this.snapshot?.transferId === output.transferId) this.observer.read('incomplete', output.transferId, this.snapshot.mode);
        return;
      }
      if (output.kind === 'transfer_end') {
        if (transfer.fragmentIndex !== 0 || output.itemCount !== transfer.itemIndex
          || (transfer.purpose === 'snapshot' ? transfer.metadata.mode === 'initial' && output.itemCount < 1 : output.itemCount !== 1)) throw new Error('Incomplete transfer');
        this.transfers.delete(output.transferId);
        if (output.transferId === this.snapshot?.transferId) {
          this.completed = { assignment: transfer.assignment };
          this.observer.read('complete', output.transferId, this.snapshot.mode);
        }
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
        if (transfer.metadata.mode === 'initial' && (transfer.itemIndex === 0) !== (parsed.kind === 'state')) throw new Error('Snapshot must start with state');
        const key = parsed.kind === 'remove' ? parsed.key : snapshotItemKey(parsed);
        if (transfer.seen.has(key)) throw new Error('Repeated snapshot key');
        transfer.seen.add(key);
        if (parsed.kind === 'remove') {
          if (transfer.metadata.mode !== 'delta' || key === 'state' || key === 'assignment') {
            throw new Error('Invalid snapshot removal');
          }
          this.observer.remove(key, output.transferId);
          transfer.itemIndex++;
          return;
        }
        if (parsed.kind === 'state') this.applyState(parsed.state, transfer.metadata);
        else if (this.snapshot?.transferId === output.transferId) {
          if (parsed.kind === 'assignment') {
            const identity = parsed.assignment.kind === 'daemon' ? { kind: 'daemon' as const } : parsed.assignment.kind === 'workspace'
              ? { kind: 'workspace' as const, workspaceId: parsed.assignment.workspaceId }
              : { kind: 'repository' as const, repositoryDirectory: parsed.assignment.repositoryDirectory };
            if (conversationId(identity) !== this.conversationId) throw new Error('Display assignment mismatch');
            transfer.assignment = parsed.assignment;
          } else if (parsed.kind === 'inquiry' && parsed.inquiry.target.goalId === null) {
            if (conversationId(parsed.inquiry.target.owner) !== this.conversationId) throw new Error('Inquiry owner mismatch');
          }
          const directory = parsed.kind === 'goal' ? parsed.goal.repositoryDirectory
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
      if (this.snapshot?.transferId === output.transferId) this.observer.read('incomplete', output.transferId, this.snapshot.mode);
      throw error;
    }
  }

  private applyState(state: ConversationState, metadata: TransferMetadata): void {
    if (state.conversationId !== this.conversationId || state.revision !== metadata.revision
      || state.running !== null && state.running.operationId !== metadata.operationId) throw new Error('State metadata mismatch');
    if (metadata.revision < this.revision || metadata.stateSequence <= this.sequence) return;
    this.revision = metadata.revision;
    this.sequence = metadata.stateSequence;
    this.observer.state(state, metadata);
  }
}
