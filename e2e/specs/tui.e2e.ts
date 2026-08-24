import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
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
const ARROW_UP = '\x1b[A';
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
const ACTION_PROMPT = 'What would you like to do?';
const THINKING_MARKER = 'Thinking';
/** Only shown while lines are waiting for the current answer to finish. */
const QUEUE_HINT = 'to edit the queued line';
/** Drawn in the box in place of the draft, so it means "nothing typed". */
const PLACEHOLDER = 'Type a task, / for commands';
const ESC = '\x1b';
const INTERRUPTED = 'Response interrupted.';
/**
 * What the finished run recorded about itself, which the session prints when it
 * takes over again (the same banner the readline flow greets a session with).
 */
const RUN_FINISHED_NOTICE = 'Previous task completed successfully';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Ink TUI', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;
  let session: TaktPtySession | undefined;

  function start(
    scenario: string,
    args: string[],
    env: Record<string, string> = {},
  ): TaktPtySession {
    const started = startTaktPty({
      args,
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, `../fixtures/scenarios/${scenario}`),
        ...env,
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

  /**
   * Resolve once the readline selector owns the keyboard.
   *
   * `shared/prompt/select.ts` prints its question before it turns raw mode on
   * and draws the rows after: a key sent as soon as the question appears is
   * still the terminal's to interpret, and Ctrl+C is then a SIGINT that kills
   * the run rather than the selector's own cancel. A drawn row is what says the
   * selector is listening.
   */
  async function waitForSelector(tui: TaktPtySession, prompt: string): Promise<void> {
    await tui.waitForOutput(prompt);
    await tui.waitForScreen(
      `the rows of "${prompt}"`,
      (screen) => screen.includes(prompt) && screen.includes('❯ '),
    );
  }

  /** Accept the highlighted row of a select list. */
  async function chooseHighlighted(tui: TaktPtySession, prompt: string): Promise<void> {
    await waitForSelector(tui, prompt);
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

  it('should offer every interactive mode and cancel out of the selector', async () => {
    const tui = start('tui-conversation.json', ['--workflow', WORKFLOW_PATH]);

    await waitForSelector(tui, MODE_PROMPT);
    const listing = tui.output();
    for (const label of ['Assistant', 'Grill Me', 'Persona']) {
      expect(listing, `mode "${label}" is missing`).toContain(label);
    }

    // The selector's own Cancel row is the last one; choosing it ends the run
    // without ever mounting Ink.
    tui.write(ARROW_DOWN.repeat(3));
    // The highlighted row is what says the selector consumed the keys; the
    // `Cancel` label itself is on screen from the first draw.
    await tui.waitForOutput('❯ Cancel');
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
    await waitForSelector(tui, MODE_PROMPT);

    // Ctrl+C inside a readline selector ends the process the way it always has.
    tui.write(CTRL_C);
    await expect(tui.waitForExit()).resolves.toBe(130);
  }, 180_000);

  it('should hold a conversation and exit cleanly on /cancel', async () => {
    const tui = start('tui-conversation.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'add a health check endpoint');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');

    // The streamed tail carries no marker, so the committed reply is marked
    // once. Counted on the visible screen, because the raw byte history also
    // holds frames the app has since erased.
    const transcript = await tui.visibleTranscript();
    expect(transcript.filter((line) => line.includes('●')), transcript.join('\n'))
      .toHaveLength(1);

    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 180_000);

  it('should run the /go instruction and come back to the same session', async () => {
    const tui = start('tui-go-handoff.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'create noop.txt');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');

    await submitLine(tui, '/go');
    await chooseHighlighted(tui, ACTION_PROMPT);
    await tui.waitForOutput('TUI-WORKFLOW-STEP-DONE', 180_000);

    // The run is over and the conversation is back, with what it did on record.
    await tui.waitForOutput(RUN_FINISHED_NOTICE, 60_000);
    const screen = (await tui.visibleScreen()).join('\n');
    expect(screen).toContain('╰');
    // The earlier turn stays in the scrollback exactly once.
    const transcript = (await tui.visibleTranscript()).join('\n');
    expect((transcript.match(/create noop\.txt/g) ?? []).length).toBe(1);

    // Only leaving ends the process.
    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit(60_000)).resolves.toBe(0);
  }, 240_000);

  it('should close Ink for the action selector and reopen it to continue editing', async () => {
    const tui = start('tui-go-handoff.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'create noop.txt');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');

    await submitLine(tui, '/go');
    await waitForSelector(tui, ACTION_PROMPT);
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

  it('should queue what is typed while the assistant answers and send it after', async () => {
    const promptLog = join(testRepo.path, 'mock-prompts.jsonl');
    const tui = start('tui-queue.json', ['--workflow', WORKFLOW_PATH], {
      TAKT_MOCK_PROMPT_LOG: promptLog,
    });

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'first question');
    await tui.waitForOutput(THINKING_MARKER);

    // The box still takes input while the answer streams.
    for (const line of ['queued one', 'queued two']) {
      tui.write(line);
      await tui.waitForOutput(`❯ ${line}`);
      tui.write(ENTER);
      // The Enter has to reach the app as a chunk of its own. A PTY read that
      // catches it together with the next line arrives as a single key event,
      // and the carriage return is then just a control byte inside the text
      // that gets inserted — the line is never handed over. An empty draft is
      // what says this one was.
      await tui.waitForScreen(
        `the draft to be empty after "${line}"`,
        (screen) => screen.includes(PLACEHOLDER),
      );
    }
    // Waiting for the hint proves the lines were queued rather than sent.
    await tui.waitForOutput(QUEUE_HINT);
    const queuedScreen = await tui.visibleScreen();
    expect(queuedScreen.join('\n'), 'the queued lines should sit above the prompt')
      .toContain('queued two');

    // Once the answer lands the queue drains on its own.
    await tui.waitForOutput('QUEUE-SECOND-REPLY', 120_000);
    const transcript = (await tui.visibleTranscript()).join('\n');
    expect(transcript).toContain('❯ queued one');
    expect(transcript).not.toContain(QUEUE_HINT);

    // What the provider received: one turn per send, with the queued lines
    // joined into a single message.
    const prompts = readFileSync(promptLog, 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { prompt: string }).prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('first question');
    expect(prompts[1]).toContain('queued one\nqueued two');

    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 240_000);

  it('should take a queued line back into the draft with the up arrow', async () => {
    const tui = start('tui-queue.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'first question');
    await tui.waitForOutput(THINKING_MARKER);

    tui.write('queued line');
    await tui.waitForOutput('❯ queued line');
    tui.write(ENTER);
    await tui.waitForOutput(QUEUE_HINT);

    // Up with an empty draft takes the queued line back for editing. The text
    // is on screen either way, so the hint going is what says the arrow landed
    // — waiting on the text alone would match the queue row it came from.
    tui.write(ARROW_UP);
    await tui.waitForScreen(
      'the queued line back in the draft',
      (screen) => screen.includes('❯ queued line') && !screen.includes(QUEUE_HINT),
    );
    tui.write(' amended');
    await tui.waitForOutput('queued line amended');

    tui.write(CTRL_C);
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 240_000);

  it('should interrupt a streaming answer with Esc and keep the session', async () => {
    const tui = start('tui-queue.json', ['--workflow', WORKFLOW_PATH]);

    await chooseHighlighted(tui, MODE_PROMPT);
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'first question');
    await tui.waitForOutput('QUEUE-FIRST-REPLY line 1');

    // A line typed while the answer streams is queued, and interrupting sends
    // it: stopping an answer does not hold back what was already submitted.
    tui.write('after the interrupt');
    await tui.waitForOutput('❯ after the interrupt');
    tui.write(ENTER);
    await tui.waitForOutput(QUEUE_HINT);

    tui.write(ESC);
    await tui.waitForOutput(INTERRUPTED);
    await tui.waitForOutput('QUEUE-SECOND-REPLY', 60_000);

    // The queued line was sent and answered, and the queue is empty again.
    const transcript = (await tui.visibleTranscript()).join('\n');
    expect(transcript).toContain('❯ after the interrupt');
    expect(transcript).not.toContain(QUEUE_HINT);
    const screen = (await tui.visibleScreen()).join('\n');
    expect(screen).not.toContain(THINKING_MARKER);
    expect(screen).toContain('╭');

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

  it('should open the instruct conversation from takt list and replay the previous order', async () => {
    // A finished task whose worktree still holds the order its run wrote. That
    // order is what `/replay` resubmits, so the conversation must offer it.
    // The worktree is a clone under the project's clone base, which is where a
    // reusable worktree has to live (`assertReusableWorktreePath`).
    const worktreePath = join(testRepo.path, '.takt', 'worktrees', 'e2e-instruct');
    mkdirSync(join(testRepo.path, '.takt', 'worktrees'), { recursive: true });
    execFileSync('git', ['clone', '--shared', testRepo.path, worktreePath], { stdio: 'pipe' });
    for (const [key, value] of [['user.email', 'test@example.com'], ['user.name', 'Test']]) {
      execFileSync('git', ['config', key!, value!], { cwd: worktreePath, stdio: 'pipe' });
    }
    execFileSync('git', ['checkout', '-B', 'takt/e2e-instruct'], { cwd: worktreePath, stdio: 'pipe' });
    const orderDir = join(worktreePath, '.takt', 'runs', 'e2e-instruct-run', 'context', 'task');
    mkdirSync(orderDir, { recursive: true });
    writeFileSync(join(orderDir, 'order.md'), 'Add a line to README.md\n', 'utf-8');
    const now = new Date().toISOString();
    writeFileSync(
      join(testRepo.path, '.takt', 'tasks.yaml'),
      [
        'tasks:',
        '  - name: e2e-instruct',
        '    status: completed',
        '    content: "E2E instruct task"',
        `    workflow: "${WORKFLOW_PATH}"`,
        '    branch: "takt/e2e-instruct"',
        `    worktree_path: "${worktreePath}"`,
        `    created_at: "${now}"`,
        `    started_at: "${now}"`,
        `    completed_at: "${now}"`,
        '',
      ].join('\n'),
      'utf-8',
    );

    const tui = start('tui-instruct.json', ['list']);

    // The list and the action menu are the ordinary selectors.
    await chooseHighlighted(tui, 'List Tasks');
    await waitForSelector(tui, 'Action for takt/e2e-instruct');
    tui.write(ARROW_DOWN);
    await tui.waitForOutput('❯ Instruct');
    tui.write(ENTER);
    // Reusing the workflow the task already names keeps the run selector away.
    await chooseHighlighted(tui, 'Use previous workflow');

    // The conversation itself is the Ink one, and it knows about the order.
    await tui.waitForOutput(TUI_HINT, 60_000);
    await tui.waitForOutput('Instruct mode - describe');
    const screen = (await tui.visibleScreen()).join('\n');
    expect(screen).toContain('╰');
    expect(screen, 'the intro should advertise /replay').toContain('/replay');

    // `/replay` resubmits the order without asking anything, which starts the run.
    await submitLine(tui, '/replay');
    await tui.waitForOutput('E2E-REPLAY-STEP-DONE', 180_000);
    await tui.waitForOutput('Task "e2e-instruct" completed', 60_000);

    // `takt list` comes back to its own menu, which Esc leaves.
    await waitForSelector(tui, 'List Tasks');
    tui.write(ESC);
    await expect(tui.waitForExit(60_000)).resolves.toBe(0);
  }, 300_000);

  it('should hold the exec conversation in the TUI and open setup on the bare terminal', async () => {
    const tui = startTaktPty({
      args: ['exec', 'backend'],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, '../fixtures/scenarios/exec-tui.json'),
      },
    });
    session = tui;

    // The conversation itself is the Ink one.
    await tui.waitForOutput(TUI_HINT);
    await submitLine(tui, 'describe the task');
    await tui.waitForOutput('EXEC-TUI-REPLY', 60_000);

    // `/setup` hands the terminal to the readline menu, with Ink gone.
    await submitLine(tui, '/setup');
    await waitForSelector(tui, '(↑↓ to move, Enter to select)');
    const duringMenu = (await tui.visibleScreen()).join('\n');
    expect(duringMenu).not.toContain('╰');

    // Leaving the menu brings the conversation back.
    tui.write(CTRL_C);
    await expect(tui.waitForExit(60_000)).resolves.toBe(130);
  }, 240_000);

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
