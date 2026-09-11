import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeEvent {
  readonly type: string;
  readonly target?: FakeNode;
  readonly button?: number;
  readonly key?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  preventDefault: () => void;
  composedPath?: () => FakeNode[];
}

type Listener = (event: FakeEvent) => void;

class FakeNode {
  readonly children: FakeNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  readonly style = {
    height: '',
    overflowY: '',
    setProperty: (property: string, value: string) => {
      (this.style as unknown as Record<string, string>)[property] = value;
    },
    getPropertyValue: (_property: string) => '',
  };
  parent: FakeNode | null = null;
  className = '';
  private ownTextContent = '';
  value = '';
  placeholder = '';
  title = '';
  type = '';
  name = '';
  id = '';
  hidden = false;
  disabled = false;
  selected = false;
  open = false;
  inert = false;
  checked = false;
  scrollHeight = 24;
  scrollTop = 0;
  clientWidth = 900;
  offsetWidth = 344;
  offsetHeight = 600;

  constructor(
    readonly tagName: string,
    private readonly ownerDocument: FakeDocument,
  ) {}

  get options() {
    return this.children.filter((child) => child.tagName === 'OPTION');
  }

  get textContent() {
    return this.ownTextContent + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownTextContent = value;
  }

  get selectedOptions() {
    return this.options.filter((option) => option.selected);
  }

  get classList() {
    return {
      toggle: (name: string, force?: boolean) => {
        const names = new Set(this.className.split(/\s+/u).filter(Boolean));
        const enabled = force ?? !names.has(name);
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(' ');
        return enabled;
      },
      contains: (name: string) => this.className.split(/\s+/u).includes(name),
    };
  }

  append(...nodes: FakeNode[]) {
    for (const node of nodes.flat()) {
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeNode[]) {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.append(...nodes);
  }

  remove() {
    if (this.parent === null) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: unknown) {
    if (typeof listener !== 'function') return;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as Listener]);
  }

  dispatchEvent(eventOrType: FakeEvent | string) {
    const event: FakeEvent = typeof eventOrType === 'string'
      ? { type: eventOrType, target: this, preventDefault: () => {} }
      : eventOrType;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }

  requestSubmit() {
    this.dispatchEvent({ type: 'submit', target: this, preventDefault: () => {} });
  }

  focus() {
    if (!this.disabled && this.ownerDocument.body.contains(this)) {
      this.ownerDocument.activeElement = this;
    }
  }

  contains(target: unknown): boolean {
    return target === this || this.children.some((child) => child.contains(target));
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/gu, (_match, character: string) => character.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
    const dataAttribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/u);
    if (dataAttribute !== null) {
      const name = dataAttribute[1]!;
      const expected = dataAttribute[2];
      const actual = name.startsWith('data-')
        ? this.dataset[name.slice(5).replace(/-([a-z])/gu, (_match, character: string) => character.toUpperCase())]
        : this.attributes[name];
      return actual !== undefined && (expected === undefined || actual === expected);
    }
    const id = selector.match(/^#([\w-]+)$/u);
    if (id !== null) return this.id === id[1];
    const classMatch = selector.match(/^(?:([a-z]+))?\.([\w-]+)$/iu);
    if (classMatch !== null) {
      return (classMatch[1] === undefined || this.tagName === classMatch[1].toUpperCase())
        && this.classList.contains(classMatch[2]!);
    }
    return selector === this.tagName.toLowerCase();
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatchEvent({ type: 'close', target: this, preventDefault: () => {} });
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600 };
  }
}

class FakeDocument {
  readonly body = new FakeNode('BODY', this);
  readonly documentElement = new FakeNode('HTML', this);
  readonly nodes = new Map<string, FakeNode>();
  readonly listeners = new Map<string, Listener[]>();
  activeElement: FakeNode | null = null;
  visibilityState = 'visible';

  addElement(selector: string, node: FakeNode) {
    this.nodes.set(selector, node);
    this.body.append(node);
    return node;
  }

  createElement(tagName: string) {
    return new FakeNode(tagName.toUpperCase(), this);
  }

