import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { createConversationService } from '../../features/manager/conversationService.js';
import { createTuiConversationPort } from '../../features/manager/tuiConversationPort.js';
import { createManagerTurnExecutor } from '../../features/manager/turnExecutor.js';
import type { ManagerConversationPlan } from '../../features/manager/conversationPlan.js';
import type { ConversationClientSnapshot } from '../../features/manager/conversationIpcClient.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import type { ConversationCommand, ConversationDelivery, OperationResult, OutputVersion, PortOutput, SnapshotRead, Submission } from '../../features/manager/conversationPort.js';
import { ConversationError } from '../../features/manager/conversationErrors.js';

/** UI tests use the real service/executor; transport validation belongs to client tests. */
export class ManagerServiceClient {
  private view: ConversationClientSnapshot = { connection: 'connecting', readStatus: 'reading', state: null, items: [], error: null };
  private listeners = new Set<() => void>();
  private outputs = new Set<(output: Exclude<PortOutput, { kind: 'snapshot' }>) => void>();
  private attachmentId: string | undefined;
  private closed = false;
  private admissions = 0;
  private stateSequence = -1;
  private pendingOutputs: Array<{ output: Exclude<PortOutput, { kind: 'snapshot' }>; version?: OutputVersion }> = [];
  readonly results: OperationResult[] = [];
  private readonly actor = { namespace: 'local', id: 'operator' };
  private readonly service;
  private readonly delivery: ConversationDelivery;
  private readonly configDirectory = getGlobalConfigDir();
  readonly ready: Promise<void>;
  getSnapshot = (): ConversationClientSnapshot => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  onOutput = (listener: (output: Exclude<PortOutput, { kind: 'snapshot' }>) => void): (() => void) => {
    this.outputs.add(listener);
    return () => { this.outputs.delete(listener); };
  };
  deliver(output: Exclude<PortOutput, { kind: 'snapshot' }>, version?: OutputVersion): void {
    if (this.admissions > 0) { this.pendingOutputs.push({ output, version }); return; }
    if (output.kind === 'pending' || output.kind === 'running') {
      if (version === undefined || version.stateSequence > this.stateSequence) {
        this.stateSequence = version?.stateSequence ?? this.stateSequence;
        this.update({ state: output.state });
      }
    }
    if (output.kind === 'result') this.results.push(output.result);
    for (const listener of this.outputs) listener(output);
  }
  constructor(readonly options: { cwd: string; plan: ManagerConversationPlan; assignment?: ConversationAssignment }) {
    const input = options;
    const configDirectory = this.configDirectory;
    const plan = input.plan;
    let executor: ReturnType<typeof createManagerTurnExecutor> | undefined;
    const service = createConversationService({ configDirectory,
      owner: { pid: process.pid, identity: { startTime: 'ui-test' }, version: 'test', cliPath: import.meta.filename },
      runtime: { resolve: async () => ({ provider: plan.ctx.providerType, model: plan.ctx.model ?? null,
        language: plan.ctx.lang, contextKey: 'ui-test', executor: executor ??= createManagerTurnExecutor(input.cwd, plan) }), close: async () => {} },
      onDomainChange() {},
    });
    this.service = service;
    this.delivery = { deliver: async (_id: string, output: PortOutput, version: OutputVersion) => {
      if (this.closed) return { kind: 'unavailable' as const, reason: 'closed' };
      if (output.kind === 'snapshot') await this.read(output.read);
      else {
        this.deliver(output, version);
      }
      return { kind: 'delivered' as const };
    } };
    this.ready = this.open();
    void this.ready.catch((error: unknown) => this.update({ connection: 'disconnected', readStatus: 'incomplete',
      error: error instanceof Error ? error.message : String(error) }));
  }
  private async open(): Promise<void> {
    if (this.attachmentId !== undefined) this.service.detach(this.attachmentId);
    this.update({ connection: 'connecting', readStatus: 'reading' });
    const { cwd, assignment, plan } = this.options;
    const resolved = await createTuiConversationPort(this.configDirectory, this.delivery).resolve(assignment
      ?? { kind: 'repository', repositoryDirectory: cwd });
    const opened = await this.service.open({ ...resolved, agentOverrides: { provider: plan.ctx.providerType, model: plan.ctx.model } }, this.delivery);
    this.attachmentId = opened.attachmentId;
    // A failed transfer leaves the attachment connected and can be refreshed.
    await this.read(opened.read).catch(() => {});
    this.update({ connection: 'connected' });
  }
  private update(change: Partial<ConversationClientSnapshot>): void {
    this.view = { ...this.view, ...change };
    for (const listener of this.listeners) listener();
  }
  private async read(read: SnapshotRead): Promise<void> {
    this.update({ readStatus: 'reading' });
    const items: ConversationClientSnapshot['items'][number][] = [];
    try {
      for await (const item of read.items) {
        if (item.kind === 'state') {
          if (item.state.conversationId !== this.view.state?.conversationId || read.stateSequence > this.stateSequence) {
            this.stateSequence = read.stateSequence;
            this.update({ state: item.state });
          }
        }
        else { items.push(item); this.update({ items: [...items] }); }
      }
      this.update({ items, readStatus: 'complete', error: null });
    } catch (error) {
      this.update({ readStatus: 'incomplete' });
      throw error;
    }
  }
  async submit(command: ConversationCommand, onAccepted?: (operationId: string) => void): Promise<Submission> {
    if (this.closed || this.view.connection !== 'connected' || this.attachmentId === undefined) {
      return { kind: 'error', code: 'unavailable_attachment', message: 'Conversation is disconnected' };
    }
    this.admissions++;
    try {
      const result = await this.service.submit({ attachmentId: this.attachmentId, requestId: randomUUID(), speaker: this.actor, command });
      if (result.kind === 'accepted') onAccepted?.(result.operationId);
      if (result.kind === 'error' && result.code === 'invalid_assignment') await this.open();
      return result;
    } finally {
      this.admissions--;
      if (this.admissions === 0) for (const { output, version } of this.pendingOutputs.splice(0)) this.deliver(output, version);
    }
  }
  async refresh(): Promise<void> {
    await this.ready;
    if (this.closed || this.attachmentId === undefined) return;
    try { await this.read(await this.service.snapshot(this.attachmentId)).catch(() => {}); }
    catch (error) {
      if (error instanceof ConversationError && error.code === 'invalid_assignment') await this.open();
      else throw error;
    }
  }
  close(): void {
    this.closed = true;
    if (this.attachmentId !== undefined) this.service.detach(this.attachmentId);
  }
  async dispose(): Promise<void> {
    this.close();
    await this.service.close();
  }
}

