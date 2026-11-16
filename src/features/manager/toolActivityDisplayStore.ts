import type { ConversationIpcClient } from './conversationIpcClient.js';
import { ToolActivityDisplay } from '../../shared/ui/ToolActivityDisplay.js';

type ToolActivityClient = Pick<ConversationIpcClient, 'getSnapshot' | 'subscribe' | 'onOutput'>;
export function toolTurnKey(turn: { operationId: string; generation?: number }): string {
  return JSON.stringify([turn.operationId, turn.generation]);
}
export interface ShownToolActivity { readonly display: ToolActivityDisplay; readonly ready: boolean }

export class ToolActivityDisplayStore {
  private value: ShownToolActivity = { display: new ToolActivityDisplay('silent', false, () => {}, false, true), ready: false };
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | undefined;
  /** 表示中のターン。idle になっても、次のターンが始まるまで直前のターンを表示する（main と同じ）。 */
  private shown: string | undefined;
  private initialReadComplete = false;

  constructor(private readonly client: ToolActivityClient) {}

  getSnapshot = (): ShownToolActivity => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.detach === undefined) {
      const observe = (): void => {
        const snapshot = this.client.getSnapshot();
        if (snapshot.connection !== 'connected') this.initialReadComplete = false;
        else if (snapshot.readStatus === 'complete') this.initialReadComplete = true;
        const ready = snapshot.connection === 'connected' && this.initialReadComplete;
        const running = snapshot.state?.running;
        const turn = running == null ? undefined : toolTurnKey(running);
        const entries = this.value.display.history.entries();
        if (!ready || turn !== undefined && turn !== this.shown) {
          this.shown = turn;
          this.value = { display: new ToolActivityDisplay('silent', false, () => {}, false, true), ready };
        } else if (turn === undefined && entries.some((entry) => entry.status === 'running')) {
          const display = new ToolActivityDisplay('silent', false, () => {}, false, true);
          for (const entry of entries) if (entry.status !== 'running') display.upsert(entry);
          this.value = { display, ready };
        } else this.value = { ...this.value, ready };
        if (ready && snapshot.readStatus === 'complete') {
          const histories = snapshot.items.flatMap((item) => item.kind === 'tool_history' ? [item.history] : []);
          const history = turn === undefined ? histories.at(-1) : histories.find((candidate) => toolTurnKey(candidate) === turn);
          if (history !== undefined && (this.shown === undefined || this.shown === toolTurnKey(history))) {
            this.shown = toolTurnKey(history);
            for (const entry of history.history.entries) {
              if (entry.status === 'running' && turn === undefined) continue;
              if (this.value.display.history.get(entry.key) === undefined) this.value.display.upsert(entry);
            }
          }
        }
        this.notify();
      };
      const state = this.client.subscribe(observe);
      const output = this.client.onOutput((event) => {
        if (event.kind === 'tool_started') this.value.display.upsert(event.entry);
        else if (event.kind === 'tool_output') this.value.display.appendOutput(event.key, event.text, event.tail ?? '');
        else if (event.kind === 'tool_completed') this.value.display.upsert(event.entry);
        else return;
        this.value = { ...this.value };
        this.notify();
      });
      this.detach = () => { state(); output(); };
      observe();
    }
    return () => { this.listeners.delete(listener); if (this.listeners.size === 0) { this.detach?.(); this.detach = undefined; this.initialReadComplete = false; } };
  };
  private notify(): void { for (const listener of this.listeners) listener(); }
}