  createElementNS(_namespace: string, tagName: string) {
    return this.createElement(tagName);
  }

  createTextNode(text: string) {
    const node = this.createElement('#text');
    node.textContent = text;
    return node;
  }

  querySelector(selector: string) {
    if (selector === '#execution-context > summary') return this.nodes.get('#execution-context-summary') ?? null;
    return this.nodes.get(selector) ?? this.body.querySelector(selector);
  }

  querySelectorAll(selector: string) {
    return this.body.querySelectorAll(selector);
  }

  addEventListener(type: string, listener: unknown) {
    if (typeof listener !== 'function') return;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as Listener]);
  }

  dispatchEvent(event: FakeEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

interface RequestRecord {
  readonly path: string;
  readonly options?: RequestInit;
}

const harness = vi.hoisted(() => ({
  executionViewOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock('../../web-ui/public/execution-view.js', () => ({
  createExecutionView: (options: Record<string, unknown>) => {
    harness.executionViewOptions = options;
    return {
      prepareRunSelection: vi.fn(),
      refreshLocale: vi.fn(),
      renderDetail: vi.fn(),
      renderPlaceholder: vi.fn(),
      renderTaskList: vi.fn(),
      setLiveState: vi.fn(),
    };
  },
}));

vi.mock('../../web-ui/public/live-stream.js', () => ({
  subscribeRun: vi.fn(() => () => {}),
  subscribeTasks: vi.fn(() => () => {}),
}));

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: null,
  };
}

function streamResponse(reply: unknown) {
  const payload = new TextEncoder().encode(`${JSON.stringify({ type: 'reply', reply })}\n`);
  let read = false;
  return {
    ok: true,
    status: 200,
    json: async () => null,
    body: {
      getReader: () => ({
        read: async () => {
          if (read) return { done: true, value: undefined };
          read = true;
          return { done: false, value: payload };
        },
      }),
    },
  };
}

const assistantMarkdown = [
  '# 見出し',
  '',
  '- 箇条書き',
  '- 二つ目',
  '',
  '1. 番号付き',
  '2. 二つ目',
  '',
  '**太字** と `インライン` と [リンク](https://example.com)',
  '続き',
  '',
  '```js',
  'const value = 1;',
  '```',
].join('\n');

const fencedCodeCases = [
  ['言語名付き', '```js\n# 見出し\n- 項目\n**太字**\n```'],
  ['言語名なし', '```\n# 見出し\n- 項目\n**太字**\n```'],
  ['閉じられていない', '```\n# 見出し\n- 項目\n**太字**'],
] as const;

const literalMessage = '# 通知\n**原文**\n- 項目\n次の行';

function createDocument() {
  const document = new FakeDocument();
  const selectors = [
    '#connection-status', '#category', '#chat-form', '#chat-go-button', '#chat-setup-button',
    '#chat-collapse-button', '#chat-surface', '#chat-surface-description', '#chat-surface-label',
    '#chat-task-action-context', '#chat-task-action-options', '#chat-title', '#chat-message',
    '#chat-mode', '#chat-new-button', '#chat-send-button', '#chat-session-meta',
    '#chat-message-status', '#chat-thinking', '#chat-thinking-content', '#chat-thinking-label',
    '#chat-thinking-state', '#chat-transcript', '#directory-cancel-button', '#directory-close-button',
    '#directory-current-path', '#directory-dialog', '#directory-go-button', '#directory-list',
    '#directory-message', '#directory-native-picker-button', '#directory-parent-button',
    '#directory-picker-button', '#directory-select-button', '#execution-context',
    '#execution-context-summary', '#language-toggle', '#new-task-button', '#viewer-nav',
    '#viewer-screen', '#mobile-task-list-button', '#mobile-inspector-button', '#task-count',
    '#task-sidebar-toggle',
    '#project', '#project-help', '#refresh-button', '#run-detail', '#run-inspector',
    '#inspector-resizer', '#run-status-live', '#run-list', '#run-list-empty', '#run-warning',
    '#watch-button', '#workflow',
  ];
  for (const selector of selectors) document.addElement(selector, document.createElement(
    selector === '#chat-form' ? 'form' : selector === '#chat-message' ? 'textarea' : 'div',
  ));
  document.addElement('.task-sidebar', document.createElement('aside'));
  const summary = document.nodes.get('#execution-context-summary');
  const context = document.nodes.get('#execution-context');
  if (summary !== undefined && context !== undefined) context.append(summary);
  const chatMode = document.nodes.get('#chat-mode');
  if (chatMode !== undefined) {
    const option = document.createElement('option');
    option.value = 'assistant';
    option.selected = true;
    chatMode.append(option);
  }
  const viewerScreen = document.nodes.get('#viewer-screen');
  if (viewerScreen !== undefined) viewerScreen.style.getPropertyValue = (property: string) => {
    if (property === '--sidebar-width') return '292px';
    if (property === '--inspector-resizer-width') return '8px';
    if (property === '--inspector-min-width') return '280px';
    return '';
  };
  const taskSidebar = document.nodes.get('.task-sidebar');
  if (taskSidebar !== undefined) taskSidebar.style.getPropertyValue = () => '292px';
  return document;
}

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function deferResponse() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function retryChatSession() {
  return {
    id: 'retry-session',
    workflow: 'default',
    mode: 'assistant',
    intro: '',
    provider: 'mock',
    taskAction: {
      taskId: 'task-1',
      action: 'retry',
      generation: 1,
      retryStartOptions: {
        defaultId: 'restart:plan',
        options: [{ id: 'restart:plan', label: 'plan', selectable: true }],
      },
    },
  };
}

describe('Web UI Retry 本番 DOM 経路', () => {
  const requests: RequestRecord[] = [];
  let document: FakeDocument;
  let messageRequests = 0;
  let goRequests = 0;
  let cancelRequests = 0;
  let failNextQueueRequest = false;
  let continueRequestGate: Promise<void> | undefined;
  let cancelRequestGate: Promise<void> | undefined;
  let nextAssistantReply = assistantMarkdown;
  const task = {
    projectId: 'project-1',
    taskId: 'task-1',
    task: 'original order',
    status: 'failed',
    workflow: 'default',
    runs: [],
  };

  async function startRetry() {
    const options = harness.executionViewOptions;
    if (options === undefined) throw new Error('execution view was not initialized');
    const button = document.createElement('button');
    const onAction = options.onAction as (targetTask: typeof task, action: string, button: FakeNode) => void;
    onAction(task, 'retry', button);
    await flush();
  }

  beforeEach(async () => {
    vi.resetModules();
    requests.length = 0;
    messageRequests = 0;
    goRequests = 0;
    cancelRequests = 0;
    failNextQueueRequest = false;
    continueRequestGate = undefined;
    cancelRequestGate = undefined;
    nextAssistantReply = assistantMarkdown;
    document = createDocument();
    const window = {
      addEventListener: vi.fn(),
      clearTimeout,
      innerWidth: 1200,
      matchMedia: () => ({ matches: true }),
      setTimeout,
    };
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('getComputedStyle', () => ({
      minHeight: '24px',
      maxHeight: '320px',
      getPropertyValue: (property: string) => property === '--inspector-min-width' ? '280px' : '',
    }));
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => callback(0));
    vi.stubGlobal('fetch', async (input: string | URL | Request, options?: RequestInit) => {
      const path = String(input);
      requests.push({ path, options });
      if (path === '/api/session') {
        return jsonResponse({ token: 'web-token', capabilities: { nativeDirectoryPicker: false } });
      }
      if (path === '/api/projects') return jsonResponse({ projects: [], warnings: [] });
      if (path === '/api/tasks') {
        return jsonResponse({ tasks: [task], warnings: [] });
      }
      if (path === '/api/tasks/task-1/actions/retry') {
        const body = JSON.parse(String(options?.body ?? '{}')) as { input?: string };
        if (body.input === undefined) {
          return jsonResponse({
            status: 'conversation',
            taskStatus: 'failed',
            chatSession: retryChatSession(),
          });
        }
        if (failNextQueueRequest) {
          failNextQueueRequest = false;
          return jsonResponse({ error: 'queue failed' }, 500);
        }
        return jsonResponse({ status: 'accepted', taskStatus: 'pending' });
      }
      if (path === '/api/chat/sessions/retry-session/messages') {
        messageRequests += 1;
        const body = JSON.parse(String(options?.body ?? '{}')) as { text?: string };
        if (body.text === '/retry' || body.text === '/replay') {
          return streamResponse({ kind: 'assistant_response', content: `${body.text} handled in chat` });
        }
        if (body.text === '/system') {
          return streamResponse({ kind: 'error', message: literalMessage });
        }
        if (body.text === '/markdown' || body.text === '/code' || body.text === '/inline-code') {
          return streamResponse({ kind: 'assistant_response', content: nextAssistantReply });
        }
        if (body.text !== '/go') {
          return streamResponse({ kind: 'assistant_response', content: 'additional response' });
        }
        goRequests += 1;
        const task = goRequests === 1 ? 'updated order' : 'updated order again';
        return streamResponse({
          kind: 'task_instruction',
          task,
          taskAction: { sessionId: 'retry-session', taskId: 'task-1', action: 'retry' },
          taskActionOptionId: 'restart:plan',
        });
      }
      if (path === '/api/chat/sessions/retry-session/restart') return jsonResponse(retryChatSession());
      if (path === '/api/chat/sessions/retry-session/continue') {
        if (continueRequestGate !== undefined) await continueRequestGate;
        return jsonResponse({ status: 'continued' });
      }
      if (path === '/api/chat/sessions/retry-session/cancel') {
        cancelRequests += 1;
        if (cancelRequestGate !== undefined) await cancelRequestGate;
        return cancelRequests === 1
          ? jsonResponse({ error: 'cancel failed' }, 409)
          : jsonResponse({ status: 'cancelled' });
      }
      throw new Error(`Unexpected Web UI request: ${path}`);
    });
    await import('../../web-ui/public/app.js');
    await flush();
  });

  async function submitChat(text: string) {
    const message = document.nodes.get('#chat-message');
    const form = document.nodes.get('#chat-form');
    if (message === undefined || form === undefined) {
      throw new Error('Chat DOM elements were not initialized');
    }
    message.value = text;
    form.requestSubmit();
    await flush();
  }

  function chatTranscript() {
    const transcript = document.nodes.get('#chat-transcript');
    if (transcript === undefined) throw new Error('Chat transcript was not initialized');
    return transcript;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders assistant responses with the existing Markdown elements', async () => {
    await startRetry();
    await submitChat('/markdown');

    const entry = chatTranscript().querySelector('article.chat-entry-assistant');
    if (entry === null) throw new Error('Assistant chat entry was not rendered');
    const markdown = entry.querySelector('.markdown-view');
    if (markdown === null) throw new Error('Assistant Markdown view was not rendered');

    expect(markdown.querySelector('h1')?.textContent).toBe('見出し');
    expect(markdown.querySelector('ul')?.querySelectorAll('li').map((item) => item.textContent))
      .toEqual(['箇条書き', '二つ目']);
    expect(markdown.querySelector('ol')?.querySelectorAll('li').map((item) => item.textContent))
      .toEqual(['番号付き', '二つ目']);
    expect(markdown.querySelector('strong')?.textContent).toBe('太字');
    expect(markdown.querySelectorAll('code')[0]?.textContent).toBe('インライン');
    const link = markdown.querySelector('a');
    if (link === null) throw new Error('Markdown link was not rendered');
    expect(link.textContent).toBe('リンク');
    expect(Reflect.get(link, 'href')).toBe('https://example.com');
    expect(markdown.querySelector('p')?.textContent).toBe('太字 と インライン と リンク 続き');
    expect(markdown.querySelector('pre')?.querySelector('code')?.textContent)
      .toBe('const value = 1;');
  });

  it.each(fencedCodeCases)('keeps Markdown syntax inside %s fenced code', async (_caseName, source) => {
    nextAssistantReply = source;
    await startRetry();
    await submitChat('/code');

    const entry = chatTranscript().querySelector('article.chat-entry-assistant');
    if (entry === null) throw new Error('Assistant chat entry was not rendered');
    const markdown = entry.querySelector('.markdown-view');
    if (markdown === null) throw new Error('Assistant Markdown view was not rendered');

    expect(markdown.querySelectorAll('h1')).toHaveLength(0);
    expect(markdown.querySelectorAll('ul')).toHaveLength(0);
    expect(markdown.querySelectorAll('strong')).toHaveLength(0);
    expect(markdown.querySelector('pre')?.querySelector('code')?.textContent)
      .toBe('# 見出し\n- 項目\n**太字**');
  });

  it('keeps emphasis syntax inside inline code as code text', async () => {
    nextAssistantReply = '`**太字**`';
    await startRetry();
    await submitChat('/inline-code');

    const entry = chatTranscript().querySelector('article.chat-entry-assistant');
    if (entry === null) throw new Error('Assistant chat entry was not rendered');
    const markdown = entry.querySelector('.markdown-view');
    if (markdown === null) throw new Error('Assistant Markdown view was not rendered');

    expect(markdown.querySelectorAll('strong')).toHaveLength(0);
    expect(markdown.querySelector('code')?.textContent).toBe('**太字**');
  });

  it('keeps Markdown syntax and line breaks literal for user messages', async () => {
    await startRetry();
    await submitChat(literalMessage);

    const entry = chatTranscript().querySelector('article.chat-entry-user');
    if (entry === null) throw new Error('User chat entry was not rendered');
    expect(entry.querySelector('.markdown-view')).toBeNull();
    expect(entry.querySelector('p')?.textContent).toBe(literalMessage);
    expect(entry.querySelectorAll('h1')).toHaveLength(0);
    expect(entry.querySelectorAll('strong')).toHaveLength(0);
    expect(entry.querySelectorAll('ul')).toHaveLength(0);
  });

  it('keeps Markdown syntax and line breaks literal for system messages', async () => {
    await startRetry();
    await submitChat('/system');

    const entries = chatTranscript().querySelectorAll('article.chat-entry-system');
    const entry = entries.at(-1);
    if (entry === undefined) throw new Error('System chat entry was not rendered');
    expect(entry.querySelector('.markdown-view')).toBeNull();
    expect(entry.querySelector('p')?.textContent).toBe(literalMessage);
    expect(entry.querySelectorAll('h1')).toHaveLength(0);
    expect(entry.querySelectorAll('strong')).toHaveLength(0);
    expect(entry.querySelectorAll('ul')).toHaveLength(0);
  });

  it('connects Queue, Continue, Cancel, and prose input through the production app and API modules', async () => {
    const html = readFileSync(new URL('../../web-ui/public/index.html', import.meta.url), 'utf8');
    expect(html).toContain('id="chat-form"');
    expect(html).toContain('id="chat-task-action-options"');
    await startRetry();

    const message = document.nodes.get('#chat-message');
    const form = document.nodes.get('#chat-form');
    const reviewOptions = document.nodes.get('#chat-task-action-options');
    const languageToggle = document.nodes.get('#language-toggle');
    if (message === undefined || form === undefined || reviewOptions === undefined
      || languageToggle === undefined) {
      throw new Error('Retry DOM elements were not initialized');
    }
    message.value = '/go';
    form.requestSubmit();
    await flush();

    const reviewButtons = reviewOptions.querySelectorAll('button.chat-task-action-review-button');
    expect(reviewOptions.textContent).toContain('更新後の指示書を確認してください。');
    expect(reviewButtons.map((entry) => entry.textContent)).toEqual([
      'タスクにつむ',
      '編集を続ける',
      'キャンセル',
    ]);
    expect(document.activeElement).toBe(reviewButtons[0]);
    const { t } = await import('../../web-ui/public/i18n.js');
    expect(document.nodes.get('#chat-message-status')?.textContent).toBe(t('app.taskActionReviewPrompt'));
    expect(reviewOptions.querySelector('select')?.disabled).toBe(true);
    expect(requests.filter((request) => request.path.endsWith('/actions/retry'))).toHaveLength(1);
    expect(document.nodes.get('#chat-transcript')?.textContent).toContain('updated order');

    message.focus();
    languageToggle.dispatchEvent('click');
    expect(document.activeElement).toBe(message);
    languageToggle.dispatchEvent('click');
    expect(document.activeElement).toBe(message);

    const reviewingRequestCount = requests.length;
    message.value = '説明文の /cancel 表記を修正';
    message.dispatchEvent('input');
    expect(document.nodes.get('#chat-send-button')?.disabled).toBe(true);
    form.requestSubmit();
    await flush();
    expect(requests).toHaveLength(reviewingRequestCount);

    message.value = '/cancel';
    message.dispatchEvent('input');
    expect(document.nodes.get('#chat-send-button')?.disabled).toBe(false);
    message.dispatchEvent({
      type: 'keydown',
      target: message,
      key: 'Enter',
      ctrlKey: true,
      preventDefault: () => {},
    });
    await flush();
    expect(cancelRequests).toBe(1);
    expect(reviewOptions.hidden).toBe(false);
    expect(message.value).toBe('/cancel');
    expect(document.nodes.get('#chat-send-button')?.disabled).toBe(false);

    reviewButtons[1]?.dispatchEvent('click');
    await flush();
    expect(reviewOptions.querySelectorAll('button.chat-task-action-review-button')).toHaveLength(1);
    expect(reviewOptions.querySelector('select')?.disabled).toBe(false);
    expect(requests.some((request) => request.path.endsWith('/continue'))).toBe(true);

    message.value = '/retry';
    message.dispatchEvent('input');
    form.requestSubmit();
    await flush();
    message.value = '/replay';
    message.dispatchEvent('input');
    form.requestSubmit();
    await flush();
    message.value = '/go';
    message.dispatchEvent('input');
    form.requestSubmit();
    await flush();
    expect(requests.filter((request) => request.path.endsWith('/actions/retry'))).toHaveLength(1);
    expect(messageRequests).toBe(4);

    message.value = '/cancel';
    message.dispatchEvent('input');
    form.requestSubmit();
    await flush();
    expect(cancelRequests).toBe(2);
    expect(reviewOptions.hidden).toBe(true);
    expect(message.value).toBe('');

    await startRetry();
    message.value = '/go';
    message.dispatchEvent('input');
    form.requestSubmit();
    await flush();
    const queueButtons = reviewOptions.querySelectorAll('button.chat-task-action-review-button');
    queueButtons[0]?.dispatchEvent('click');
    await flush();
    const queueRequest = requests.find((request) => request.path.endsWith('/actions/retry')
      && request.options?.body?.toString().includes('updated order again'));
    expect(queueRequest).toBeDefined();
    expect(JSON.parse(queueRequest?.options?.body?.toString() ?? '{}')).toMatchObject({
      projectId: 'project-1',
      input: 'updated order again',
      conversationId: 'retry-session',
      taskActionOptionId: 'restart:plan',
    });
    expect(messageRequests).toBe(5);
  });

  it.each(['continue', 'cancel'] as const)('sends only one request while %s is pending and allows another operation afterward', async (action) => {
    await startRetry();
    const message = document.nodes.get('#chat-message');
    const form = document.nodes.get('#chat-form');
    const reviewOptions = document.nodes.get('#chat-task-action-options');
    if (message === undefined || form === undefined || reviewOptions === undefined) {
      throw new Error('Retry DOM elements were not initialized');
    }
    message.value = '/go';
    message.dispatchEvent('input');
    form.requestSubmit();
    await flush();

    const response = deferResponse();
    if (action === 'continue') continueRequestGate = response.promise;
    else cancelRequestGate = response.promise;
    const buttonIndex = action === 'continue' ? 1 : 2;
    const reviewButtons = reviewOptions.querySelectorAll('button.chat-task-action-review-button');
    expect(reviewButtons).toHaveLength(3);
    const requestsBeforeAction = requests.length;
    try {
      reviewButtons[buttonIndex]!.dispatchEvent('click');
      reviewButtons[buttonIndex]!.dispatchEvent('click');
      for (const button of reviewButtons) button.dispatchEvent('click');
      await flush();

      expect(requests.slice(requestsBeforeAction).map((request) => request.path))
        .toEqual([`/api/chat/sessions/retry-session/${action}`]);
      expect(reviewOptions.querySelectorAll('button.chat-task-action-review-button')).toHaveLength(3);
      expect(reviewOptions.querySelector('select')?.disabled).toBe(true);
    } finally {
      response.release();
      await flush();
    }

    if (action === 'continue') {
      expect(reviewOptions.querySelector('select')?.disabled).toBe(false);
      message.value = '/go';
      message.dispatchEvent('input');
      form.requestSubmit();
      await flush();
    } else {
      expect(document.nodes.get('#chat-message-status')?.textContent).toBe('cancel failed');
    }
    const nextButtons = reviewOptions.querySelectorAll('button.chat-task-action-review-button');
    expect(nextButtons).toHaveLength(3);
    nextButtons[buttonIndex]!.dispatchEvent('click');
    await flush();

    expect(requests.filter((request) => request.path.endsWith(`/${action}`))).toHaveLength(2);
    if (action === 'continue') {
      expect(reviewOptions.querySelector('select')?.disabled).toBe(false);
      expect(document.activeElement).toBe(message);
    } else {
      expect(reviewOptions.hidden).toBe(true);
    }
  });

  it('shows queue failures and allows restarting the Retry conversation and queueing again', async () => {
    await startRetry();
    const message = document.nodes.get('#chat-message');
    const form = document.nodes.get('#chat-form');
    const reviewOptions = document.nodes.get('#chat-task-action-options');
    const restart = document.nodes.get('#chat-new-button');
    const status = document.nodes.get('#chat-message-status');
    if (message === undefined || form === undefined || reviewOptions === undefined
      || restart === undefined || status === undefined) {
      throw new Error('Retry DOM elements were not initialized');
    }
    message.value = '/go';
    message.dispatchEvent('input');
    form.requestSubmit();
    await flush();

    failNextQueueRequest = true;
    const queue = reviewOptions.querySelector('button.chat-task-action-review-button');
    expect(queue).not.toBeNull();
    queue?.dispatchEvent('click');
    expect(message.disabled).toBe(true);
    expect(restart.disabled).toBe(true);
    expect(reviewOptions.querySelector('select')?.disabled).toBe(true);
    await flush();

    expect(status.textContent).toBe('queue failed');
    expect(reviewOptions.querySelectorAll('button.chat-task-action-review-button')).toHaveLength(0);
    expect(reviewOptions.querySelector('select')?.disabled).toBe(false);
    expect(message.disabled).toBe(false);
    expect(restart.disabled).toBe(false);
    expect(document.nodes.get('#chat-go-button')?.disabled).toBe(false);
    expect(document.nodes.get('#chat-send-button')?.disabled).toBe(false);

    restart.dispatchEvent('click');
    await flush();
    expect(requests.filter((request) => request.path.endsWith('/restart'))).toHaveLength(1);
    expect(reviewOptions.querySelectorAll('button.chat-task-action-review-button')).toHaveLength(1);
    expect(document.activeElement).toBe(message);
    message.value = '/go';
    message.dispatchEvent('input');
    form.requestSubmit();
    await flush();
    const retryQueue = reviewOptions.querySelector('button.chat-task-action-review-button');
    expect(retryQueue).not.toBeNull();
    expect(document.activeElement).toBe(retryQueue);
    retryQueue?.dispatchEvent('click');
    await flush();

    const queueRequests = requests.filter((request) => request.path.endsWith('/actions/retry')
      && request.options?.body?.toString().includes('conversationId'));
    expect(queueRequests).toHaveLength(2);
    const { t } = await import('../../web-ui/public/i18n.js');
    expect(status.textContent).toBe(t('app.taskActionCompleted'));
    expect(message.disabled).toBe(true);
    expect(restart.disabled).toBe(true);
    expect(reviewOptions.querySelector('select')?.disabled).toBe(true);
  });
});
