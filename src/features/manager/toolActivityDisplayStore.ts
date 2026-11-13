import type { ConversationIpcClient } from './conversationIpcClient.js';
import type { ToolActivityTurnUpdate } from '../../shared/tool-activity/types.js';
import { ToolActivityDisplay } from '../../shared/ui/ToolActivityDisplay.js';

type ToolActivityClient = Pick<ConversationIpcClient, 'getSnapshot' | 'subscribe' | 'onOutput'>;

export function toolTurnKey(turn: { operationId: string; generation?: number }): string {
  return JSON.stringify([turn.operationId, turn.generation]);
}

/** 表示中のツール履歴。display は差分の適用で中身が変わるので、変わるたびに新しい値として公開する。 */
export interface ShownToolActivity {
  readonly display: ToolActivityDisplay;
}

interface Shown {
  readonly turn: string | undefined;
  readonly withRunning: boolean;
  readonly value: ShownToolActivity;
}

function emptyDisplay(): ToolActivityDisplay {
  return new ToolActivityDisplay('silent', false, () => {}, false);
}

/**
 * 会話クライアントが確定したツール履歴を、表示用の ToolActivityDisplay として持ち続ける外部ストア。
 * 差分は手元の表示へ適用し、ターンの切り替え・再接続・確定で起点が合わなくなったときだけ、確定した履歴全体から作り直す。
 */
export class ToolActivityDisplayStore {
  private shown: Shown = { turn: undefined, withRunning: false, value: { display: emptyDisplay() } };
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | undefined;

  constructor(private readonly client: ToolActivityClient) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.detach === undefined) {
      const unsubscribeState = this.client.subscribe(() => this.notify());
      const unsubscribeOutput = this.client.onOutput((output) => {
        if (output.kind === 'tool_history_update') this.apply(output.update);
      });
      this.detach = () => { unsubscribeState(); unsubscribeOutput(); };
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.detach?.();
      this.detach = undefined;
    };
  };

  /** クライアントの現在の状態に合う表示を返す。表示が合っていれば同じ値を返す。 */
  getSnapshot = (): ShownToolActivity => {
    const snapshot = this.client.getSnapshot();
    const running = snapshot.state?.running;
    const tools = snapshot.items.find((item) => item.kind === 'tool_history')?.history;
    const history = tools !== undefined && (running == null
      || tools.operationId === running.operationId && tools.generation === running.generation) ? tools : undefined;
    const turn = history === undefined ? undefined : toolTurnKey(history);
    const withRunning = history !== undefined && !history.finished && running != null;
    const shown = this.shown;
    // クライアントは差分を配送してから確定した状態を公開するので、その間は表示の方が先に進んでいる。
    if (shown.turn === turn && shown.withRunning === withRunning
      && (history === undefined || shown.value.display.history.currentSequence >= history.history.sequence)) return shown.value;
    const display = emptyDisplay();
    if (history !== undefined) {
      display.restore({ ...history.history, entries: history.history.entries.filter((entry) => entry.status !== 'running' || withRunning) });
    }
    this.shown = { turn, withRunning, value: { display } };
    return this.shown.value;
  };

  private apply(update: ToolActivityTurnUpdate): void {
    const shown = this.shown;
    // 起点が合わない差分は適用しない。確定した履歴が届いた時点で、getSnapshot が履歴全体から作り直す。
    if (!shown.withRunning || shown.turn !== toolTurnKey(update) || !shown.value.display.applyUpdate(update)) return;
    this.shown = { ...shown, value: { display: shown.value.display } };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
