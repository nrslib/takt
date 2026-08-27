import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env';
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
const WORKFLOW_MAKER_WAIT_EN = 'Please wait until the workflow completes…';
const WORKFLOW_MAKER_WAIT_JA = 'ワークフロー完了までお待ちください…';

interface DirectorySnapshot {
  readonly entries: string[];
  readonly files: Record<string, string>;
}

interface MakerCallRecord {
  readonly event: 'start' | 'complete';
  readonly provider: 'mock';
  readonly model?: string;
  readonly permissionMode?: string;
  readonly allowedTools?: string[];
}

interface MakerStepStartRecord {
  readonly type: 'step_start';
  readonly step: string;
  readonly provider?: string;
  readonly model?: string;
  readonly providerOptions?: {
    readonly codex?: {
      readonly networkAccess?: boolean;
      readonly reasoningEffort?: string;
    };
  };
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Ink TUI', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;
  let session: TaktPtySession | undefined;

  function start(
    scenario: string,
    args: string[],
    env: Record<string, string> = {},
    injectProvider = true,
  ): TaktPtySession {
    const started = startTaktPty({
      args,
      cwd: testRepo.path,
      injectProvider,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: isAbsolute(scenario)
          ? scenario
          : resolve(__dirname, `../fixtures/scenarios/${scenario}`),
        ...env,
      },
    });
    session = started;
    return started;
  }

  function findFile(root: string, filename: string): string | undefined {
    if (!existsSync(root)) return undefined;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = findFile(entryPath, filename);
        if (nested !== undefined) return nested;
      } else if (entry.name === filename) {
        return entryPath;
      }
    }
    return undefined;
  }

  function findFilesWithSuffix(root: string, suffix: string): string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) return findFilesWithSuffix(entryPath, suffix);
      return entry.name.endsWith(suffix) ? [entryPath] : [];
    });
  }

  function readJsonLines<T>(path: string): T[] {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }

  async function waitForFile(root: string, filename: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = findFile(root, filename);
      if (found !== undefined) return found;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`Timed out waiting for ${filename} under ${root}`);
  }

  async function waitForArtifactRoots(root: string, count: number, timeoutMs = 10_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entries = existsSync(root) ? readdirSync(root).sort() : [];
      if (entries.length >= count) return entries.map((entry) => join(root, entry));
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`Timed out waiting for ${count} artifact roots under ${root}`);
  }

  async function waitForNewOutput(
    tui: TaktPtySession,
    offset: number,
    pattern: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (tui.output().slice(offset).includes(pattern)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`Timed out waiting for new output ${JSON.stringify(pattern)}`);
  }

  function snapshotDirectory(root: string, base = root): DirectorySnapshot {
    const snapshot: DirectorySnapshot = { entries: [], files: {} };
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const entryPath = join(root, entry.name);
      const relativePath = relative(base, entryPath);
      if (entry.isDirectory()) {
        const nested = snapshotDirectory(entryPath, base);
        snapshot.entries.push(`${relativePath}/`, ...nested.entries);
        Object.assign(snapshot.files, nested.files);
      } else {
        snapshot.entries.push(relativePath);
        snapshot.files[relativePath] = readFileSync(entryPath).toString('base64');
      }
    }
    snapshot.entries.sort();
    return snapshot;
  }

  function hasExactVisibleLine(screen: string, expected: string): boolean {
    return screen.split('\n').some((line) => (
      line.replace(/^\s*│\s?/, '').replace(/\s?│\s*$/, '').trim() === expected
    ));
  }

  function selectableRows(screen: string): string[] {
    return screen.split('\n').flatMap((line) => {
      const match = /^(?:  ❯ |    )(\S.*)$/.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    });
  }

  function compactScreen(screen: readonly string[]): string {
    return screen.join('').replace(/[│\s]/g, '');
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

  it('should select every existing Workflow Maker base source and preserve its context', async () => {
    const projectWorkflowsDir = join(testRepo.path, '.takt', 'workflows');
    const globalWorkflowsDir = join(isolatedEnv.taktDir, 'workflows');
    const repertoireWorkflowsDir = join(
      isolatedEnv.taktDir,
      'repertoire',
      '@owner',
      'package',
      'workflows',
    );
    const fixtures = [
      [projectWorkflowsDir, 'project-base-file.yaml', 'project-base-name'],
      [globalWorkflowsDir, 'global-base-file.yaml', 'global-base-name'],
      [repertoireWorkflowsDir, 'repertoire-base-file.yaml', 'repertoire-base-name'],
    ] as const;
    for (const [directory, filename, workflowName] of fixtures) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, filename), `name: ${workflowName}
initial_step: plan
max_steps: 1
steps:
  - name: plan
    instruction: Plan this workflow directly.
`, 'utf-8');
    }

    const sourceCases = [
      { arrows: 1, label: 'Project workflows', source: 'project', root: realpathSync(projectWorkflowsDir) },
      { arrows: 2, label: 'Global workflows', source: 'user', root: globalWorkflowsDir },
      { arrows: 3, label: 'Builtin workflows', source: 'builtin', root: realpathSync(resolve(__dirname, '../../builtins/en/workflows')) },
      { arrows: 4, label: 'Repertoire workflows', source: 'repertoire', root: repertoireWorkflowsDir },
    ] as const;

    for (const sourceCase of sourceCases) {
      const promptLog = join(testRepo.path, `maker-${sourceCase.source}-prompts.jsonl`);
      const tui = start('tui-conversation.json', ['make'], { TAKT_MOCK_PROMPT_LOG: promptLog });
      await waitForSelector(tui, 'Select a Workflow Maker base:');
      tui.write(ARROW_DOWN.repeat(sourceCase.arrows));
      await tui.waitForScreen(
        `${sourceCase.label} to be highlighted`,
        (screen) => screen.includes(`❯ ${sourceCase.label}`),
      );
      tui.write(ENTER);
      await waitForSelector(tui, 'Select a workflow:');
      tui.write(ENTER);
      await tui.waitForScreen('the selected Maker conversation', (screen) => screen.includes(TUI_HINT), 10_000);
      await submitLine(tui, `inspect the ${sourceCase.source} base`);
      await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');

      const promptEntries = readFileSync(promptLog, 'utf-8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { prompt: string });
      const prompt = promptEntries[0]?.prompt;
      expect(prompt).toBeDefined();
      const selectedPath = /Workflow path: (.+)/.exec(prompt!)?.[1];
      expect(selectedPath).toBeDefined();
      expect(selectedPath!.startsWith(sourceCase.root)).toBe(true);
      expect(prompt).toContain(`Workflow source: ${sourceCase.source}`);
      expect(prompt).toContain(readFileSync(selectedPath!, 'utf-8'));
      const selectedYaml = parseYaml(readFileSync(selectedPath!, 'utf-8')) as { name?: string };
      expect(prompt).toContain(`name: ${selectedYaml.name}`);
      expect(prompt).toContain(`Workflow path: ${selectedPath}`);
      expect(prompt).toContain(basename(selectedPath!));

      await submitLine(tui, '/cancel');
      await expect(tui.waitForExit()).resolves.toBe(0);
    }
  }, 120_000);

  it('should sanitize a Workflow Maker filename for display without changing its selected path', async () => {
    const unsafeFilename = 'unsafe\u0007name.yaml';
    const unsafePath = join(testRepo.path, '.takt', 'workflows', unsafeFilename);
    mkdirSync(dirname(unsafePath), { recursive: true });
    writeFileSync(unsafePath, `name: safe-workflow-name
initial_step: plan
max_steps: 1
steps:
  - name: plan
    instruction: Plan this workflow directly.
`, 'utf-8');
    const expectedUnsafePath = realpathSync(unsafePath);
    const promptLog = join(testRepo.path, 'maker-unsafe-filename-prompts.jsonl');
    const tui = start('tui-conversation.json', ['make'], { TAKT_MOCK_PROMPT_LOG: promptLog });

    await waitForSelector(tui, 'Select a Workflow Maker base:');
    tui.write(ARROW_DOWN);
    await tui.waitForScreen(
      'Project workflows to be highlighted',
      (screen) => screen.includes('❯ Project workflows'),
    );
    tui.write(ENTER);
    await waitForSelector(tui, 'Select a workflow:');
    const selectorScreen = (await tui.visibleScreen()).join('\n');
    expect(selectorScreen).toContain('unsafe\\x07name');
    expect(selectorScreen).not.toContain('\u0007');
    tui.write(ENTER);
    await tui.waitForScreen('the selected Maker conversation', (screen) => screen.includes(TUI_HINT));
    await submitLine(tui, 'inspect the unsafe filename base');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');

    const firstPrompt = readFileSync(promptLog, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { prompt: string })[0]?.prompt;
    expect(firstPrompt).toContain(`Workflow path: ${expectedUnsafePath}`);

    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 60_000);

  it('should keep Maker capabilities separate while propagating the project runtime configuration', async () => {
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'codex',
      model: 'global-maker-model',
      provider_options: { codex: { reasoning_effort: 'low' } },
      provider_profiles: {
        codex: {
          default_permission_mode: 'readonly',
          step_permission_overrides: { create: 'readonly' },
        },
      },
    });
    mkdirSync(join(testRepo.path, '.takt'), { recursive: true });
    writeFileSync(join(testRepo.path, '.takt', 'config.yaml'), `provider: mock
model: project-maker-model
provider_options:
  codex:
    reasoning_effort: high
provider_profiles:
  mock:
    default_permission_mode: full
    step_permission_overrides:
      create: full
`, 'utf-8');
    const packageRoot = join(isolatedEnv.taktDir, 'repertoire', '@owner', 'package');
    mkdirSync(join(packageRoot, 'workflows'), { recursive: true });
    mkdirSync(join(packageRoot, 'provider-options'), { recursive: true });
    writeFileSync(join(packageRoot, 'workflows', 'runtime-base.yaml'), `name: runtime-base-name
capabilities: edit
initial_step: plan
max_steps: 1
steps:
  - name: plan
    instruction: Plan the artifact directly.
`, 'utf-8');
    writeFileSync(join(packageRoot, 'provider-options', 'edit.yaml'), `codex:
  network_access: false
`, 'utf-8');
    const callLog = join(testRepo.path, 'maker-runtime-calls.jsonl');
    const tui = start('workflow-maker-execute.json', ['make'], {
      TAKT_MOCK_CALL_LOG: callLog,
    }, false);

    await waitForSelector(tui, 'Select a Workflow Maker base:');
    tui.write(ARROW_DOWN.repeat(4));
    await tui.waitForScreen(
      'Repertoire workflows to be highlighted',
      (screen) => screen.includes('❯ Repertoire workflows'),
    );
    tui.write(ENTER);
    await chooseHighlighted(tui, 'Select a workflow:');
    await tui.waitForOutput(TUI_HINT, 10_000);
    await submitLine(tui, 'execute with the project runtime configuration');
    await tui.waitForOutput('TUI-MAKER-REPLY-OK');
    await submitLine(tui, '/go');
    await waitForSelector(tui, ACTION_PROMPT);
    tui.write(ENTER);
    await tui.waitForScreen(
      'the configured Workflow Maker execution to complete',
      (screen) => screen.includes('Workflow Maker completed') && screen.includes(TUI_HINT),
      90_000,
    );

    const makeRoot = join(testRepo.path, '.takt', 'make');
    const [artifactName] = readdirSync(makeRoot);
    expect(artifactName).toBeDefined();
    const artifactRoot = join(makeRoot, artifactName!);
    const artifactCapability = parseYaml(readFileSync(
      join(artifactRoot, 'provider-options', 'edit.yaml'),
      'utf-8',
    )) as { codex?: { network_access?: boolean } };
    expect(artifactCapability.codex?.network_access).toBe(false);

    const stepStarts = findFilesWithSuffix(join(artifactRoot, '.takt', 'runs'), '.jsonl')
      .flatMap((path) => readJsonLines<MakerStepStartRecord>(path))
      .filter((record) => record.type === 'step_start');
    const createStart = stepStarts.find((record) => record.step === 'create');
    expect(createStart).toEqual(expect.objectContaining({
      provider: 'mock',
      model: 'project-maker-model',
      providerOptions: expect.objectContaining({
        codex: expect.objectContaining({
          networkAccess: true,
          reasoningEffort: 'high',
        }),
      }),
    }));
    const calls = readJsonLines<MakerCallRecord>(callLog);
    expect(calls).toContainEqual(expect.objectContaining({
      event: 'start',
      provider: 'mock',
      model: 'project-maker-model',
      permissionMode: 'full',
    }));

    await submitLine(tui, 'continue after configuration verification');
    await tui.waitForOutput('TUI-MAKER-SECOND-REPLY-OK');
    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 120_000);

  it('should continue the same Maker conversation without writing when execution is not approved', async () => {
    const tui = start('tui-go-handoff.json', ['make']);

    await tui.waitForOutput('New workflow', 5_000);
    tui.write(ENTER);
    await tui.waitForOutput('Workflow name', 5_000);
    tui.write('draft-maker-flow');
    tui.write(ENTER);
    await tui.waitForOutput(TUI_HINT, 10_000);

    await submitLine(tui, 'create a two-step review workflow');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');
    await submitLine(tui, '/go');
    await waitForSelector(tui, ACTION_PROMPT);

    const approvalScreen = (await tui.visibleScreen()).join('\n');
    expect(approvalScreen).toContain('Create a file called noop.txt');
    expect(approvalScreen).toMatch(/\.takt\/make\/\d{8}-\d{6}-\d{3}/);
    expect(selectableRows(approvalScreen.slice(approvalScreen.lastIndexOf(ACTION_PROMPT))))
      .toEqual(['Execute', 'Continue editing', 'Cancel']);
    expect(approvalScreen).not.toContain('Save as Task');
    expect(approvalScreen).not.toContain('Create Issue');
    expect(existsSync(join(testRepo.path, '.takt', 'make'))).toBe(false);

    tui.write(ARROW_DOWN);
    await tui.waitForOutput('❯ Continue editing');
    tui.write(ENTER);
    await tui.waitForOutput(TUI_HINT);
    expect(existsSync(join(testRepo.path, '.takt', 'make'))).toBe(false);

    const transcript = (await tui.visibleTranscript()).join('\n');
    expect((transcript.match(/create a two-step review workflow/g) ?? []).length).toBe(1);

    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 60_000);

  it('should visualize control characters in Maker approval output without changing execution values', async () => {
    const parentRepoPath = testRepo.path;
    const unsafeProjectDir = join(parentRepoPath, 'unsafe\u0007project');
    mkdirSync(unsafeProjectDir);
    testRepo.path = unsafeProjectDir;
    const promptLog = join(parentRepoPath, 'maker-terminal-safety-prompts.jsonl');
    const tui = start('workflow-maker-terminal-safety.json', ['make'], {
      TAKT_MOCK_PROMPT_LOG: promptLog,
    });

    await chooseHighlighted(tui, 'Select a Workflow Maker base:');
    await tui.waitForOutput('Workflow name', 5_000);
    tui.write('terminal-safe-flow');
    tui.write(ENTER);
    await tui.waitForOutput(TUI_HINT, 10_000);
    await submitLine(tui, 'prepare a terminal-safe approval');
    await tui.waitForOutput('TUI-MAKER-TERMINAL-SAFETY-REPLY');
    await submitLine(tui, '/go');
    await waitForSelector(tui, ACTION_PROMPT);

    const approvalOutput = tui.output().slice(tui.output().lastIndexOf('Proposed Workflow Maker instruction:'));
    expect(approvalOutput).toContain('Create\\x07the requested workflow.');
    expect(approvalOutput).toContain('unsafe\\x07project');
    expect(approvalOutput).not.toContain('\u0007');
    tui.write(ENTER);
    await tui.waitForScreen(
      'the terminal-safe Workflow Maker execution to complete',
      (screen) => screen.includes('Workflow Maker completed') && screen.includes(TUI_HINT),
      90_000,
    );

    const [artifactName] = readdirSync(join(unsafeProjectDir, '.takt', 'make'));
    expect(artifactName).toBeDefined();
    expect(existsSync(join(unsafeProjectDir, '.takt', 'make', artifactName!))).toBe(true);
    const prompts = readJsonLines<{ prompt: string }>(promptLog).map((entry) => entry.prompt);
    expect(prompts.some((prompt) => prompt.includes('Create\u0007the requested workflow.'))).toBe(true);

    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 120_000);

  it('should cancel Workflow Maker approval without execution or artifact writes', async () => {
    const tui = start('tui-go-handoff.json', ['make']);

    await chooseHighlighted(tui, 'Select a Workflow Maker base:');
    await tui.waitForOutput('Workflow name', 5_000);
    tui.write('cancelled-maker-flow');
    tui.write(ENTER);
    await tui.waitForOutput(TUI_HINT, 10_000);
    await submitLine(tui, 'prepare but do not execute this workflow');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');
    await submitLine(tui, '/go');
    await waitForSelector(tui, ACTION_PROMPT);
    tui.write(ARROW_UP);
    await tui.waitForScreen('Cancel to be highlighted', (screen) => screen.includes('❯ Cancel'));
    tui.write(ENTER);
    await tui.waitForScreen('the Maker conversation after cancellation', (screen) => screen.includes(TUI_HINT));

    expect(existsSync(join(testRepo.path, '.takt', 'make'))).toBe(false);
    expect(tui.output()).not.toContain('TUI-WORKFLOW-STEP-DONE');
    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 60_000);

  it('should omit a Doctor report when artifact materialization fails before execution', async () => {
    const tui = start('tui-go-handoff.json', ['make']);

    await chooseHighlighted(tui, 'Select a Workflow Maker base:');
    await tui.waitForOutput('Workflow name', 5_000);
    tui.write('occupied-maker-flow');
    tui.write(ENTER);
    await tui.waitForOutput(TUI_HINT, 10_000);
    await submitLine(tui, 'prepare an artifact whose path becomes occupied');
    await tui.waitForOutput('TUI-ASSISTANT-REPLY-OK');
    await submitLine(tui, '/go');
    await waitForSelector(tui, ACTION_PROMPT);
    const plannedMatch = /Planned artifact path: (.+?\.takt\/make\/\d{8}-\d{6}-\d{3})/.exec(tui.output());
    expect(plannedMatch?.[1]).toBeDefined();
    const plannedRoot = plannedMatch![1]!;
    mkdirSync(plannedRoot, { recursive: true });

    tui.write(ENTER);
    await tui.waitForScreen(
      'the materialization failure without a Doctor report',
      (screen) => screen.includes('Workflow Maker failed')
        && screen.includes('Artifact preserved at')
        && screen.includes('EEXIST')
        && screen.includes(TUI_HINT),
      30_000,
    );
    const failedScreen = compactScreen(await tui.visibleScreen());
    expect(failedScreen).toContain(plannedRoot);
    expect(failedScreen).not.toContain('Doctorreport');
    expect(findFile(plannedRoot, 'workflow-maker-doctor.md')).toBeUndefined();
    expect(existsSync(join(plannedRoot, '.takt', 'runs'))).toBe(false);

    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 60_000);

  it.each(['directory', 'symlink'] as const)(
    'should omit a Doctor report when the report path is a %s',
    async (reportKind) => {
      const scenarioPath = join(testRepo.path, `workflow-maker-report-${reportKind}.json`);
      writeFileSync(scenarioPath, JSON.stringify([
        { persona: 'interactive', status: 'done', content: 'TUI-MAKER-REPORT-KIND-REPLY' },
        { persona: 'interactive', status: 'done', content: 'Run the Doctor report kind scenario.' },
        { status: 'done', content: 'The isolated workflow artifact is implemented.' },
        { status: 'done', content: '# Workflow Maker Doctor Report\n\n## Validation\n- Result: PASS\n' },
        { persona: 'conductor', status: 'done', content: '[CREATE:1]' },
        { status: 'done', content: 'The artifact and Doctor result satisfy the request.' },
        { status: 'done', content: '# Workflow Maker Review\n\n## Verdict\napproved\n' },
        { persona: 'conductor', status: 'done', content: '[REVIEW:1]', delay_ms: 3_000 },
      ]), 'utf-8');
      const tui = start(scenarioPath, ['make']);

      await chooseHighlighted(tui, 'Select a Workflow Maker base:');
      await tui.waitForOutput('Workflow name', 5_000);
      tui.write(`report-${reportKind}-maker-flow`);
      tui.write(ENTER);
      await tui.waitForOutput(TUI_HINT, 10_000);
      await submitLine(tui, `prepare a ${reportKind} Doctor report path`);
      await tui.waitForOutput('TUI-MAKER-REPORT-KIND-REPLY');
      await submitLine(tui, '/go');
      await waitForSelector(tui, ACTION_PROMPT);
      tui.write(ENTER);
      await tui.waitForScreen(
        'the Workflow Maker waiting placeholder',
        (screen) => hasExactVisibleLine(screen, WORKFLOW_MAKER_WAIT_EN),
        10_000,
      );

      const [artifactRoot] = await waitForArtifactRoots(join(testRepo.path, '.takt', 'make'), 1);
      const doctorReport = await waitForFile(artifactRoot!, 'workflow-maker-doctor.md');
      await waitForFile(artifactRoot!, 'workflow-maker-review.md');
      rmSync(doctorReport);
      if (reportKind === 'directory') {
        mkdirSync(doctorReport);
      } else {
        const symlinkTarget = join(testRepo.path, 'doctor-report-target.md');
        writeFileSync(symlinkTarget, '# Symlink target\n', 'utf-8');
        symlinkSync(symlinkTarget, doctorReport);
      }

      await tui.waitForScreen(
        'the completed Workflow Maker conversation without a Doctor report',
        (screen) => screen.includes('Workflow Maker completed') && screen.includes(TUI_HINT),
        90_000,
      );
      const completedScreen = compactScreen(await tui.visibleScreen());
      expect(completedScreen).toContain(artifactRoot!);
      expect(completedScreen).not.toContain('Doctorreport');
      expect(completedScreen).not.toContain(doctorReport);

      await submitLine(tui, '/cancel');
      await expect(tui.waitForExit()).resolves.toBe(0);
    },
    120_000,
  );

  it('should hand off the next provider call to the selected base while preserving history and avoiding writes', async () => {
    const workflowsDir = join(testRepo.path, '.takt', 'workflows');
    const firstPath = join(workflowsDir, 'a-first-base.yaml');
    const unsafeSecondName = 'z-second\u0007-base';
    const secondPath = join(workflowsDir, `${unsafeSecondName}.yaml`);
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(firstPath, `name: first-base-name
description: FIRST_BASE_UNIQUE_CONTENT
initial_step: plan
max_steps: 1
steps:
  - name: plan
    instruction: Plan the first workflow.
`, 'utf-8');
    writeFileSync(secondPath, `name: second-base-name
description: SECOND_BASE_UNIQUE_CONTENT
initial_step: plan
max_steps: 1
steps:
  - name: plan
    instruction: Plan the second workflow.
`, 'utf-8');
    const expectedSecondPath = realpathSync(secondPath);
    const promptLog = join(testRepo.path, 'maker-base-handoff-prompts.jsonl');
    const tui = start('workflow-maker-base-handoff.json', ['make'], {
      TAKT_MOCK_PROMPT_LOG: promptLog,
    });

    await waitForSelector(tui, 'Select a Workflow Maker base:');
    tui.write(ARROW_DOWN);
    await tui.waitForOutput('❯ Project workflows');
    tui.write(ENTER);
    await chooseHighlighted(tui, 'Select a workflow:');
    await tui.waitForScreen('the first Maker conversation', (screen) => screen.includes(TUI_HINT), 10_000);
    await submitLine(tui, 'retain this request across the base handoff');
    await tui.waitForScreen(
      'the completed first-base response',
      (screen) => screen.includes('TUI-MAKER-FIRST-BASE-REPLY') && screen.includes(TUI_HINT),
      10_000,
    );
    const handoffOutputOffset = tui.output().length;
    await submitLine(tui, '/workflow');
    await waitForNewOutput(tui, handoffOutputOffset, 'Select a Workflow Maker base:');
    await tui.waitForScreen(
      'the new Workflow Maker base selector',
      (screen) => screen.includes('Select a Workflow Maker base:')
        && selectableRows(screen).includes('Project workflows'),
      10_000,
    );
    const projectHighlightOffset = tui.output().length;
    tui.write(ARROW_DOWN);
    await waitForNewOutput(tui, projectHighlightOffset, '❯ Project workflows');
    const workflowSelectorOffset = tui.output().length;
    tui.write(ENTER);
    await waitForNewOutput(tui, workflowSelectorOffset, 'Select a workflow:');
    await tui.waitForScreen(
      'the new workflow selector',
      (screen) => screen.includes('Select a workflow:')
        && selectableRows(screen).includes('a-first-base'),
      10_000,
    );
    tui.write(ARROW_DOWN);
    await tui.waitForOutput('❯ z-second\\x07-base');
    tui.write(ENTER);
    await tui.waitForScreen(
      'the conversation after changing the Workflow Maker base',
      (screen) => screen.includes('Workflow Maker base changed to z-second\\x07-base')
        && screen.includes(TUI_HINT),
      10_000,
    );
    const handoffOutput = tui.output().slice(handoffOutputOffset);
    expect(handoffOutput).toContain('Workflow Maker base changed to z-second\\x07-base');
    expect(handoffOutput).not.toContain('\u0007');

    await submitLine(tui, 'inspect the newly selected base');
    await tui.waitForOutput('TUI-MAKER-SECOND-BASE-REPLY');

    expect((await tui.visibleTranscript()).join('\n')).toContain(
      'retain this request across the base handoff',
    );
    const prompts = readJsonLines<{ prompt: string }>(promptLog).map((entry) => entry.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('retain this request across the base handoff');
    expect(prompts[1]).toContain('Workflow source: project');
    expect(prompts[1]).toContain(`Workflow path: ${expectedSecondPath}`);
    expect(prompts[1]).toContain(basename(secondPath));
    expect(prompts[1]).toContain('name: second-base-name');
    expect(prompts[1]).toContain('SECOND_BASE_UNIQUE_CONTENT');
    expect(prompts[1]).not.toContain('FIRST_BASE_UNIQUE_CONTENT');
    expect(existsSync(join(testRepo.path, '.takt', 'make'))).toBe(false);
    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 60_000);

  it('should render Workflow Maker runtime states in Japanese', async () => {
    updateIsolatedConfig(isolatedEnv.taktDir, { language: 'ja' });
    const tui = start('workflow-maker-execute.json', ['make']);

    await chooseHighlighted(tui, 'Workflow Maker の base を選択してください:');
    await tui.waitForOutput('ワークフロー名', 5_000);
    tui.write('japanese-maker-flow');
    tui.write(ENTER);
    await tui.waitForOutput('Shift+Enter: 改行', 10_000);
    await submitLine(tui, '日本語表示を確認する');
    await tui.waitForOutput('TUI-MAKER-REPLY-OK');
    await submitLine(tui, '/go');
    await waitForSelector(tui, 'どうしますか？');
    const approvalScreen = (await tui.visibleScreen()).join('\n');
    expect(selectableRows(approvalScreen.slice(approvalScreen.lastIndexOf('どうしますか？'))))
      .toEqual(['実行', '編集を続ける', 'キャンセル']);
    tui.write(ENTER);
    await tui.waitForScreen(
      '日本語の待機表示',
      (screen) => hasExactVisibleLine(screen, WORKFLOW_MAKER_WAIT_JA),
      10_000,
    );
    await tui.waitForScreen(
      '日本語の完了表示',
      (screen) => screen.includes('Workflow Maker が完了しました') && screen.includes('Shift+Enter: 改行'),
      90_000,
    );
    const makeRoot = join(testRepo.path, '.takt', 'make');

    await submitLine(tui, '同じ成果物をもう一度実行する');
    await tui.waitForOutput('TUI-MAKER-SECOND-REPLY-OK');
    await submitLine(tui, '/go');
    await waitForSelector(tui, 'どうしますか？');
    tui.write(ENTER);
    await tui.waitForScreen(
      '2回目の日本語の待機表示',
      (screen) => hasExactVisibleLine(screen, WORKFLOW_MAKER_WAIT_JA),
      10_000,
    );
    const secondArtifactRoot = (await waitForArtifactRoots(makeRoot, 2))[1]!;
    await tui.waitForScreen(
      '2回目の日本語の完了表示',
      (screen) => screen.includes('Workflow Maker が完了しました')
        && compactScreen(screen.split('\n')).includes(secondArtifactRoot)
        && screen.includes('Shift+Enter: 改行'),
      90_000,
    );

    await submitLine(tui, '失敗時の日本語表示を確認する');
    await tui.waitForOutput('TUI-MAKER-THIRD-REPLY-OK');
    await submitLine(tui, '/go');
    await waitForSelector(tui, 'どうしますか？');
    tui.write(ENTER);
    await tui.waitForScreen(
      '失敗時の日本語の待機表示',
      (screen) => hasExactVisibleLine(screen, WORKFLOW_MAKER_WAIT_JA),
      10_000,
    );
    const failedArtifactRoot = (await waitForArtifactRoots(makeRoot, 3))[2]!;
    await tui.waitForScreen(
      '日本語の失敗表示',
      (screen) => screen.includes('Workflow Maker が失敗しました')
        && compactScreen(screen.split('\n')).includes(failedArtifactRoot)
        && screen.includes('に保存されています')
        && screen.includes('Shift+Enter: 改行'),
      90_000,
    );

    await submitLine(tui, '失敗後も会話を続ける');
    await tui.waitForOutput('TUI-AFTER-FAILURE-REPLY');
    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 120_000);

  it('should execute Workflow Maker directly in the approved artifact and return to the TUI', async () => {
    const tui = start('workflow-maker-execute.json', ['make']);
    const initialBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: testRepo.path,
      encoding: 'utf-8',
    }).trim();
    const initialCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: testRepo.path,
      encoding: 'utf-8',
    }).trim();

    await tui.waitForOutput('New workflow', 5_000);
    tui.write(ENTER);
    await tui.waitForOutput('Workflow name', 5_000);
    tui.write('executed-maker-flow');
    tui.write(ENTER);
    await tui.waitForOutput(TUI_HINT, 10_000);

    await submitLine(tui, 'create and validate a review workflow');
    await tui.waitForOutput('TUI-MAKER-REPLY-OK');
    await submitLine(tui, '/go');
    await waitForSelector(tui, ACTION_PROMPT);
    tui.write(ENTER);

    await tui.waitForScreen(
      'the Workflow Maker waiting placeholder',
      (screen) => hasExactVisibleLine(screen, WORKFLOW_MAKER_WAIT_EN),
      10_000,
    );
    tui.write('DISCARDED-RUNNING-INPUT');
    await tui.waitForScreen(
      'the completed Workflow Maker conversation',
      (screen) => screen.includes('Workflow Maker completed') && screen.includes(TUI_HINT),
      90_000,
    );
    expect((await tui.visibleScreen()).join('\n')).not.toContain('DISCARDED-RUNNING-INPUT');

    const makeRoot = join(testRepo.path, '.takt', 'make');
    let artifacts = readdirSync(makeRoot).sort();
    expect(artifacts).toHaveLength(1);
    const artifactRoot = join(makeRoot, artifacts[0]!);
    const generatedWorkflow = join(artifactRoot, 'workflows', 'executed-maker-flow.yaml');
    expect(existsSync(generatedWorkflow)).toBe(true);
    expect(parseYaml(readFileSync(generatedWorkflow, 'utf-8'))).toEqual(
      expect.objectContaining({ name: 'executed-maker-flow' }),
    );
    expect(existsSync(join(artifactRoot, '.takt', 'runs'))).toBe(true);
    expect(existsSync(join(testRepo.path, '.takt', 'tasks.yaml'))).toBe(false);
    expect(existsSync(join(dirname(isolatedEnv.taktDir), 'worktrees'))).toBe(false);
    expect(execFileSync('git', ['branch', '--show-current'], {
      cwd: testRepo.path,
      encoding: 'utf-8',
    }).trim()).toBe(initialBranch);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: testRepo.path,
      encoding: 'utf-8',
    }).trim()).toBe(initialCommit);
    const doctorReport = await waitForFile(artifactRoot, 'workflow-maker-doctor.md');
    const reviewReport = await waitForFile(artifactRoot, 'workflow-maker-review.md');
    expect(readFileSync(doctorReport, 'utf-8')).toContain('Result: PASS');
    expect(readFileSync(reviewReport, 'utf-8')).toContain('approved');
    const completedScreen = compactScreen(await tui.visibleScreen());
    expect(completedScreen).toContain(artifactRoot);
    expect(completedScreen).toContain(doctorReport);
    const firstSnapshot = snapshotDirectory(artifactRoot);

    await submitLine(tui, 'run the same approved request again');
    await tui.waitForOutput('TUI-MAKER-SECOND-REPLY-OK');
    await submitLine(tui, '/go');
    await waitForSelector(tui, ACTION_PROMPT);
    tui.write(ENTER);
    await tui.waitForScreen(
      'the second Workflow Maker waiting placeholder',
      (screen) => hasExactVisibleLine(screen, WORKFLOW_MAKER_WAIT_EN),
      10_000,
    );
    const secondArtifactRoot = (await waitForArtifactRoots(makeRoot, 2))[1]!;
    await tui.waitForScreen(
      'the second completed Workflow Maker conversation',
      (screen) => screen.includes('Workflow Maker completed')
        && compactScreen(screen.split('\n')).includes(secondArtifactRoot)
        && screen.includes(TUI_HINT),
      90_000,
    );
    artifacts = readdirSync(makeRoot).sort();
    expect(artifacts).toHaveLength(2);
    expect(snapshotDirectory(artifactRoot)).toEqual(firstSnapshot);
    expect(artifacts[1]).not.toBe(artifacts[0]);

    await submitLine(tui, 'run a request that fails');
    await tui.waitForOutput('TUI-MAKER-THIRD-REPLY-OK');
    await submitLine(tui, '/go');
    await waitForSelector(tui, ACTION_PROMPT);
    tui.write(ENTER);
    await tui.waitForScreen(
      'the failing Workflow Maker waiting placeholder',
      (screen) => hasExactVisibleLine(screen, WORKFLOW_MAKER_WAIT_EN),
      10_000,
    );
    const failedArtifactRoots = await waitForArtifactRoots(makeRoot, 3);
    const failedArtifactRoot = failedArtifactRoots[2]!;
    const failedDoctorReport = await waitForFile(failedArtifactRoot, 'workflow-maker-doctor.md');
    expect(readFileSync(failedDoctorReport, 'utf-8')).toContain('Result: FAIL');
    await tui.waitForScreen(
      'the failed Workflow Maker conversation',
      (screen) => screen.includes('Workflow Maker failed')
        && compactScreen(screen.split('\n')).includes(failedArtifactRoot)
        && compactScreen(screen.split('\n')).includes('SimulatedWorkflowMakerfixfailure')
        && screen.includes('Artifact preserved at')
        && screen.includes(TUI_HINT),
      90_000,
    );
    artifacts = readdirSync(makeRoot).sort();
    expect(artifacts).toHaveLength(3);
    const failedReviewReport = await waitForFile(failedArtifactRoot, 'workflow-maker-review.md');
    expect(readFileSync(failedReviewReport, 'utf-8')).toContain('needs_fix');
    const failedScreen = compactScreen(await tui.visibleScreen());
    expect(failedScreen).toContain(failedArtifactRoot);
    expect(failedScreen).toContain(failedDoctorReport);
    expect(failedScreen).toContain('SimulatedWorkflowMakerfixfailure');

    await submitLine(tui, 'continue after the failed workflow');
    await tui.waitForOutput('TUI-AFTER-FAILURE-REPLY');
    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 120_000);

  it('should complete Workflow Maker after a needs_fix, fix, and approved review loop', async () => {
    const tui = start('workflow-maker-fix-loop.json', ['make']);

    await chooseHighlighted(tui, 'Select a Workflow Maker base:');
    await tui.waitForOutput('Workflow name', 5_000);
    tui.write('fix-loop-maker-flow');
    tui.write(ENTER);
    await tui.waitForOutput(TUI_HINT, 10_000);
    await submitLine(tui, 'create a workflow that needs one review correction');
    await tui.waitForOutput('TUI-MAKER-FIX-LOOP-REPLY');
    await submitLine(tui, '/go');
    await waitForSelector(tui, ACTION_PROMPT);
    tui.write(ENTER);
    await tui.waitForScreen(
      'the converged Workflow Maker conversation',
      (screen) => screen.includes('Workflow Maker completed') && screen.includes(TUI_HINT),
      90_000,
    );

    const [artifactName] = readdirSync(join(testRepo.path, '.takt', 'make'));
    expect(artifactName).toBeDefined();
    const artifactRoot = join(testRepo.path, '.takt', 'make', artifactName!);
    const doctorReport = await waitForFile(artifactRoot, 'workflow-maker-doctor.md');
    const reviewReport = await waitForFile(artifactRoot, 'workflow-maker-review.md');
    expect(readFileSync(doctorReport, 'utf-8')).toContain('FIX_VALIDATION');
    expect(readFileSync(reviewReport, 'utf-8')).toContain('approved');
    const workflowLog = findFilesWithSuffix(join(artifactRoot, '.takt', 'runs'), '.jsonl')
      .filter((path) => !path.endsWith('-otel-session-shadow.jsonl')
        && !path.endsWith('-usage-events.jsonl')
        && !path.endsWith('-provider-events.jsonl'))
      .find((path) => readJsonLines<{ type?: string }>(path)[0]?.type === 'workflow_start');
    expect(workflowLog).toBeDefined();
    const stepStarts = readJsonLines<MakerStepStartRecord>(workflowLog!)
      .filter((record) => record.type === 'step_start')
      .map((record) => record.step);
    expect(stepStarts).toEqual(['create', 'review', 'fix', 'review']);
    const completedScreen = compactScreen(await tui.visibleScreen());
    expect(completedScreen).toContain(artifactRoot);
    expect(completedScreen).toContain(doctorReport);

    await submitLine(tui, '/cancel');
    await expect(tui.waitForExit()).resolves.toBe(0);
  }, 120_000);

  it.each(['missing', 'unreadable'] as const)(
    'should route a %s Doctor report through needs_fix before returning to the Maker TUI',
    async (doctorState, context) => {
      const scenarioPath = join(testRepo.path, `workflow-maker-doctor-${doctorState}.json`);
      writeFileSync(scenarioPath, JSON.stringify([
        { persona: 'interactive', status: 'done', content: 'TUI-MAKER-DOCTOR-REPLY' },
        { persona: 'interactive', status: 'done', content: 'Run the Doctor boundary scenario.' },
        { status: 'done', content: 'The isolated workflow artifact is implemented.' },
        { status: 'done', content: '# Workflow Maker Doctor Report\n\n## Validation\n- Result: PASS\n' },
        { persona: 'conductor', status: 'done', content: '[CREATE:DOCTOR-BOUNDARY]' },
        {
          status: 'done',
          content: 'The artifact and Doctor result satisfy the request.',
          mismatch_content: 'The Doctor report is unavailable.',
          delay_ms: 2_000,
          file_condition: {
            filename: 'workflow-maker-doctor.md',
            state: 'readable',
            includes: 'Result: PASS',
          },
        },
        {
          status: 'done',
          content: '# Workflow Maker Review\n\n## Verdict\napproved\n',
          mismatch_content: '# Workflow Maker Review\n\n## Verdict\nneeds_fix\n',
          file_condition: {
            filename: 'workflow-maker-doctor.md',
            state: 'readable',
            includes: 'Result: PASS',
          },
        },
        {
          persona: 'conductor',
          status: 'done',
          content: '[REVIEW:1]',
          mismatch_content: '[REVIEW:2]',
          file_condition: {
            filename: 'workflow-maker-doctor.md',
            state: 'readable',
            includes: 'Result: PASS',
          },
        },
        { status: 'error', content: `FIX-REACHED-AFTER-${doctorState.toUpperCase()}-DOCTOR` },
      ]), 'utf-8');
      const tui = start(scenarioPath, ['make']);

      await chooseHighlighted(tui, 'Select a Workflow Maker base:');
      await tui.waitForOutput('Workflow name', 5_000);
      tui.write(`doctor-${doctorState}-flow`);
      tui.write(ENTER);
      await tui.waitForOutput(TUI_HINT, 10_000);
      await submitLine(tui, `exercise the ${doctorState} Doctor report`);
      await tui.waitForOutput('TUI-MAKER-DOCTOR-REPLY');
      await submitLine(tui, '/go');
      await waitForSelector(tui, ACTION_PROMPT);
      tui.write(ENTER);
      await tui.waitForScreen(
        `the ${doctorState} Doctor scenario to start`,
        (screen) => hasExactVisibleLine(screen, WORKFLOW_MAKER_WAIT_EN),
        10_000,
      );

      const doctorReport = await waitForFile(
        join(testRepo.path, '.takt', 'make'),
        'workflow-maker-doctor.md',
      );
      if (doctorState === 'missing') {
        rmSync(doctorReport);
      } else {
        chmodSync(doctorReport, 0o000);
        let readable = true;
        try {
          readFileSync(doctorReport, 'utf-8');
        } catch {
          readable = false;
        }
        if (readable) {
          chmodSync(doctorReport, 0o644);
          await tui.dispose();
          context.skip();
          return;
        }
      }

      await tui.waitForScreen(
        `the ${doctorState} Doctor scenario to reach fix and return`,
        (screen) => screen.includes(`FIX-REACHED-AFTER-${doctorState.toUpperCase()}-DOCTOR`)
          && screen.includes(TUI_HINT),
        90_000,
      );
      const reviewReport = await waitForFile(
        join(testRepo.path, '.takt', 'make'),
        'workflow-maker-review.md',
      );
      expect(readFileSync(reviewReport, 'utf-8')).toContain('needs_fix');
      await submitLine(tui, '/cancel');
      await expect(tui.waitForExit()).resolves.toBe(0);
    },
    120_000,
  );

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
    await tui.waitForScreen(
      'the queued answer to finish and the input prompt to return',
      (currentScreen) => !currentScreen.includes(THINKING_MARKER)
        && currentScreen.includes(PLACEHOLDER),
      60_000,
    );

    // The queued line was sent and answered, and the queue is empty again.
    const transcript = (await tui.visibleTranscript()).join('\n');
    expect(transcript).toContain('❯ after the interrupt');
    expect(transcript).not.toContain(QUEUE_HINT);

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