export async function submitAndWait(client: ManagerServiceClient, command: ConversationCommand): Promise<OperationResult | Submission> {
  await client.ready;
  let operationId: string | undefined;
  let resolve!: (result: OperationResult) => void;
  const completion = new Promise<OperationResult>((finish) => { resolve = finish; });
  const unsubscribe = client.onOutput((output) => {
    if (output.kind === 'result' && output.operationId === operationId) resolve(output.result);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await client.submit(command, (id) => { operationId = id; });
    if (result.kind !== 'accepted') return result;
    return await Promise.race([completion, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Conversation operation did not finish')), 5000);
    })]);
  } finally { clearTimeout(timer); unsubscribe(); }
}

type CommandSpy = ReturnType<typeof vi.fn<(command: ConversationCommand) => Promise<OperationResult> | undefined>>;
const commandSpies = new WeakMap<ManagerServiceClient, Map<ConversationCommand['kind'], CommandSpy>>();
export function spyConversationCommand(client: ManagerServiceClient, kind: ConversationCommand['kind']): CommandSpy {
  let spies = commandSpies.get(client);
  if (spies === undefined) {
    spies = new Map();
    commandSpies.set(client, spies);
    const implementation = vi.isMockFunction(client.submit) ? vi.mocked(client.submit).getMockImplementation()! : client.submit;
    const original = implementation.bind(client);
    const handlers = spies;
    vi.spyOn(client, 'submit').mockImplementation(async (command, onAccepted) => {
      const completion = handlers.get(command.kind)?.(command);
      if (completion === undefined) return original(command, onAccepted);
      const operationId = randomUUID();
      onAccepted?.(operationId);
      void completion.then((result) => client.deliver({ kind: 'result', operationId, result }));
      return { kind: 'accepted', operationId };
    });
  }
  const operation = vi.fn<(command: ConversationCommand) => Promise<OperationResult> | undefined>();
  spies.set(kind, operation);
  return operation;
}
