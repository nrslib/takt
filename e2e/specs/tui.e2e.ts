import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { formatTaktRunResult, runTakt } from '../helpers/takt-runner';
import { startTaktPty, type TaktPtySession } from '../helpers/takt-pty-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKFLOW_PATH = resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml');
const CTRL_C = '\x03';
const ENTER = '\r';
const ARROW_DOWN = '\x1b[B';
// CSI-u reports the kitty keyboard protocol turns on.
const SHIFT_ENTER = '\x1b[13;2u';
const OPTION_ENTER = '\x1b[13;3u';

// The isolated env pins `language: en` (e2e/fixtures/config.e2e.yaml), so the
// English labels below are deterministic.
const MODE_PROMPT = 'Select interactive mode';
const WORKFLOW_PROMPT = 'Select workflow';
// Both flows choose the workflow and the mode with the same readline selectors,
// which mark the default row; only the Ink conversation advertises these keys.
const TUI_HINT = 'Shift+Enter: newline';
const CLASSIC_SELECTOR_MARKER = '(default)';
/** The readline conversation prompt, which the Ink one replaces with a box. */
const CLASSIC_CONVERSATION_PROMPT = 'Interactive mode - describe your task';
const ACTION_PROMPT = 'What would you like to do?';
const THINKING_MARKER = 'Thinking';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Ink TUI', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;
  let session: TaktPtySession | undefined;

  function start(scenario: string, args: string[]): TaktPtySession {
    const started = startTaktPty({
      args,
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, `../fixtures/scenarios/${scenario}`),
      },
    });
    session = started;
    return started;
  }

  /**
   * Ink turns one stdin chunk into one key event, so the text and the Enter key
   * must arrive separately. Waiting for the echoed draft guarantees the terminal
   * delivered them as two chunks without relying on a sleep.
   */
  async function submitLine(tui: TaktPtySession, text: string): Promise<void> {
    tui.write(text);
    await tui.waitForOutput(`❯ ${text}`);
    tui.write(ENTER);
  }

  /** Give the selector a moment to redraw between keystrokes. */
  async function flushKeys(tui: TaktPtySession): Promise<void> {
    await tui.waitForOutput('Cancel');
  }

  /** Accept the highlighted row of a select list. */
  async function chooseHighlighted(tui: TaktPtySession, prompt: string): Promise<void> {
    await tui.waitForOutput(prompt);
    tui.write(ENTER);
  }

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();
  });

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
    try {
      testRepo.cleanup();
    } catch {
      // best-effort
    }
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  it('should select the mode with the readline selector and converse in Ink', async () => {
    const tui = start('tui-conversation.json', ['--workflow', WORKFLOW_PATH]);

    // The selector is the ordinary one, marked default row and all.
    await tui.waitForOutput(CLASSIC_SELECTOR_MARKER);
    await chooseHighlighted(tui, MODE_PROMPT);

    // The conversation itself is the Ink one.
    await tui.waitForOutput(TUI_HINT);
    const screen = await tui.visibleScreen();
    expect(screen.join('\n')).toContain('╭');

    tui.write(CTRL_C);
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 180_000);

  it('should fall back to the classic conversation with --no-tui and run it to completion', async () => {
    const tui = start('tui-conversation.json', ['--no-tui', '--workflow', WORKFLOW_PATH]);

    await tui.waitForOutput(CLASSIC_SELECTOR_MARKER);
    expect(tui.output()).not.toContain(TUI_HINT);
    expect(tui.output()).not.toContain('╭');

    // Accept the highlighted mode, hold a turn, then leave through /cancel.
    tui.write(ENTER);
    await tui.waitForOutput(CLASSIC_CONVERSATION_PROMPT);
    tui.write(`add a health check endpoint${ENTER}`);
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');
    tui.write(`/cancel${ENTER}`);

    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 180_000);

  it('should offer every interactive mode and cancel out of the selector', async () => {
    const tui = start('tui-conversation.json', ['--workflow', WORKFLOW_PATH]);

    await tui.waitForOutput(MODE_PROMPT);
    const listing = tui.output();
    for (const label of ['Assistant', 'Grill Me', 'Persona', 'Quiet', 'Passthrough']) {
      expect(listing, `mode "${label}" is missing`).toContain(label);
    }

    // The selector's own Cancel row is the last one; choosing it ends the run
    // without ever mounting Ink.
    tui.write(ARROW_DOWN.repeat(5));
    await flushKeys(tui);
    tui.write(ENTER);
    await expect(tui.waitForExit()).resolves.toBe(0);
    expect(tui.output()).not.toContain(TUI_HINT);
  }, 180_000);

  it('should pick the workflow with the readline selector when none was named', async () => {
    const tui = start('tui-conversation.json', []);

    // The categorized selector: a category first, then a workflow inside it.
    await chooseHighlighted(tui, WORKFLOW_PROMPT);
    // Workflow rows carry the score marker; category rows carry a folder.
    await chooseHighlighted(tui, '🎼 ');
    await tui.waitForOutput(MODE_PROMPT);

    // Ctrl+C inside a readline selector ends the process the way it always has.
    tui.write(CTRL_C);
    await expect(tui.waitForExit()).resolves.toBe(130);
  }, 180_000);

  it('should hold a conversation and exit cleanly on /cancel', async () => {
    const tui = start('tui-conversation.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    const beforeConversation = tui.output().length;
    await submitLine(tui, 'add a health check endpoint');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');

    // The streamed tail carries no marker, so the committed reply is marked once.
    const conversationOutput = tui.output().slice(beforeConversation);
    expect((conversationOutput.match(/●/g) ?? []).length).toBe(1);

    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 180_000);

  it('should hand the /go instruction to the action picker and then to the workflow run', async () => {
    const tui = start('tui-go-handoff.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'create noop.txt');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');

    await submitLine(tui, '/go');
    await chooseHighlighted(tui, ACTION_PROMPT);

    await tui.waitForOutput('TUI-WORKFLOW-STEP-DONE', 180_000);
    await expect(tui.waitForExit(180_000)).resolves.toBe(0);
  }, 240_000);

  it('should close Ink for the action selector and reopen it to continue editing', async () => {
    const tui = start('tui-go-handoff.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'create noop.txt');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');

    await submitLine(tui, '/go');
    await tui.waitForOutput(ACTION_PROMPT);
    // The selector owns the bare terminal: the Ink input box is gone by now.
    const duringSelector = await tui.visibleScreen();
    expect(duringSelector.join('\n')).not.toContain('╰');

    // Rows: Execute now, Save as Task, Continue editing, Create Issue, Cancel.
    tui.write(ARROW_DOWN);
    tui.write(ARROW_DOWN);
    await tui.waitForOutput('❯ Continue editing');
    tui.write(ENTER);
    await tui.waitForOutput('Okay, continue describing your task.');

    // Ink comes back for the rest of the conversation.
    await tui.waitForOutput(TUI_HINT);
    const reopened = await tui.visibleScreen();
    expect(reopened.join('\n')).toContain('╰');
    // The earlier turn stays in the scrollback exactly once.
    const transcript = (await tui.visibleTranscript()).join('\n');
    expect((transcript.match(/create noop\.txt/g) ?? []).length).toBe(1);

    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 240_000);

  it('should cancel an in-flight request on Ctrl+C and exit cleanly', async () => {
    const tui = start('tui-abort.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'think about this for a while');
    await tui.waitForOutput(THINKING_MARKER);

    tui.write(CTRL_C);

    await expect(tui.waitForExit()).resolves.toBe(0);
    expect(tui.output()).not.toContain('TUI-ASSISTANT-REPLY-NEVER');
  }, 180_000);

  it('should leave no dynamic-frame residue in the visible scrollback', async () => {
    const tui = start('tui-slow-stream.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'test');
    await tui.waitForOutput('SLOW-REPLY-END', 120_000);

    const visible = await tui.visibleTranscript();
    const rendered = visible.join('\n');

    // The live frame is erased and redrawn in place; nothing from it may survive
    // above the confirmed conversation.
    const assistantRow = visible.findIndex((line) => line.trimStart().startsWith('●'));
    expect(assistantRow, rendered).toBeGreaterThan(0);
    const aboveAssistant = visible.slice(0, assistantRow);
    expect(aboveAssistant.filter((line) => line.includes('Thinking')), rendered).toEqual([]);
    expect(aboveAssistant.filter((line) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)), rendered).toEqual([]);
    // The committed user line legitimately sits above the reply; what must not
    // survive is the input box itself, which is the only bordered thing drawn.
    expect(aboveAssistant.filter((line) => /[╭│╰]/.test(line)), rendered).toEqual([]);

    // Exactly one marked reply, one input box, and the box sits at the bottom.
    expect(visible.filter((line) => line.includes('●')), rendered).toHaveLength(1);
    expect(visible.filter((line) => line.includes('╭')), rendered).toHaveLength(1);
    // Two rows follow the box: the key hints and the session's model.
    const boxBottom = visible.findIndex((line) => line.includes('╰'));
    expect(boxBottom, rendered).toBeGreaterThanOrEqual(visible.length - 3);

    tui.write(CTRL_C);
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 240_000);

  it('should keep the input box pinned to the bottom of the screen', async () => {
    const tui = start('tui-conversation.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'first turn');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');

    const screen = await tui.visibleScreen();
    const boxBottom = screen.findIndex((line) => line.includes('╰'));
    expect(boxBottom, screen.join('\n')).toBeGreaterThanOrEqual(screen.length - 3);

    tui.write(CTRL_C);
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 180_000);

  it('should insert a newline for Shift+Enter and Option+Enter instead of submitting', async () => {
    const tui = start('tui-conversation.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);

    tui.write('alpha');
    await tui.waitForOutput('❯ alpha');
    tui.write(SHIFT_ENTER);
    await tui.waitForOutput('beta', 10_000).catch(() => undefined);
    tui.write('beta');
    await tui.waitForOutput('beta');
    tui.write(OPTION_ENTER);
    tui.write('gamma');
    await tui.waitForOutput('gamma');

    // None of that submitted, so the assistant has not answered.
    expect(tui.output()).not.toContain('TUI-ASSISTANT-REPLY-OK');
    const boxRows = (await tui.visibleScreen()).filter((line) => line.includes('│'));
    expect(boxRows.length, boxRows.join('\n')).toBeGreaterThanOrEqual(3);

    tui.write(CTRL_C);
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 180_000);

  it('should wrap a draft that is wider than the terminal', async () => {
    const tui = start('tui-conversation.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);

    // Far wider than the PTY, so it can only be shown by wrapping it.
    tui.write(`${'wide '.repeat(120)}TAIL`);
    await tui.waitForOutput('TAIL');

    const screen = await tui.visibleScreen();
    const rendered = screen.join('\n');
    // The end of the draft is on screen, and the box grew to hold the rows.
    expect(rendered).toContain('TAIL');
    const boxRows = screen.filter((line) => line.includes('│'));
    expect(boxRows.length, rendered).toBeGreaterThanOrEqual(3);
    // The box is still a box: nothing spilled past its right border.
    const bottom = screen.findIndex((line) => line.includes('╰'));
    expect(bottom, rendered).toBeGreaterThanOrEqual(screen.length - 3);

    tui.write(CTRL_C);
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 180_000);

  it('should fail fast when --tui is forced without a TTY', () => {
    const result = runTakt({
      args: ['--tui', '--workflow', WORKFLOW_PATH],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 60_000,
    });

    expect(result.exitCode, formatTaktRunResult(result)).toBe(1);
    expect(
      `${result.stdout}${result.stderr}`,
      formatTaktRunResult(result),
    ).toContain('--tui requires an interactive terminal');
  }, 90_000);
});
