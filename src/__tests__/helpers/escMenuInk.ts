import { vi } from 'vitest';
import type { ConversationViewProps } from '../../features/tui/ConversationView.js';
import type { TuiSubmission } from '../../features/tui/tuiConversation.js';

const inkFrames = vi.hoisted(() => ({
  frames: [] as Array<{
    props: ConversationViewProps;
    submissions: Array<{ text: string; result: TuiSubmission }>;
    unmounted: boolean;
  }>,
}));

export { inkFrames };

// Inkの描画・編集境界だけを置き換え、会話とrunnerの制御は本番処理を通す。
vi.mock('ink', () => ({
  Box: () => null,
  Text: () => null,
  Static: () => null,
  useInput: () => undefined,
  useStdout: () => ({ stdout: process.stdout }),
  useWindowSize: () => ({ columns: 100, rows: 24 }),
  render: (element: { props: ConversationViewProps }) => {
    const props = element.props;
    const frame = { props, submissions: [] as Array<{ text: string; result: TuiSubmission }>, unmounted: false };
    inkFrames.frames.push(frame);
    const input = process.stdin;
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode(true);
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const carried = { history: props.initialHistory, queue: [] };
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      if (!buffered.endsWith('\r')) return;
      const text = buffered.slice(0, -1);
      buffered = '';
      const local = props.conversation.resolveLocalCommand(text);
      if (local?.kind === 'cancel') {
        props.onExit({ kind: 'result', result: { action: 'cancel', task: '' } }, carried);
      } else if (local?.kind === 'resume_session' || local?.kind === 'handoff') {
        props.onExit(local, carried);
      } else {
        void props.conversation.submit({
          text, abortSignal: new AbortController().signal, onAssistantChunk: () => undefined,
        }).then((result) => {
          frame.submissions.push({ text, result });
        }, (error: unknown) => props.onExit({ kind: 'failed', error }, carried));
      }
    };
    const onReadable = () => {
      let chunk: Buffer | null;
      while ((chunk = input.read() as Buffer | null) !== null) onData(chunk);
    };
    input.on('readable', onReadable);
    return {
      clear: () => undefined,
      waitUntilRenderFlush: async () => undefined,
      waitUntilExit: () => exited,
      unmount: () => {
        frame.unmounted = true;
        input.removeListener('readable', onReadable);
        input.setRawMode(wasRaw);
        resolveExit();
      },
    };
  },
}));
