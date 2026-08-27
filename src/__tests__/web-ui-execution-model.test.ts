import { describe, expect, it } from 'vitest';
import {
  buildExecutionTrace,
  encodeIdPart,
  isBuiltinWorkflowRef,
  reportDirectory,
  reportDisplayName,
  shortBuiltinDigest,
  workflowDisplayName,
} from '../../web-ui/public/execution-model.js';
import type { ExecutionEvent, ExecutionStackFrame } from '../../web-ui/public/execution-model.js';
import {
  MAX_MAP_SCALE,
  MIN_MAP_SCALE,
  clampMapScale,
  curvePath,
  disposeExecutionMap,
  edgeAnchorGeometry,
  parallelGroupPresentationOrdinal,
  renderExecutionMap,
  updateExecutionMapSelection,
} from '../../web-ui/public/execution-map.js';
import {
  createExecutionView,
  resolveLogSelection,
} from '../../web-ui/public/execution-view.js';

class FakeDomNode {
  className = '';
  textContent = '';
  children: FakeDomNode[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  style: {
    left: string;
    top: string;
    width: string;
    height: string;
    transform: string;
    transformOrigin: string;
    userSelect: string;
    setProperty: (property: string, value: string) => void;
  } = {
    left: '',
    top: '',
    width: '',
    height: '',
    transform: '',
    transformOrigin: '',
    userSelect: '',
    setProperty(property, value) {
      if (property === 'transform-origin') this.transformOrigin = value;
      else if (property === 'user-select') this.userSelect = value;
      else if (property in this) {
        (this as unknown as Record<string, unknown>)[property] = value;
      }
    },
  };
  offsetWidth = 220;
  offsetHeight = 136;
  scrollLeft = 0;
  scrollTop = 0;
  scrollWidth = 640;
  scrollHeight = 320;
  rect: {
    left: number;
    top: number;
    right: number;
    bottom?: number;
    width: number;
    height: number;
  } = { left: 0, top: 0, right: 80, width: 80, height: 24 };
  listeners = new Map<string, Array<(event?: Record<string, unknown>) => void>>();
  pointerCaptures = new Set<number>();

  constructor(readonly tagName: string) {}

  append(...children: FakeDomNode[]) {
    this.children.push(...children.flat().filter(Boolean));
  }

  addEventListener(type: string, listener: unknown) {
    if (typeof listener === 'function') {
      const listeners = this.listeners.get(type) ?? [];
      this.listeners.set(type, [...listeners, listener as (event?: Record<string, unknown>) => void]);
    }
  }

  removeEventListener(type: string, listener: unknown) {
    const listeners = this.listeners.get(type);
    if (listeners === undefined) return;
    const next = listeners.filter((candidate) => candidate !== listener);
    if (next.length === 0) this.listeners.delete(type);
    else this.listeners.set(type, next);
  }

  dispatchEvent(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  focus() {
    const document = (globalThis as unknown as {
      document?: {
        activeElement: FakeDomNode | null;
        dispatchEvent?: (type: string, event?: Record<string, unknown>) => void;
      };
    }).document;
    if (document === undefined) return;
    document.activeElement = this;
    document.dispatchEvent?.('focusin', { target: this });
  }

  setPointerCapture(pointerId: number) {
    this.pointerCaptures.add(pointerId);
  }

  hasPointerCapture(pointerId: number) {
    return this.pointerCaptures.has(pointerId);
  }

  releasePointerCapture(pointerId: number) {
    this.pointerCaptures.delete(pointerId);
  }

  replaceChildren(...children: FakeDomNode[]) {
    const document = (globalThis as unknown as {
      document?: { activeElement: FakeDomNode | null };
    }).document;
    if (document !== undefined
      && document.activeElement !== null
      && this.contains(document.activeElement)) {
      // Browsers move focus to the document body when a focused subtree is
      // replaced. Keep the fake DOM aligned with that behavior so focus
      // restoration is tested against the real replacement boundary.
      document.activeElement = null;
    }
    this.children = children;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) {
      const datasetName = name.slice(5).replace(/-([a-z])/gu, (_match, character: string) => character.toUpperCase());
      this.dataset[datasetName] = value;
    }
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  matches(selector: string) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('[')) {
      const [, name, value] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) ?? [];
      if (name === undefined) return false;
      const dataName = name.startsWith('data-')
        ? name.slice(5).replace(/-([a-z])/gu, (_match, character: string) => character.toUpperCase())
        : undefined;
      const actual = dataName === undefined ? this.attributes[name] : this.dataset[dataName];
      return value === undefined ? actual !== undefined : actual === value;
    }
    return false;
  }

  querySelectorAll(selector: string): FakeDomNode[] {
    return this.children.flatMap((child) => [
      ...(child.matches?.(selector) ? [child] : []),
      ...(child.querySelectorAll?.(selector) ?? []),
    ]);
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  contains(target: unknown): boolean {
    return target === this || this.children.some((child) => child.contains(target));
  }
}

class FakeDomDocument {
  activeElement: FakeDomNode | null = null;
  listeners = new Map<string, Array<(event?: Record<string, unknown>) => void>>();

  addEventListener(type: string, listener: unknown) {
    if (typeof listener !== 'function') return;
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...listeners, listener as (event?: Record<string, unknown>) => void]);
  }

  removeEventListener(type: string, listener: unknown) {
    const listeners = this.listeners.get(type);
    if (listeners === undefined) return;
    const next = listeners.filter((candidate) => candidate !== listener);
    if (next.length === 0) this.listeners.delete(type);
    else this.listeners.set(type, next);
  }

  dispatchEvent(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  createElement(tagName: string) {
    return new FakeDomNode(tagName);
  }

  createElementNS(_namespace: string, tagName: string) {
    return new FakeDomNode(tagName);
  }

  createTextNode(text: string) {
    const node = new FakeDomNode('#text');
    node.textContent = text;
    return node;
  }
}

describe('Web UI execution model', () => {
  it('builds lanes from chronological events and groups phases by logical step and pass', () => {
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running', currentStep: 'review', currentIteration: 2 },
      [
        { type: 'phase_start', step: 'review', phaseName: 'execute', iteration: 2 },
        { type: 'step_start', step: 'review', persona: 'Reviewer', iteration: 2 },
        { type: 'step_complete', step: 'plan', status: 'done', iteration: 1 },
        { type: 'step_start', step: 'plan', iteration: 1 },
      ],
    );

    expect(trace.events.map((event) => event.type)).toEqual([
      'step_start',
      'step_complete',
      'step_start',
      'phase_start',
    ]);
    expect(trace.lanes).toHaveLength(1);
    expect(trace.lanes[0]).toMatchObject({
      workflow: 'default',
      depth: 0,
    });
    expect(trace.nodes).toHaveLength(2);

    const plan = trace.nodes.find((node) => node.label === 'plan');
    expect(plan).toMatchObject({
      kind: 'step',
      workflow: 'default',
      occurrences: [
        expect.objectContaining({
          iteration: 1,
          status: 'completed',
          eventIndexes: [0, 1],
        }),
      ],
    });

    const review = trace.nodes.find((node) => node.label === 'review');
    expect(review).toMatchObject({
      occurrences: [
        expect.objectContaining({
          iteration: 2,
          status: 'running',
          personas: ['Reviewer'],
          phases: ['execute'],
          eventIndexes: [2, 3],
        }),
      ],
    });
  });

  it('keeps the recorded result and judge stages on the ITER occurrence', () => {
    const chronologicalEvents: ExecutionEvent[] = [
      {
        type: 'step_start',
        step: 'review',
        iteration: 1,
        provider: 'codex',
        providerSource: 'step',
        model: 'gpt-test',
        modelSource: 'step',
      },
      {
        type: 'phase_judge_stage',
        step: 'review',
        stage: 1,
        method: 'structured_output',
        status: 'done',
        response: '{"step":1}',
      },
      {
        type: 'phase_judge_stage',
        step: 'review',
        stage: 2,
        method: 'text_fallback',
        status: 'done',
        response: 'APPROVE',
      },
      {
        type: 'step_complete',
        step: 'review',
        iteration: 1,
        status: 'done',
        matchedRuleIndex: 0,
        matchedRuleMethod: 'structured_output',
        matchMethod: 'structured_output',
        content: 'approved',
      },
    ];
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running' },
      chronologicalEvents.slice().reverse(),
    );
    const review = trace.nodes.find((node) => node.label === 'review');
    expect(review?.occurrences[0]).toMatchObject({
      matchedRuleIndex: 0,
      matchedRuleMethod: 'structured_output',
      matchMethod: 'structured_output',
      provider: 'codex',
      providerSource: 'step',
      model: 'gpt-test',
      modelSource: 'step',
      judgeStages: [
        { stage: 1, method: 'structured_output', status: 'done', response: '{"step":1}' },
        { stage: 2, method: 'text_fallback', status: 'done', response: 'APPROVE' },
      ],
    });

    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const chip = section.querySelectorAll('.iteration-chip')[0] as FakeDomNode | undefined;
      expect(chip?.querySelector('.iteration-chip-result')?.textContent).toBe('RESULT 1');
      expect(chip?.querySelector('.iteration-chip-status')).toBeNull();
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps repeated logical steps as chronological occurrences without synthetic self-loops', () => {
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running', currentStep: 'review', currentIteration: 2 },
      [
        { type: 'step_complete', step: 'review', status: 'done', iteration: 2 },
        { type: 'step_start', step: 'review', persona: 'Reviewer', iteration: 2 },
        { type: 'step_complete', step: 'plan', status: 'done', iteration: 1 },
        { type: 'step_start', step: 'plan', persona: 'Planner', iteration: 1 },
        { type: 'step_complete', step: 'review', status: 'done', iteration: 1 },
        { type: 'step_start', step: 'review', persona: 'Reviewer', iteration: 1 },
      ],
    );

    const review = trace.nodes.find((node) => node.label === 'review');
    expect(review?.occurrences.map((occurrence) => occurrence.iteration)).toEqual([1, 2]);
    expect(review?.occurrences.every((occurrence) => occurrence.status === 'completed')).toBe(true);
    expect(review?.occurrences.map((occurrence) => occurrence.ordinal)).toEqual([1, 3]);
    expect(review?.occurrences.map((occurrence) => occurrence.presentationOrdinal)).toEqual([1, 2]);
    expect(trace.nodes.find((node) => node.label === 'plan')?.occurrences[0]?.ordinal).toBe(2);
    expect(trace.nodes.find((node) => node.label === 'plan')?.occurrences[0]?.presentationOrdinal).toBe(1);
    expect(trace.loops).toEqual([
      expect.objectContaining({
        logicalId: trace.nodes.find((node) => node.label === 'plan')?.id,
        ordinal: 3,
      }),
    ]);
    expect(trace.transitions).toEqual([
      expect.objectContaining({
        kind: 'transition',
        source: review?.occurrences[0]?.id,
        target: trace.nodes.find((node) => node.label === 'plan')?.occurrences[0]?.id,
      }),
      expect.objectContaining({
        kind: 'loop',
        source: trace.nodes.find((node) => node.label === 'plan')?.occurrences[0]?.id,
        target: review?.occurrences[1]?.id,
      }),
    ]);
    expect(trace.totalOccurrences).toBe(3);
  });

  it('assigns ordinals and consecutive edges from event order even when iteration metadata is unreliable', () => {
    const events: ExecutionEvent[] = [
      { type: 'step_start', step: 'A', iteration: 9 },
      { type: 'step_start', step: 'B', iteration: 2 },
      { type: 'step_start', step: 'C', iteration: 2 },
      { type: 'step_start', step: 'A', iteration: 1 },
    ];
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running' },
      events.slice().reverse(),
    );
    const occurrences = trace.nodes
      .flatMap((node) => node.occurrences.map((occurrence) => ({ node, occurrence })))
      .sort((left, right) => left.occurrence.ordinal! - right.occurrence.ordinal!);

    expect(occurrences.map(({ node }) => node.label)).toEqual(['A', 'B', 'C', 'A']);
    expect(occurrences.map(({ occurrence }) => occurrence.ordinal)).toEqual([1, 2, 3, 4]);
    expect(trace.transitions).toHaveLength(3);
    expect(trace.transitions.map((transition) => [transition.source, transition.target])).toEqual([
      [occurrences[0]?.occurrence.id, occurrences[1]?.occurrence.id],
      [occurrences[1]?.occurrence.id, occurrences[2]?.occurrence.id],
      [occurrences[2]?.occurrence.id, occurrences[3]?.occurrence.id],
    ]);
    expect(trace.transitions.some((transition) => (
      transition.sourceLogicalId === transition.targetLogicalId
    ))).toBe(false);
    expect(trace.transitions[2]?.kind).toBe('loop');
  });

  it('applies terminal status only to the latest observed occurrence after a real return', () => {
    const events: ExecutionEvent[] = [
      { type: 'step_start', step: 'A', iteration: 1 },
      { type: 'step_complete', step: 'A', iteration: 1, status: 'done' },
      { type: 'step_start', step: 'B', iteration: 1 },
      { type: 'step_complete', step: 'B', iteration: 1, status: 'done' },
      { type: 'step_start', step: 'A', iteration: 1 },
    ];
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'completed' },
      events.slice().reverse(),
    );
    const a = trace.nodes.find((node) => node.label === 'A');
    const b = trace.nodes.find((node) => node.label === 'B');

    expect(a?.occurrences.map((occurrence) => occurrence.status)).toEqual(['completed', 'completed']);
    expect(b?.occurrences[0]?.status).toBe('completed');
    expect(trace.transitions.map((transition) => [transition.source, transition.target])).toEqual([
      [a?.occurrences[0]?.id, b?.occurrences[0]?.id],
      [b?.occurrences[0]?.id, a?.occurrences[1]?.id],
    ]);
    expect(trace.transitions[1]?.kind).toBe('loop');
  });

  it('keeps workflow calls distinct and links an observed child after call start', () => {
    const chronologicalEvents: ExecutionEvent[] = [
      { type: 'step_start', workflow: 'default', step: 'review', persona: 'Coordinator', iteration: 1 },
      {
        type: 'workflow_call_start',
        workflow: 'default',
        step: 'review',
        childWorkflow: 'review-fix',
        callInstance: '2',
      },
      { type: 'step_start', workflow: 'review-fix', step: 'fix', persona: 'Coder', iteration: 1 },
      { type: 'step_complete', workflow: 'review-fix', step: 'fix', persona: 'Coder', iteration: 1, status: 'done' },
      {
        type: 'workflow_call_complete',
        workflow: 'default',
        step: 'review',
        childWorkflow: 'review-fix',
        callInstance: '2',
        status: 'completed',
      },
    ];
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'completed' },
      chronologicalEvents.slice().reverse(),
    );

    const call = trace.nodes.find((node) => node.kind === 'workflow');
    expect(call).toMatchObject({
      workflow: 'default',
      label: 'review-fix',
      occurrences: [expect.objectContaining({ callInstance: '2', status: 'completed' })],
    });
    expect(trace.calls).toEqual([
      expect.objectContaining({
        workflow: 'default',
        childWorkflow: 'review-fix',
        callInstance: '2',
        startObserved: true,
        targetObserved: true,
      }),
    ]);
    expect(trace.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflow: 'default', depth: 0 }),
      expect.objectContaining({ workflow: 'review-fix', depth: 1 }),
    ]));
  });

  it('does not link a child occurrence that predates the call start', () => {
    const chronologicalEvents: ExecutionEvent[] = [
      { type: 'step_start', workflow: 'default', step: 'delegate', iteration: 1 },
      {
        type: 'step_start',
        workflow: 'child',
        step: 'work',
        iteration: 1,
        stack: [{
          workflow: 'default',
          workflow_ref: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          occurrence: 1,
        }, {
          workflow: 'child',
          workflow_ref: 'child',
          step: 'work',
          kind: 'agent',
          occurrence: 1,
        }],
      },
      {
        type: 'workflow_call_start',
        workflow: 'default',
        step: 'delegate',
        childWorkflow: 'child',
        callInstance: '1',
        stack: [{
          workflow: 'default',
          workflow_ref: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          occurrence: 1,
        }],
      },
    ];
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running' },
      chronologicalEvents.slice().reverse(),
    );

    expect(trace.calls).toEqual([
      expect.objectContaining({
        startObserved: true,
        targetObserved: false,
      }),
    ]);
  });

  it('adds the current metadata as a running pass only when events do not show it', () => {
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running', currentStep: 'implement', currentIteration: 3 },
      [],
    );

    expect(trace.nodes).toHaveLength(1);
    expect(trace.nodes[0]).toMatchObject({
      label: 'implement',
      occurrences: [expect.objectContaining({
        iteration: 3,
        status: 'running',
        eventIndexes: [0],
      })],
    });
  });

  it('uses the basename as the primary report title', () => {
    expect(reportDisplayName('review/security-review.md')).toBe('security-review.md');
    expect(reportDirectory('review/security-review.md')).toBe('review');
    expect(reportDirectory('summary.md')).toBe('');
  });

  it('keeps builtin workflow identity separate from its human-readable label', () => {
    const ref = `builtin:sha256:${'a'.repeat(64)}`;

    expect(isBuiltinWorkflowRef(ref)).toBe(true);
    expect(shortBuiltinDigest(ref)).toBe('aaaaaaaa');
    expect(workflowDisplayName(ref, 'ja')).toBe('組み込み workflow · aaaaaaaa');
    expect(workflowDisplayName(ref, 'en')).toBe('Builtin workflow · aaaaaaaa');

    const trace = buildExecutionTrace(
      { workflow: ref, status: 'running' },
      [{
        type: 'step_start',
        workflow: ref,
        step: 'plan',
        stack: [{
          workflow: 'default',
          workflow_ref: ref,
          step: 'plan',
          kind: 'agent',
          occurrence: 1,
        }],
      }],
      undefined,
      undefined,
      'en',
    );

    expect(trace.nodes[0]).toMatchObject({
      workflow: ref,
      displayWorkflow: 'default',
    });
    expect(trace.nodes[0]?.displayWorkflow).not.toContain(ref);
  });

  it.each([
    ['done', 'completed'],
    ['blocked', 'failed'],
    ['error', 'failed'],
    ['rate_limited', 'failed'],
  ])('maps terminal status %s to %s', (status, expected) => {
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running' },
      [{ type: 'step_complete', step: status, status }],
    );

    expect(trace.nodes[0]?.occurrences[0]?.status).toBe(expected);
  });

  it('keeps a step running after a non-terminal phase reports done', () => {
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running' },
      [{ type: 'phase_complete', step: 'review', phaseName: 'execute', status: 'done' }],
    );

    expect(trace.nodes[0]?.occurrences[0]?.status).toBe('running');
  });

  it('keeps IDs injective for localized and punctuation-heavy names', () => {
    expect(encodeIdPart('a/b')).not.toBe(encodeIdPart('a?b'));
    expect(encodeIdPart('レビュー')).not.toBe(encodeIdPart('review'));
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running' },
      [
        { type: 'step_start', step: 'a?b' },
        { type: 'step_start', step: 'a/b' },
        { type: 'step_start', step: 'レビュー' },
      ],
    );

    expect(new Set(trace.nodes.map((node) => node.id)).size).toBe(3);
  });

  it('keeps child calls with the same iteration distinct by their validated stack path', () => {
    const callStack = (occurrence: number): ExecutionStackFrame[] => [
      {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'delegate',
        kind: 'workflow_call',
        occurrence,
      },
    ];
    const childStack = (occurrence: number): ExecutionStackFrame[] => [
      ...callStack(occurrence),
      {
        workflow: 'child',
        workflow_ref: 'child',
        step: 'work',
        kind: 'agent',
        occurrence: 1,
      },
    ];
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running' },
      [
        {
          type: 'step_complete',
          workflow: 'child',
          step: 'work',
          iteration: 1,
          status: 'done',
          stack: childStack(2),
        },
        {
          type: 'step_start',
          workflow: 'child',
          step: 'work',
          iteration: 1,
          stack: childStack(2),
        },
        {
          type: 'step_complete',
          workflow: 'child',
          step: 'work',
          iteration: 1,
          status: 'done',
          stack: childStack(1),
        },
        {
          type: 'step_start',
          workflow: 'child',
          step: 'work',
          iteration: 1,
          stack: childStack(1),
        },
      ],
    );
    const child = trace.nodes.find((node) => node.workflow === 'child');

    expect(child?.occurrences).toHaveLength(2);
    expect(new Set(child?.occurrences.map((occurrence) => occurrence.id)).size).toBe(2);
    expect(child?.occurrences.map((occurrence) => occurrence.iteration)).toEqual([1, 1]);
  });

  it('builds the graph from lifecycle history while keeping the log tail bounded', () => {
    const history: ExecutionEvent[] = [
      { type: 'step_complete', step: 'old-step', iteration: 1, status: 'done' },
      { type: 'step_start', step: 'old-step', iteration: 1 },
      { type: 'step_complete', step: 'new-step', iteration: 1, status: 'done' },
      { type: 'step_start', step: 'new-step', iteration: 1 },
    ];
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running' },
      [history[3]!],
      [history[3]!, history[2]!, history[1]!, history[0]!],
    );

    expect(trace.events).toEqual([history[3]]);
    expect(trace.nodes.map((node) => node.label)).toEqual(['old-step', 'new-step']);
    expect(trace.nodes[0]?.occurrences[0]?.eventIndexes).toEqual([]);
    expect(trace.nodes[1]?.occurrences[0]?.eventIndexes).toEqual([0]);
  });

  it('identifies a selected step outside the live tail as a history preview', () => {
    const oldComplete: ExecutionEvent = {
      type: 'step_complete',
      step: 'old-step',
      iteration: 1,
      status: 'done',
      content: 'historical output',
    };
    const liveStart: ExecutionEvent = {
      type: 'step_start',
      step: 'new-step',
      iteration: 1,
    };
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running' },
      [liveStart],
      [liveStart, oldComplete],
    );
    const oldOccurrence = trace.nodes.find((node) => node.label === 'old-step')?.occurrences[0];

    expect(oldOccurrence).toBeDefined();
    expect(resolveLogSelection(trace, oldOccurrence!.id)).toMatchObject({
      events: [],
      occurrence: expect.objectContaining({ preview: 'historical output' }),
      historyPreview: true,
    });
  });

  it('renders observed loop and workflow-call connectors in the map contract', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const chronologicalEvents: ExecutionEvent[] = [
        { type: 'step_start', workflow: 'default', step: 'delegate', iteration: 1 },
        {
          type: 'workflow_call_start',
          workflow: 'default',
          step: 'delegate',
          childWorkflow: 'child',
          callInstance: '1',
        },
        { type: 'step_start', workflow: 'child', step: 'work', iteration: 1 },
        { type: 'step_complete', workflow: 'child', step: 'work', iteration: 1, status: 'done' },
        {
          type: 'workflow_call_complete',
          workflow: 'default',
          step: 'delegate',
          childWorkflow: 'child',
          callInstance: '1',
          status: 'completed',
        },
        { type: 'step_start', step: 'review', iteration: 1 },
        { type: 'step_complete', step: 'review', iteration: 1, status: 'done' },
        { type: 'step_start', step: 'plan', iteration: 7 },
        { type: 'step_complete', step: 'plan', iteration: 7, status: 'done' },
        { type: 'step_start', step: 'review', iteration: 2 },
        { type: 'step_complete', step: 'review', iteration: 2, status: 'done' },
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronologicalEvents.slice().reverse(),
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });

      expect(section.querySelectorAll('.workflow-lane')).toHaveLength(0);
      expect(section.querySelectorAll('.execution-call-boundary')).toHaveLength(0);
      expect(section.querySelectorAll('.execution-map-relations')).toHaveLength(0);
      expect(section.querySelectorAll('.execution-step')).toHaveLength(4);
      expect(section.querySelectorAll('.execution-step-index')).toHaveLength(0);
      const chipLabels = section.querySelectorAll('.iteration-chip-label') as FakeDomNode[];
      expect(chipLabels.every(
        (chip) => /^ITER \d+/.test(chip.textContent),
      )).toBe(true);
      expect(section.querySelectorAll('.execution-edge-transition')).toHaveLength(2);
      expect(section.querySelectorAll('.execution-edge-loop')).toHaveLength(1);
      expect(section.querySelectorAll('.execution-edge-call')).toHaveLength(1);
      expect(section.querySelectorAll('[data-edge]')).toHaveLength(4);
      const edgePaths = section.querySelectorAll('[data-edge]') as FakeDomNode[];
      expect(edgePaths.every((path) => path.attributes['data-source-port'] === 'NEXT'
        && path.attributes['data-target-port'] === 'PREV')).toBe(true);
      const loopPath = section.querySelectorAll('.execution-edge-loop')[0] as FakeDomNode | undefined;
      const callPath = section.querySelectorAll('.execution-edge-call')[0] as FakeDomNode | undefined;
      expect(loopPath?.attributes['data-source-occurrence-id']).toBeDefined();
      expect(loopPath?.attributes['data-target-occurrence-id']).toBeDefined();
      expect(loopPath?.attributes.d).toContain('M ');
      expect(callPath?.attributes['data-target-workflow']).toBe('child');
      const map = section.querySelectorAll('.execution-map')[0] as FakeDomNode | undefined;
      const chips = section.querySelectorAll('.iteration-chip') as FakeDomNode[];
      const targetChip = chips.find(
        (chip) => chip.dataset.occurrenceId === trace.loops[0]?.to,
      );
      const beforeScroll = loopPath?.attributes.d;
      if (targetChip !== undefined && map !== undefined) {
        targetChip.rect = { left: 240, top: 40, right: 320, width: 80, height: 24 };
        map.dispatchEvent('scroll');
      }
      const updatedLoopPath = section.querySelectorAll('.execution-edge-loop')[0] as FakeDomNode | undefined;
      expect(updatedLoopPath?.attributes.d).not.toBe(beforeScroll);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('highlights only the chronological ITER incoming and outgoing edges', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const chronologicalEvents: ExecutionEvent[] = [
        { type: 'step_start', step: 'plan', iteration: 1 },
        { type: 'step_complete', step: 'plan', iteration: 1, status: 'done' },
        { type: 'step_start', step: 'review', iteration: 1 },
        { type: 'step_complete', step: 'review', iteration: 1, status: 'done' },
        { type: 'step_start', step: 'plan', iteration: 2 },
        { type: 'step_complete', step: 'plan', iteration: 2, status: 'done' },
        { type: 'step_start', step: 'ship', iteration: 1 },
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronologicalEvents.slice().reverse(),
      );
      const plan = trace.nodes.find((node) => node.label === 'plan');
      expect(plan).toBeDefined();
      if (plan === undefined) throw new Error('expected plan node');
      const selectedOccurrence = plan.occurrences[1];
      expect(selectedOccurrence).toBeDefined();
      if (selectedOccurrence === undefined) throw new Error('expected second plan ITER');

      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const map = section.querySelectorAll('.execution-map')[0] as FakeDomNode;
      const paths = () => section.querySelectorAll('[data-edge]') as FakeDomNode[];
      const overlay = section.querySelectorAll('.execution-edge-overlay')[0] as FakeDomNode;
      const defs = overlay.children[0];
      expect(defs?.children.map((marker) => marker.attributes.id)).toEqual([
        'execution-edge-from',
        'execution-edge-to',
        'execution-edge-from-incoming',
        'execution-edge-to-incoming',
        'execution-edge-from-outgoing',
        'execution-edge-to-outgoing',
      ]);
      expect(defs?.children.every((marker) => marker.attributes.markerUnits === 'userSpaceOnUse')).toBe(true);
      expect(defs?.children.every((marker) => marker.children[0]?.tagName === 'circle')).toBe(true);
      expect(defs?.children[0]?.children[0]?.attributes.fill).toBe('none');
      expect(defs?.children[1]?.children[0]?.attributes.fill).toBe('currentColor');
      expect(defs?.children[2]?.children[0]?.attributes.fill).toBe('none');
      expect(defs?.children[3]?.children[0]?.attributes.fill).toBe('var(--accent)');
      expect(defs?.children[4]?.children[0]?.attributes.fill).toBe('none');
      expect(defs?.children[5]?.children[0]?.attributes.fill).toBe('var(--warning)');
      expect(section.querySelectorAll('.execution-map-selection-legend')).toHaveLength(0);
      expect(paths().every((path) => path.attributes['data-edge-role'] === 'none')).toBe(true);
      expect(paths().every((path) => !/FROM|TO/.test(path.attributes['aria-label'] ?? ''))).toBe(true);
      expect(new Set(paths().map((path) => path.attributes['data-edge-key'])))
        .toEqual(new Set(trace.transitions.map((transition) => `${transition.kind}:${transition.id}`)));

      updateExecutionMapSelection(map, selectedOccurrence.id, plan.id);
      const incoming = paths().filter((path) => path.attributes['data-edge-role'] === 'incoming');
      const outgoing = paths().filter((path) => path.attributes['data-edge-role'] === 'outgoing');
      const unrelated = paths().filter((path) => path.attributes['data-edge-role'] === 'none');
      expect(incoming).toHaveLength(1);
      expect(outgoing).toHaveLength(1);
      expect(unrelated).toHaveLength(1);
      expect(incoming[0]?.attributes['data-target-occurrence-id']).toBe(selectedOccurrence.id);
      expect(outgoing[0]?.attributes['data-source-occurrence-id']).toBe(selectedOccurrence.id);
      expect(incoming[0]?.className).toContain('execution-edge-emphasis-incoming');
      expect(outgoing[0]?.className).toContain('execution-edge-emphasis-outgoing');
      expect(incoming[0]?.attributes['marker-start']).toBe('url(#execution-edge-from-incoming)');
      expect(incoming[0]?.attributes['marker-end']).toBe('url(#execution-edge-to-incoming)');
      expect(outgoing[0]?.attributes['marker-start']).toBe('url(#execution-edge-from-outgoing)');
      expect(outgoing[0]?.attributes['marker-end']).toBe('url(#execution-edge-to-outgoing)');
      expect(incoming[0]?.attributes['aria-label']).toContain('PREV: 前のITERからこのITERへ');
      expect(outgoing[0]?.attributes['aria-label']).toContain('NEXT: このITERから次のITERへ');
      expect(incoming[0]?.attributes['aria-label']).not.toMatch(/FROM|TO/);
      expect(outgoing[0]?.attributes['aria-label']).not.toMatch(/FROM|TO/);
      const legend = section.querySelectorAll('.execution-map-selection-legend')[0] as FakeDomNode;
      expect(legend.children.map((item) => item.children[1]?.textContent)).toEqual([
        'PREV: 前のITERからこのITERへ',
        'NEXT: このITERから次のITERへ',
      ]);
      expect(legend.attributes['aria-label']).toBe('選択中ITERの前後関係');

      const canvas = section.querySelectorAll('.execution-map-canvas')[0] as FakeDomNode;
      canvas.dispatchEvent('execution-map-node-moved');
      expect(paths().filter((path) => path.attributes['data-edge-role'] === 'incoming')).toHaveLength(1);
      expect(paths().filter((path) => path.attributes['data-edge-role'] === 'outgoing')).toHaveLength(1);

      updateExecutionMapSelection(map, plan.occurrences[0]!.id, plan.id);
      expect(paths().filter((path) => path.attributes['data-edge-role'] === 'incoming')).toHaveLength(0);
      expect(paths().filter((path) => path.attributes['data-edge-role'] === 'outgoing')).toHaveLength(1);
      expect(section.querySelectorAll('.execution-map-legend-incoming')).toHaveLength(0);
      expect(section.querySelectorAll('.execution-map-legend-outgoing')).toHaveLength(1);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps STEP header selection separate from individual ITER selection', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const chronologicalEvents: ExecutionEvent[] = [
        { type: 'step_start', step: 'plan', iteration: 1, persona: 'Planner' },
        { type: 'step_complete', step: 'plan', iteration: 1, status: 'done', content: 'first' },
        { type: 'step_start', step: 'review', iteration: 1, persona: 'Reviewer' },
        { type: 'step_complete', step: 'review', iteration: 1, status: 'done', content: 'review' },
        { type: 'step_start', step: 'plan', iteration: 2, persona: 'Planner' },
        { type: 'step_complete', step: 'plan', iteration: 2, status: 'done', content: 'second' },
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronologicalEvents.slice().reverse(),
      );
      const plan = trace.nodes.find((node) => node.label === 'plan');
      expect(plan).toBeDefined();
      if (plan === undefined) throw new Error('expected plan node');
      const selectedSteps: string[] = [];
      const selectedOccurrences: string[] = [];
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedStepId: null,
        selectedOccurrenceId: null,
        onSelectStep: (node) => selectedSteps.push(node.id),
        onSelectOccurrence: (_node, occurrence) => selectedOccurrences.push(occurrence.id),
      });
      const map = section.querySelectorAll('.execution-map')[0] as FakeDomNode;
      const step = (section.querySelectorAll('.execution-step') as FakeDomNode[])
        .find((candidate) => candidate.dataset.stepId === plan.id);
      expect(step).toBeDefined();
      if (step === undefined) throw new Error('expected rendered plan step');
      const header = step.querySelectorAll('.execution-step-header')[0];
      const chips = step.querySelectorAll('.iteration-chip') as FakeDomNode[];
      expect(header).toBeDefined();
      expect(chips).toHaveLength(2);
      expect(chips.map((chip) => chip.attributes['aria-label'])).toEqual([
        expect.stringContaining('ITERATION 1'),
        expect.stringContaining('ITERATION 2'),
      ]);
      expect(chips.map((chip) => chip.children[0]?.textContent)).toEqual(['ITER 1', 'ITER 2']);

      header?.dispatchEvent('click');
      expect(selectedSteps).toEqual([plan.id]);
      expect(selectedOccurrences).toEqual([]);
      updateExecutionMapSelection(map, null, plan.id);
      const incoming = section.querySelectorAll('[data-edge-role="incoming"]') as FakeDomNode[];
      const outgoing = section.querySelectorAll('[data-edge-role="outgoing"]') as FakeDomNode[];
      const incomingLegend = section.querySelectorAll('.execution-map-legend-incoming') as FakeDomNode[];
      const outgoingLegend = section.querySelectorAll('.execution-map-legend-outgoing') as FakeDomNode[];
      expect(incoming).toHaveLength(1);
      expect(outgoing).toHaveLength(1);
      expect(incoming[0]?.attributes['aria-label']).toContain('PREV: 前のSTEPからこのSTEPへ');
      expect(outgoing[0]?.attributes['aria-label']).toContain('NEXT: このSTEPから次のSTEPへ');
      expect(incomingLegend[0]?.children[1]?.textContent)
        .toBe('PREV: 前のSTEPからこのSTEPへ');
      expect(outgoingLegend[0]?.children[1]?.textContent)
        .toBe('NEXT: このSTEPから次のSTEPへ');

      chips[0]?.dispatchEvent('click');
      expect(selectedSteps).toEqual([plan.id]);
      expect(selectedOccurrences).toEqual([plan.occurrences[0]!.id]);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps the selected STEP and ITER detail distinct across the inspector back actions', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const events: ExecutionEvent[] = [
        { type: 'step_start', step: 'plan', iteration: 1 },
        { type: 'step_complete', step: 'plan', iteration: 1, status: 'done' },
        { type: 'step_start', step: 'plan', iteration: 2 },
      ];
      const runDetail = new FakeDomNode('section');
      const inspector = new FakeDomNode('aside');
      const executionView = createExecutionView({
        runList: new FakeDomNode('div'),
        runListEmpty: new FakeDomNode('p'),
        taskCount: new FakeDomNode('span'),
        runDetail,
        inspector,
        onSelectRun: () => undefined,
        onStatusChange: () => undefined,
      });
      const selection = { projectId: 'project-a', slug: 'run-1' };
      executionView.renderDetail({
        project: { id: 'project-a', displayName: 'Project A' },
        meta: {
          runSlug: 'run-1',
          workflow: 'default',
          status: 'running',
          task: 'Inspect this run',
        },
        events: events.slice().reverse(),
        history: [],
        reports: [],
      }, selection);

      const plan = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        events.slice().reverse(),
      ).nodes.find((node) => node.label === 'plan');
      expect(plan).toBeDefined();
      if (plan === undefined) throw new Error('expected plan node');
      const header = runDetail.querySelector('.execution-step-header');
      expect(header).toBeDefined();
      header?.dispatchEvent('click');
      expect(inspector.querySelector('.inspector-step-summary')).not.toBeNull();
      expect(inspector.querySelector('.inspector-iteration-facts')).toBeNull();
      expect(inspector.querySelector('.detail-tabs')).toBeNull();
      expect(inspector.querySelectorAll('.inspector-iteration-item')).toHaveLength(2);
      expect(inspector.querySelector('.log-panel')).toBeNull();
      expect(inspector.querySelector('.logs-empty')).toBeNull();
      let renderedPlan = runDetail.querySelector('.execution-step');
      expect(renderedPlan?.dataset.selected).toBe('true');
      expect(renderedPlan?.dataset.active).toBe('false');

      inspector.querySelectorAll('.inspector-iteration-item')[0]?.dispatchEvent('click');
      expect(inspector.querySelector('.inspector-iteration-summary')).not.toBeNull();
      expect(inspector.querySelector('.detail-tabs')).not.toBeNull();
      expect(inspector.querySelectorAll('.tab-button').map((button) => button.textContent)).toEqual([
        'ITER LOG',
        'REPORTS',
        'PROMPTS',
      ]);
      inspector.querySelector('.inspector-clear-selection')?.dispatchEvent('click');
      expect(inspector.querySelector('.inspector-step-summary')).not.toBeNull();

      const firstLiveUpdate = [
        ...events,
        { type: 'step_complete', step: 'plan', iteration: 2, status: 'done' },
        { type: 'step_start', step: 'review', iteration: 1 },
        { type: 'step_start', step: 'plan', iteration: 3 },
      ] satisfies ExecutionEvent[];
      executionView.renderDetail({
        project: { id: 'project-a', displayName: 'Project A' },
        meta: {
          runSlug: 'run-1',
          workflow: 'default',
          status: 'running',
          task: 'Inspect this run',
        },
        events: firstLiveUpdate.slice().reverse(),
        history: [],
        reports: [],
      }, selection);
      expect(inspector.querySelector('.inspector-step-summary')).not.toBeNull();
      expect(inspector.querySelector('.inspector-iteration-facts')).toBeNull();

      renderedPlan = runDetail.querySelector('.execution-step');
      let chips = renderedPlan?.querySelectorAll('.iteration-chip') ?? [];
      expect(chips).toHaveLength(3);
      chips[0]?.dispatchEvent('click');
      const iterationBack = inspector.querySelector('.inspector-clear-selection');
      expect(iterationBack?.textContent).toBe('STEP概要に戻る');
      expect(inspector.querySelector('.inspector-step-summary')).toBeNull();
      expect(inspector.querySelector('.inspector-iteration-summary')).not.toBeNull();
      expect(inspector.querySelector('.inspector-iteration-facts')).not.toBeNull();

      const secondLiveUpdate = [
        ...firstLiveUpdate,
        { type: 'step_complete', step: 'plan', iteration: 3, status: 'done' },
        { type: 'step_start', step: 'plan', iteration: 4 },
      ] satisfies ExecutionEvent[];
      executionView.renderDetail({
        project: { id: 'project-a', displayName: 'Project A' },
        meta: {
          runSlug: 'run-1',
          workflow: 'default',
          status: 'running',
          task: 'Inspect this run',
        },
        events: secondLiveUpdate.slice().reverse(),
        history: [],
        reports: [],
      }, selection);
      expect(inspector.querySelector('.inspector-step-summary')).toBeNull();
      expect(inspector.querySelector('.inspector-iteration-facts')).not.toBeNull();
      renderedPlan = runDetail.querySelector('.execution-step');
      chips = renderedPlan?.querySelectorAll('.iteration-chip') ?? [];
      expect(chips).toHaveLength(4);
      expect(chips[0]?.dataset.selected).toBe('true');
      expect(runDetail.querySelector('.execution-step')?.dataset.selected).toBe('false');
      expect(runDetail.querySelector('.execution-step')?.dataset.active).toBe('true');

      inspector.querySelector('.inspector-clear-selection')?.dispatchEvent('click');
      expect(inspector.querySelector('.inspector-step-summary')).not.toBeNull();
      expect(runDetail.querySelector('.execution-step')?.dataset.selected).toBe('true');
      expect(chips[0]?.dataset.selected).toBe('false');
      expect(inspector.querySelector('.inspector-clear-selection')?.textContent)
        .toBe('Run 全体に戻る');

      inspector.querySelector('.inspector-clear-selection')?.dispatchEvent('click');
      expect(runDetail.querySelector('.execution-step')?.dataset.selected).toBe('false');
      expect(inspector.querySelector('.inspector-step-summary')).toBeNull();
      expect(inspector.querySelector('.inspector-run-summary')).not.toBeNull();
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('selects a parallel group ITER without fetching artifacts until a child is selected', async () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parallelFrame: ExecutionStackFrame = {
        workflow: 'review',
        workflow_ref: 'review-ref',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      };
      const event = (type: 'step_start' | 'step_complete', step: string): ExecutionEvent => ({
        type,
        workflow: 'review',
        step,
        iteration: 4,
        ...(type === 'step_complete' ? { status: 'done', matchedRuleIndex: 0 } : {}),
        stack: [parallelFrame, {
          workflow: 'review',
          workflow_ref: 'review-ref',
          step,
          kind: 'agent',
          occurrence: 1,
        }],
      });
      const detail = {
        project: { id: 'project-a', displayName: 'Project A' },
        meta: { workflow: 'review', runSlug: 'run-1', status: 'running', task: 'task' },
        events: [
          event('step_start', 'coding-review'),
          event('step_complete', 'coding-review'),
          event('step_start', 'architecture-review'),
          event('step_complete', 'architecture-review'),
        ].reverse(),
        reports: [],
      };
      const runDetail = new FakeDomNode('section');
      const inspector = new FakeDomNode('aside');
      let artifactRequests = 0;
      const executionView = createExecutionView({
        runList: new FakeDomNode('div'),
        runListEmpty: new FakeDomNode('p'),
        taskCount: new FakeDomNode('span'),
        runDetail,
        inspector,
        getOccurrenceArtifacts: async () => {
          artifactRequests += 1;
          return { reports: [], prompts: [] };
        },
        onSelectRun: () => undefined,
        onStatusChange: () => undefined,
      });
      expect(executionView.renderDetail(detail, { projectId: 'project-a', slug: 'run-1' })).toBe(true);
      const groupButtons = runDetail.querySelectorAll('.execution-parallel-iteration') as FakeDomNode[];
      expect(groupButtons).toHaveLength(1);
      groupButtons[0]?.dispatchEvent('click');
      expect(artifactRequests).toBe(0);
      expect(inspector.querySelectorAll('.inspector-parallel-summary')).toHaveLength(1);
      const children = inspector.querySelectorAll('.inspector-parallel-child') as FakeDomNode[];
      expect(children).toHaveLength(2);
      expect(children[0]?.children[1]?.textContent).toBe('RESULT 1');

      children[0]?.dispatchEvent('click');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(artifactRequests).toBe(1);
      executionView.dispose();
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps parallel child details in the selected group without exposing global ITERATION', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parallelFrame: ExecutionStackFrame = {
        workflow: 'review',
        workflow_ref: 'review-ref',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      };
      const childFrame = (step: string): ExecutionStackFrame => ({
        workflow: 'review',
        workflow_ref: 'review-ref',
        step,
        kind: 'agent',
        occurrence: 1,
      });
      const event = (
        type: 'step_start' | 'step_complete',
        step: string,
        iteration: number,
      ): ExecutionEvent => ({
        type,
        workflow: 'review',
        step,
        iteration,
        ...(type === 'step_complete' ? { status: 'done', matchedRuleIndex: 0 } : {}),
        stack: [parallelFrame, childFrame(step)],
      });
      const chronological: ExecutionEvent[] = [
        event('step_start', 'coding-review', 4),
        event('step_complete', 'coding-review', 4),
        event('step_start', 'architecture-review', 4),
        event('step_complete', 'architecture-review', 4),
        event('step_start', 'coding-review', 9),
        event('step_complete', 'coding-review', 9),
        event('step_start', 'architecture-review', 9),
        event('step_complete', 'architecture-review', 9),
        event('step_start', 'coding-review', 14),
        event('step_complete', 'coding-review', 14),
        event('step_start', 'architecture-review', 14),
        event('step_complete', 'architecture-review', 14),
      ];
      const runDetail = new FakeDomNode('section');
      const inspector = new FakeDomNode('aside');
      const executionView = createExecutionView({
        runList: new FakeDomNode('div'),
        runListEmpty: new FakeDomNode('p'),
        taskCount: new FakeDomNode('span'),
        runDetail,
        inspector,
        onSelectRun: () => undefined,
        onStatusChange: () => undefined,
      });
      const selection = { projectId: 'project-a', slug: 'run-1' };
      const detail = {
        project: { id: 'project-a', displayName: 'Project A' },
        meta: { runSlug: 'run-1', workflow: 'review', status: 'completed', task: 'task' },
        events: chronological.slice().reverse(),
        history: [],
        reports: [],
      };
      expect(executionView.renderDetail(detail, selection)).toBe(true);

      const groupButtons = runDetail.querySelectorAll('.execution-parallel-iteration') as FakeDomNode[];
      expect(groupButtons).toHaveLength(3);
      expect(groupButtons[1]?.textContent).toBe('ITER 2');
      expect(groupButtons[2]?.textContent).toBe('ITER 3');
      groupButtons[1]?.dispatchEvent('click');
      expect(inspector.querySelector('.inspector-selection-title')?.textContent).toContain('ITER 2');
      expect(inspector.querySelector('.inspector-parallel-facts')?.textContent).not.toContain('ITERATION');

      const map = runDetail.querySelector('.execution-map') as FakeDomNode;
      const canvas = runDetail.querySelector('.execution-map-canvas') as FakeDomNode;
      map.scrollLeft = 31;
      map.scrollTop = 17;
      canvas.dataset.scale = '1.25';
      const beforePositions = (runDetail.querySelectorAll('.execution-step') as FakeDomNode[])
        .map((step) => [step.dataset.stepId, step.style.left, step.style.top]);
      const selectedGroupKey = groupButtons[1]?.dataset.parallelGroupKey;
      const child = inspector.querySelectorAll('.inspector-parallel-child')[0] as FakeDomNode;
      const childOccurrenceId = child?.dataset.occurrenceId;
      child?.dispatchEvent('click');

      expect(inspector.querySelector('.inspector-iteration-summary')).not.toBeNull();
      expect(inspector.querySelector('.inspector-selection-title')?.textContent).toContain('ITER 2');
      expect(inspector.querySelector('.inspector-iteration-facts')?.textContent).not.toContain('ITERATION');
      expect(inspector.textContent).not.toContain('ITERATION 9');
      expect(inspector.textContent).not.toContain('ITERATION 14');
      expect(inspector.querySelectorAll('.tab-button').map((button) => button.textContent)).toEqual([
        'ITER LOG',
        'REPORTS',
        'PROMPTS',
      ]);
      expect(runDetail.querySelectorAll('.execution-parallel-iteration')
        .find((button) => button.attributes['aria-selected'] === 'true')?.dataset.parallelGroupKey)
        .toBe(selectedGroupKey);
      expect((runDetail.querySelectorAll('.execution-step') as FakeDomNode[])
        .map((step) => [step.dataset.stepId, step.style.left, step.style.top]))
        .toEqual(beforePositions);
      expect(map.scrollLeft).toBe(31);
      expect(map.scrollTop).toBe(17);
      expect(canvas.dataset.scale).toBe('1.25');
      const highlighted = [
        ...runDetail.querySelectorAll('[data-edge-role="incoming"]'),
        ...runDetail.querySelectorAll('[data-edge-role="outgoing"]'),
      ] as FakeDomNode[];
      expect(highlighted.some((edge) => edge.attributes['data-source-occurrence-id'] === childOccurrenceId
        || edge.attributes['data-target-occurrence-id'] === childOccurrenceId)).toBe(true);
      executionView.dispose();
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('selects the latest parallel group by default and keeps one batch visible after live rerender', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parallelParent = (outerOccurrence: number): ExecutionStackFrame[] => [
        {
          workflow: 'root',
          workflow_ref: 'root-ref',
          step: 'peer-review',
          kind: 'workflow_call',
          occurrence: 1,
        },
        {
          workflow: 'peer-review',
          workflow_ref: 'peer-review-ref',
          step: 'reviewers',
          kind: 'workflow_call',
          occurrence: outerOccurrence,
        },
        {
          workflow: 'review',
          workflow_ref: 'review-ref',
          step: 'review',
          kind: 'parallel',
          occurrence: 1,
        },
      ];
      const event = (
        type: 'step_start' | 'step_complete',
        step: string,
        iteration: number,
        outerOccurrence: number,
      ): ExecutionEvent => ({
        type,
        workflow: 'review',
        step,
        iteration,
        ...(type === 'step_complete' ? { status: 'done', matchedRuleIndex: 0 } : {}),
        stack: step === 'review'
          ? parallelParent(outerOccurrence)
          : [...parallelParent(outerOccurrence), {
              workflow: 'review',
              workflow_ref: 'review-ref',
              step,
              kind: 'agent',
              occurrence: 1,
            }],
      });
      const chronological: ExecutionEvent[] = [];
      for (const [iteration, outerOccurrence] of [[4, 1], [9, 1], [14, 2]] as const) {
        chronological.push(
          event('step_start', 'review', iteration, outerOccurrence),
          event('step_start', 'coding-review', iteration, outerOccurrence),
          event('step_complete', 'coding-review', iteration, outerOccurrence),
          event('step_start', 'architecture-review', iteration, outerOccurrence),
          event('step_complete', 'architecture-review', iteration, outerOccurrence),
          event('step_complete', 'review', iteration, outerOccurrence),
        );
      }
      const detail = {
        project: { id: 'project-a', displayName: 'Project A' },
        meta: { workflow: 'review', runSlug: 'run-1', status: 'completed', task: 'task' },
        events: chronological.slice().reverse(),
        reports: [],
      };
      const runDetail = new FakeDomNode('section');
      const inspector = new FakeDomNode('aside');
      const executionView = createExecutionView({
        runList: new FakeDomNode('div'),
        runListEmpty: new FakeDomNode('p'),
        taskCount: new FakeDomNode('span'),
        runDetail,
        inspector,
        onSelectRun: () => undefined,
        onStatusChange: () => undefined,
      });
      const selection = { projectId: 'project-a', slug: 'run-1' };
      expect(executionView.renderDetail(detail, selection)).toBe(true);

      const groupButtons = runDetail.querySelectorAll('.execution-parallel-iteration') as FakeDomNode[];
      expect(groupButtons).toHaveLength(3);
      expect(groupButtons.filter((button) => button.attributes['aria-selected'] === 'true')).toHaveLength(1);
      expect(groupButtons[2]?.textContent).toBe('ITER 3');
      expect(groupButtons[2]?.attributes['aria-selected']).toBe('true');

      const parallelChips = () => (runDetail.querySelectorAll('.iteration-chip') as FakeDomNode[])
        .filter((chip) => chip.dataset.parallelGroupKey !== '');
      const visibleChips = () => parallelChips().filter((chip) => (
        (chip as unknown as { readonly hidden?: boolean }).hidden !== true
      ));
      expect(visibleChips()).toHaveLength(3);
      const reviewStep = (runDetail.querySelectorAll('.execution-step') as FakeDomNode[])
        .find((step) => step.querySelector('.execution-step-title')?.textContent === 'review');
      expect(reviewStep).toBeDefined();
      expect(reviewStep?.querySelectorAll('.iteration-chip')).toHaveLength(3);
      expect(reviewStep?.querySelectorAll('.iteration-chip').filter((chip) => (
        (chip as unknown as { readonly hidden?: boolean }).hidden !== true
      ))).toHaveLength(1);

      groupButtons[1]?.dispatchEvent('pointerdown', {
        target: groupButtons[1],
        stopPropagation: () => undefined,
      });
      groupButtons[1]?.dispatchEvent('pointerup', { target: groupButtons[1] });
      groupButtons[1]?.dispatchEvent('click', {
        target: groupButtons[1],
        stopPropagation: () => undefined,
      });
      expect(groupButtons.filter((button) => button.attributes['aria-selected'] === 'true')).toHaveLength(1);
      expect(groupButtons[1]?.attributes['aria-selected']).toBe('true');
      expect(visibleChips()).toHaveLength(3);
      expect(visibleChips().every((chip) => chip.dataset.parallelGroupKey === groupButtons[1]?.dataset.parallelGroupKey)).toBe(true);
      expect(reviewStep?.querySelectorAll('.iteration-chip').filter((chip) => (
        (chip as unknown as { readonly hidden?: boolean }).hidden !== true
      ))).toHaveLength(1);

      executionView.renderDetail({ ...detail, events: [...detail.events] }, selection);
      const rerenderedButtons = runDetail.querySelectorAll('.execution-parallel-iteration') as FakeDomNode[];
      expect(rerenderedButtons.filter((button) => button.attributes['aria-selected'] === 'true')).toHaveLength(1);
      expect(rerenderedButtons[1]?.attributes['aria-selected']).toBe('true');
      expect(
        (runDetail.querySelectorAll('.iteration-chip') as FakeDomNode[])
          .filter((chip) => chip.dataset.parallelGroupKey !== ''
            && (chip as unknown as { readonly hidden?: boolean }).hidden !== true)
          .every((chip) => chip.dataset.parallelGroupKey === rerenderedButtons[1]?.dataset.parallelGroupKey),
      )
        .toBe(true);
      executionView.dispose();
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('renders the selected ITER result, transition, output, and recorded judge path', async () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const events: ExecutionEvent[] = [
        {
          type: 'step_start',
          step: 'review',
          iteration: 1,
          provider: 'codex',
          providerSource: 'step',
          model: 'gpt-test',
          modelSource: 'step',
        },
        {
          type: 'step_complete',
          step: 'review',
          iteration: 1,
          status: 'done',
          matchedRuleIndex: 1,
          matchedRuleMethod: 'structured_output',
          matchMethod: 'structured_output',
          content: 'approved output',
        },
      ];
      const runDetail = new FakeDomNode('section');
      const inspector = new FakeDomNode('aside');
      const executionView = createExecutionView({
        runList: new FakeDomNode('div'),
        runListEmpty: new FakeDomNode('p'),
        taskCount: new FakeDomNode('span'),
        runDetail,
        inspector,
        onSelectRun: () => undefined,
        onStatusChange: () => undefined,
        getOccurrenceArtifacts: async () => ({
          reports: [],
          prompts: [],
          outcome: {
            matchedRuleIndex: 1,
            condition: 'REVISE',
            nextStep: 'review',
            matchedRuleMethod: 'structured_output',
            matchMethod: 'structured_output',
            provider: 'codex',
            providerSource: 'step',
            model: 'gpt-test',
            modelSource: 'step',
            outputPreview: 'approved output',
            judgeStages: [
              { stage: 1, method: 'structured_output', status: 'done', response: '{"step":2}' },
              { stage: 2, method: 'text_fallback', status: 'done', response: 'REVISE' },
            ],
          },
        }),
      });
      const selection = { projectId: 'project-a', slug: 'run-1' };
      executionView.renderDetail({
        project: { id: 'project-a', displayName: 'Project A' },
        meta: {
          runSlug: 'run-1',
          workflow: 'default',
          status: 'running',
          task: 'Inspect this run',
        },
        events: events.slice().reverse(),
        history: [],
        reports: [],
      }, selection);
      runDetail.querySelector('.execution-step-header')?.dispatchEvent('click');
      inspector.querySelector('.inspector-iteration-item')?.dispatchEvent('click');
      await new Promise((resolve) => setTimeout(resolve, 0));

      const facts = inspector.querySelector('.inspector-iteration-facts');
      const factValues = facts?.children.map((fact) => [
        fact.children[0]?.textContent,
        fact.children[1]?.textContent,
      ]);
      expect(factValues).toEqual(expect.arrayContaining([
        ['結果', 'RESULT 2'],
        ['一致した条件', 'REVISE'],
        ['遷移先', 'review'],
        ['STEP実行先', 'codex / gpt-test'],
      ]));
      expect(inspector.querySelector('.inspector-iteration-output-content')?.textContent)
        .toBe('approved output');
      const stages = inspector.querySelectorAll('.inspector-judge-stage') as FakeDomNode[];
      expect(stages).toHaveLength(2);
      expect(stages[0]?.children[0]?.textContent).toBe('STAGE 1');
      expect(stages[0]?.children[1]?.textContent).toBe('structured_output · done');
      expect(stages[0]?.children[2]?.textContent).toBe('{"step":2}');
      expect(stages[1]?.children[0]?.textContent).toBe('STAGE 2');
      expect(stages[1]?.children[1]?.textContent).toBe('text_fallback · done');
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('does not apply a stale occurrence artifact response after selecting another ITER', async () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const events: ExecutionEvent[] = [
        { type: 'step_start', step: 'review', iteration: 1 },
        { type: 'step_complete', step: 'review', iteration: 1, status: 'done' },
        { type: 'step_start', step: 'review', iteration: 2 },
        { type: 'step_complete', step: 'review', iteration: 2, status: 'done' },
      ];
      const runDetail = new FakeDomNode('section');
      const inspector = new FakeDomNode('aside');
      const pending: Array<{ id: string; signal?: AbortSignal; resolve: (value: unknown) => void }> = [];
      const executionView = createExecutionView({
        runList: new FakeDomNode('div'),
        runListEmpty: new FakeDomNode('p'),
        taskCount: new FakeDomNode('span'),
        runDetail,
        inspector,
        onSelectRun: () => undefined,
        onStatusChange: () => undefined,
        getOccurrenceArtifacts: (
          _projectId: string,
          _slug: string,
          id: string,
          signal?: AbortSignal,
        ) => new Promise((resolve) => {
          pending.push({ id, signal, resolve });
        }),
      });
      const selection = { projectId: 'project-a', slug: 'run-1' };
      executionView.renderDetail({
        project: { id: 'project-a', displayName: 'Project A' },
        meta: { runSlug: 'run-1', workflow: 'default', status: 'running', task: 'Inspect this run' },
        events: events.slice().reverse(),
        history: [],
        reports: [],
      }, selection);
      const plan = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        events.slice().reverse(),
      ).nodes.find((node) => node.label === 'review');
      expect(plan).toBeDefined();
      if (plan === undefined) throw new Error('expected review node');

      runDetail.querySelector('.execution-step-header')?.dispatchEvent('click');
      const items = inspector.querySelectorAll('.inspector-iteration-item');
      items[0]?.dispatchEvent('click');
      items[1]?.dispatchEvent('click');
      inspector.querySelectorAll('.tab-button')
        .find((button) => button.textContent === 'REPORTS')
        ?.dispatchEvent('click');
      await Promise.resolve();
      expect(pending.map(({ id }) => id)).toEqual([
        plan.occurrences[0]!.id,
        plan.occurrences[1]!.id,
      ]);
      expect(pending[0]?.signal?.aborted).toBe(true);
      expect(pending[1]?.signal?.aborted).toBe(false);

      pending[1]!.resolve({
        reports: [{ filename: 'second.md', content: 'second', omitted: false }],
        prompts: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inspector.querySelectorAll('.report-list-item')[0]?.children[0]?.textContent).toBe('second.md');

      pending[0]!.resolve({
        reports: [{ filename: 'first.md', content: 'first', omitted: false }],
        prompts: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inspector.querySelectorAll('.report-list-item')[0]?.children[0]?.textContent).toBe('second.md');
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps selected ITER artifacts, in-flight fetch, and scroll on same-run snapshot refresh', async () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const events: ExecutionEvent[] = [
        { type: 'step_start', step: 'review', iteration: 1 },
        { type: 'step_complete', step: 'review', iteration: 1, status: 'done' },
      ];
      const runDetail = new FakeDomNode('section');
      const inspector = new FakeDomNode('aside');
      const pending: Array<{ resolve: (value: unknown) => void }> = [];
      let artifactFetchStarted = 0;
      let artifactFetchReleased = 0;
      const executionView = createExecutionView({
        runList: new FakeDomNode('div'),
        runListEmpty: new FakeDomNode('p'),
        taskCount: new FakeDomNode('span'),
        runDetail,
        inspector,
        onSelectRun: () => undefined,
        onStatusChange: () => undefined,
        getOccurrenceArtifacts: () => new Promise((resolve) => {
          pending.push({ resolve });
        }),
        onOccurrenceArtifactsStart: () => {
          artifactFetchStarted += 1;
          return () => {
            artifactFetchReleased += 1;
          };
        },
      });
      const selection = { projectId: 'project-a', slug: 'run-1' };
      const detail = {
        project: { id: 'project-a', displayName: 'Project A' },
        meta: { runSlug: 'run-1', workflow: 'default', status: 'running', task: 'Inspect this run' },
        events: events.slice().reverse(),
        history: [],
        reports: [],
      };
      executionView.renderDetail(detail, selection);
      runDetail.querySelector('.execution-step-header')?.dispatchEvent('click');
      inspector.querySelector('.inspector-iteration-item')?.dispatchEvent('click');
      await Promise.resolve();
      expect(pending).toHaveLength(1);
      expect(artifactFetchStarted).toBe(1);
      expect(artifactFetchReleased).toBe(0);
      runDetail.scrollTop = 41;
      inspector.scrollTop = 23;

      executionView.renderDetail({
        ...detail,
        meta: { ...detail.meta, updatedAt: '2026-08-27T00:00:00.000Z' },
      }, selection);

      expect(pending).toHaveLength(1);
      expect(runDetail.scrollTop).toBe(41);
      expect(inspector.scrollTop).toBe(23);
      pending[0]!.resolve({
        reports: [{ filename: 'selected.md', content: 'selected', omitted: false }],
        prompts: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(artifactFetchReleased).toBe(1);
      inspector.querySelector('.tab-button')?.dispatchEvent('click');
      inspector.querySelectorAll('.tab-button')
        .find((button) => button.textContent === 'REPORTS')
        ?.dispatchEvent('click');
      expect(inspector.querySelector('.report-list-item')?.children[0]?.textContent).toBe('selected.md');
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('aborts and hides stale ITER artifacts when preparing another run selection', async () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const events: ExecutionEvent[] = [
        { type: 'step_start', step: 'review', iteration: 1 },
        { type: 'step_complete', step: 'review', iteration: 1, status: 'done' },
      ];
      const runDetail = new FakeDomNode('section');
      const inspector = new FakeDomNode('aside');
      const pending: Array<{
        id: string;
        signal?: AbortSignal;
        resolve: (value: unknown) => void;
      }> = [];
      let artifactFetchReleased = 0;
      const executionView = createExecutionView({
        runList: new FakeDomNode('div'),
        runListEmpty: new FakeDomNode('p'),
        taskCount: new FakeDomNode('span'),
        runDetail,
        inspector,
        onSelectRun: () => undefined,
        onStatusChange: () => undefined,
        getOccurrenceArtifacts: (
          _projectId: string,
          _slug: string,
          id: string,
          signal?: AbortSignal,
        ) => new Promise((resolve) => {
          pending.push({ id, signal, resolve });
        }),
        onOccurrenceArtifactsStart: () => () => {
          artifactFetchReleased += 1;
        },
      });
      const runA = { projectId: 'project-a', slug: 'run-a' };
      const detailA = {
        project: { id: 'project-a', displayName: 'Project A' },
        meta: { runSlug: 'run-a', workflow: 'default', status: 'running', task: 'Run A' },
        events: events.slice().reverse(),
        history: [],
        reports: [],
      };
      executionView.renderDetail(detailA, runA);
      runDetail.querySelector('.execution-step-header')?.dispatchEvent('click');
      inspector.querySelector('.inspector-iteration-item')?.dispatchEvent('click');
      inspector.querySelectorAll('.tab-button')
        .find((button) => button.textContent === 'REPORTS')
        ?.dispatchEvent('click');
      await Promise.resolve();
      expect(pending).toHaveLength(1);
      const oldArtifactRequest = pending[0]!;
      expect(inspector.querySelector('.workspace-empty')).not.toBeNull();

      const runB = { projectId: 'project-b', slug: 'run-b' };
      executionView.prepareRunSelection(runB);
      expect(oldArtifactRequest.signal?.aborted).toBe(true);
      expect(artifactFetchReleased).toBe(1);
      expect(inspector.querySelector('.detail-tabs')).toBeNull();
      expect(inspector.querySelector('.report-list-item')).toBeNull();

      oldArtifactRequest.resolve({
        reports: [{ filename: 'old.md', content: 'old report', omitted: false }],
        prompts: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inspector.querySelector('.report-list-item')).toBeNull();

      const detailB = {
        project: { id: 'project-b', displayName: 'Project B' },
        meta: { runSlug: 'run-b', workflow: 'default', status: 'running', task: 'Run B' },
        events: events.slice().reverse(),
        history: [],
        reports: [],
      };
      expect(executionView.renderDetail(detailB, runB)).toBe(true);
      expect(runDetail.querySelector('.run-detail-title')).not.toBeNull();
      expect(inspector.querySelector('.detail-tabs')).not.toBeNull();
      expect(inspector.querySelector('.report-list-item')).toBeNull();
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('restores logical Inspector focus across snapshots and delayed artifact responses', async () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    const document = new FakeDomDocument();
    runtime.document = document;
    try {
      const events: ExecutionEvent[] = [
        { type: 'step_start', step: 'review', iteration: 1 },
        { type: 'step_complete', step: 'review', iteration: 1, status: 'done' },
      ];
      const runDetail = new FakeDomNode('section');
      const inspector = new FakeDomNode('aside');
      const pending: Array<{ resolve: (value: unknown) => void }> = [];
      const executionView = createExecutionView({
        runList: new FakeDomNode('div'),
        runListEmpty: new FakeDomNode('p'),
        taskCount: new FakeDomNode('span'),
        runDetail,
        inspector,
        onSelectRun: () => undefined,
        onStatusChange: () => undefined,
        getOccurrenceArtifacts: () => new Promise((resolve) => {
          pending.push({ resolve });
        }),
      });
      const selection = { projectId: 'project-a', slug: 'run-1' };
      const detail = {
        project: { id: 'project-a', displayName: 'Project A' },
        meta: { runSlug: 'run-1', workflow: 'default', status: 'running', task: 'Inspect this run' },
        events: events.slice().reverse(),
        history: [],
        reports: [],
      };
      executionView.renderDetail(detail, selection);
      runDetail.querySelector('.execution-step-header')?.dispatchEvent('click');
      inspector.querySelector('.inspector-iteration-item')?.dispatchEvent('click');
      await Promise.resolve();
      expect(pending).toHaveLength(1);

      const reportsTab = inspector.querySelectorAll('.tab-button')
        .find((button) => button.textContent === 'REPORTS');
      reportsTab?.dispatchEvent('click');
      const focusedReportTab = inspector.querySelectorAll('.tab-button')
        .find((button) => button.textContent === 'REPORTS');
      focusedReportTab?.focus();
      executionView.renderDetail({
        ...detail,
        meta: { ...detail.meta, updatedAt: '2026-08-27T00:00:00.000Z' },
      }, selection);
      expect(document.activeElement).not.toBe(focusedReportTab);
      expect(document.activeElement?.textContent).toBe('REPORTS');
      expect(document.activeElement?.getAttribute('role')).toBe('tab');

      pending[0]!.resolve({
        reports: [{ filename: 'selected.md', content: 'selected', omitted: false }],
        prompts: [{ phase: 1, systemPrompt: 'prompt' }],
        promptsTruncated: true,
        omittedPromptCount: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      inspector.querySelectorAll('.tab-button')
        .find((button) => button.textContent === 'REPORTS')
        ?.dispatchEvent('click');
      const reportButton = inspector.querySelector('.report-list-item');
      reportButton?.focus();
      executionView.renderDetail({
        ...detail,
        meta: { ...detail.meta, updatedAt: '2026-08-27T00:00:01.000Z' },
      }, selection);
      expect(document.activeElement?.dataset.reportFilename).toBe('selected.md');

      inspector.querySelectorAll('.tab-button')
        .find((button) => button.textContent === 'PROMPTS')
        ?.dispatchEvent('click');
      expect(inspector.querySelector('.artifact-limit-notice')?.textContent)
        .toBe('上限により 2 件の PROMPT を省略しました。');
      const promptCard = inspector.querySelector('.prompt-card');
      promptCard?.focus();
      executionView.renderDetail({
        ...detail,
        meta: { ...detail.meta, updatedAt: '2026-08-27T00:00:02.000Z' },
      }, selection);
      expect(document.activeElement?.dataset.promptIndex).toBe('0');

      const outside = new FakeDomNode('button');
      outside.textContent = 'outside';
      outside.focus();
      executionView.renderDetail({
        ...detail,
        meta: { ...detail.meta, updatedAt: '2026-08-27T00:00:03.000Z' },
      }, selection);
      expect(document.activeElement).toBe(outside);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('uses deterministic free-form positions for step-only nodes', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const events: ExecutionEvent[] = [
        { type: 'step_start', workflow: 'default', step: 'plan', iteration: 1 },
        { type: 'step_start', workflow: 'child', step: 'work', iteration: 1 },
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        events.slice().reverse(),
      );
      const render = () => renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const first = render();
      const second = render();
      const firstSteps = first.querySelectorAll('.execution-step') as FakeDomNode[];
      const secondSteps = second.querySelectorAll('.execution-step') as FakeDomNode[];

      expect(first.querySelectorAll('.workflow-lane')).toHaveLength(0);
      expect(first.querySelectorAll('.execution-call-boundary')).toHaveLength(0);
      expect(firstSteps).toHaveLength(2);
      expect(firstSteps.map((step) => step.dataset.layoutY)).not.toEqual([
        firstSteps[0]?.dataset.layoutY,
        firstSteps[0]?.dataset.layoutY,
      ]);
      expect(firstSteps.map((step) => [step.dataset.layoutX, step.dataset.layoutY]))
        .toEqual(secondSteps.map((step) => [step.dataset.layoutX, step.dataset.layoutY]));
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('groups sibling parallel steps without adding workflow lanes', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parent: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'review',
        kind: 'parallel',
        occurrence: 1,
      };
      const event = (step: string): ExecutionEvent => ({
        type: 'step_start',
        workflow: 'default',
        step,
        iteration: 1,
        stack: [parent, {
          workflow: 'default',
          workflow_ref: 'default',
          step,
          kind: 'agent',
          occurrence: 1,
        }],
      });
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [event('architecture-review'), event('coding-review')],
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const groups = section.querySelectorAll('.execution-parallel-group') as FakeDomNode[];

      expect(groups).toHaveLength(1);
      expect(groups[0]?.textContent).toBe('');
      expect(groups[0]?.children[0]?.textContent).toBe('PARALLEL · review');
      const memberTop = Math.min(...(section.querySelectorAll('.execution-step') as FakeDomNode[])
        .map((step) => Number.parseFloat(step.style.top)));
      const groupTop = Number.parseFloat(groups[0]?.style.top ?? 'NaN');
      expect(memberTop - groupTop).toBe(58);
      expect(Number.parseFloat(groups[0]?.style.height ?? 'NaN')).toBeGreaterThan(200);
      expect(section.querySelectorAll('.workflow-lane')).toHaveLength(0);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('renders a parallel invocation as one fork and join boundary', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parallelFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      };
      const childFrame = (step: string): ExecutionStackFrame => ({
        workflow: 'default',
        workflow_ref: 'default',
        step,
        kind: 'agent',
        occurrence: 1,
      });
      const event = (
        type: 'step_start' | 'step_complete',
        step: string,
        stack?: readonly ExecutionStackFrame[],
      ): ExecutionEvent => ({
        type,
        workflow: 'default',
        step,
        iteration: 1,
        ...(type === 'step_complete' ? { status: 'done' } : {}),
        ...(stack === undefined ? {} : { stack }),
      });
      const chronological: ExecutionEvent[] = [
        event('step_start', 'before'),
        event('step_complete', 'before'),
        event('step_start', 'reviewers', [parallelFrame]),
        event('step_start', 'coding-review', [parallelFrame, childFrame('coding-review')]),
        event('step_complete', 'coding-review', [parallelFrame, childFrame('coding-review')]),
        event('step_start', 'architecture-review', [parallelFrame, childFrame('architecture-review')]),
        event('step_complete', 'architecture-review', [parallelFrame, childFrame('architecture-review')]),
        event('step_complete', 'reviewers', [parallelFrame]),
        event('step_start', 'after'),
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronological.slice().reverse(),
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const parallelEdges = section.querySelectorAll('.execution-edge-parallel') as FakeDomNode[];
      expect(parallelEdges).toHaveLength(4);
      expect(parallelEdges.every((edge) => (
        edge.attributes['data-source-boundary'] === 'true'
          || edge.attributes['data-target-boundary'] === 'true'
      ))).toBe(true);
      expect(parallelEdges.every((edge) => (
        edge.attributes['data-source-occurrence-id'] === undefined
          || edge.attributes['data-target-occurrence-id'] === undefined
      ))).toBe(true);
      const forkEdges = parallelEdges.filter((edge) => edge.attributes['data-source-boundary'] === 'true');
      const joinEdges = parallelEdges.filter((edge) => edge.attributes['data-target-boundary'] === 'true');
      expect(forkEdges).toHaveLength(2);
      expect(forkEdges.every((edge) => (
        edge.attributes['data-source-port'] === 'PREV'
          && edge.attributes['data-target-port'] === 'PREV'
      ))).toBe(true);
      expect(joinEdges).toHaveLength(2);
      expect(joinEdges.every((edge) => (
        edge.attributes['data-source-port'] === 'NEXT'
          && edge.attributes['data-target-port'] === 'NEXT'
      ))).toBe(true);
      const externalEdges = section.querySelectorAll('.execution-edge-transition') as FakeDomNode[];
      expect(externalEdges.map((edge) => [
        edge.attributes['data-source-port'],
        edge.attributes['data-target-port'],
      ])).toEqual([
        ['NEXT', 'PREV'],
        ['NEXT', 'PREV'],
      ]);
      const groupButton = section.querySelectorAll('.execution-parallel-iteration')[0] as FakeDomNode;
      const groupPrevWrapper = groupButton.querySelector('.execution-port-prev') as FakeDomNode;
      const groupNextWrapper = groupButton.querySelector('.execution-port-next') as FakeDomNode;
      const groupPrev = groupPrevWrapper.querySelector('.execution-port-anchor') as FakeDomNode;
      const groupNext = groupNextWrapper.querySelector('.execution-port-anchor') as FakeDomNode;
      const beforeChip = (section.querySelectorAll('.iteration-chip') as FakeDomNode[])
        .find((chip) => chip.dataset.occurrenceId === trace.nodes
          .find((node) => node.label === 'before')?.occurrences[0]?.id) as FakeDomNode;
      const afterChip = (section.querySelectorAll('.iteration-chip') as FakeDomNode[])
        .find((chip) => chip.dataset.occurrenceId === trace.nodes
          .find((node) => node.label === 'after')?.occurrences[0]?.id) as FakeDomNode;
      const participants = trace.parallelGroups[0]?.participantOccurrenceIds ?? [];
      const participantChip = (section.querySelectorAll('.iteration-chip') as FakeDomNode[])
        .find((chip) => chip.dataset.occurrenceId === participants[0]) as FakeDomNode;
      const rect = (left: number, top: number, width = 28, height = 14) => ({
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
      });
      groupPrevWrapper.rect = rect(184, 190, 34, 30);
      groupNextWrapper.rect = rect(282, 250, 34, 30);
      groupPrev.rect = rect(190, 202, 5, 5);
      groupNext.rect = rect(300, 262, 5, 5);
      const setPortRect = (
        chip: FakeDomNode,
        side: 'prev' | 'next',
        wrapperRect: ReturnType<typeof rect>,
        anchorRect: ReturnType<typeof rect>,
      ) => {
        const wrapper = chip.querySelector(`.execution-port-${side}`) as FakeDomNode;
        wrapper.rect = wrapperRect;
        (wrapper.querySelector('.execution-port-anchor') as FakeDomNode).rect = anchorRect;
      };
      setPortRect(beforeChip, 'next', rect(72, 180, 46, 40), rect(101, 197, 5, 5));
      setPortRect(afterChip, 'prev', rect(320, 264, 46, 40), rect(323, 281, 5, 5));
      setPortRect(participantChip, 'prev', rect(116, 214, 46, 40), rect(119, 231, 5, 5));
      setPortRect(participantChip, 'next', rect(278, 238, 46, 40), rect(306, 255, 5, 5));
      const map = section.querySelectorAll('.execution-map')[0] as FakeDomNode;
      map.dispatchEvent('scroll');
      const pathEndpoints = (path: FakeDomNode) => {
        const values = path.attributes.d?.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
        return {
          source: { x: values[0], y: values[1] },
          target: { x: values[6], y: values[7] },
        };
      };
      const center = (node: FakeDomNode) => ({
        x: (node.rect.left + node.rect.right) / 2,
        y: (node.rect.top + (node.rect.bottom ?? node.rect.top + node.rect.height)) / 2,
      });
      const updatedExternalEdges = section.querySelectorAll('.execution-edge-transition') as FakeDomNode[];
      const updatedParallelEdges = section.querySelectorAll('.execution-edge-parallel') as FakeDomNode[];
      const incomingExternal = updatedExternalEdges.find((edge) => edge.attributes['data-target-boundary'] === 'true');
      const outgoingExternal = updatedExternalEdges.find((edge) => edge.attributes['data-source-boundary'] === 'true');
      const fork = updatedParallelEdges.find((edge) => edge.attributes['data-source-boundary'] === 'true');
      const join = updatedParallelEdges.find((edge) => edge.attributes['data-target-boundary'] === 'true');
      expect(pathEndpoints(incomingExternal!).target).toEqual(pathEndpoints(fork!).source);
      expect(pathEndpoints(join!).target).toEqual(pathEndpoints(outgoingExternal!).source);
      const beforePortWrapper = beforeChip.querySelector('.execution-port-next') as FakeDomNode;
      const beforePortAnchor = beforePortWrapper.querySelector('.execution-port-anchor') as FakeDomNode;
      const participantPortPrevWrapper = participantChip.querySelector('.execution-port-prev') as FakeDomNode;
      const participantPortPrevAnchor = participantPortPrevWrapper.querySelector('.execution-port-anchor') as FakeDomNode;
      const participantPortNextWrapper = participantChip.querySelector('.execution-port-next') as FakeDomNode;
      const participantPortNextAnchor = participantPortNextWrapper.querySelector('.execution-port-anchor') as FakeDomNode;
      expect(pathEndpoints(incomingExternal!).source).toEqual(center(beforePortAnchor));
      expect(pathEndpoints(incomingExternal!).source).not.toEqual(center(beforePortWrapper));
      expect(pathEndpoints(fork!).source).toEqual(center(groupPrev));
      expect(pathEndpoints(fork!).source).not.toEqual(center(groupPrevWrapper));
      expect(pathEndpoints(fork!).target).toEqual(center(participantPortPrevAnchor));
      expect(pathEndpoints(fork!).target).not.toEqual(center(participantPortPrevWrapper));
      expect(pathEndpoints(join!).source).toEqual(center(participantPortNextAnchor));
      expect(pathEndpoints(join!).source).not.toEqual(center(participantPortNextWrapper));
      expect(pathEndpoints(join!).target).toEqual(center(groupNext));
      expect(pathEndpoints(join!).target).not.toEqual(center(groupNextWrapper));
      const afterPortWrapper = afterChip.querySelector('.execution-port-prev') as FakeDomNode;
      const afterPortAnchor = afterPortWrapper.querySelector('.execution-port-anchor') as FakeDomNode;
      expect(pathEndpoints(outgoingExternal!).target).toEqual(center(afterPortAnchor));
      expect(pathEndpoints(outgoingExternal!).target).not.toEqual(center(afterPortWrapper));
      expect(section.querySelectorAll('.execution-edge-transition')).toHaveLength(2);
      expect(section.querySelectorAll('.execution-port')).toHaveLength(12);
      expect(section.querySelectorAll('.execution-parallel-iteration')).toHaveLength(1);
      const parallelHeader = section.querySelectorAll('.execution-parallel-group-header')[0] as FakeDomNode;
      expect(parallelHeader.attributes['aria-description']).toContain('Pool判定なし');
      expect((section.querySelectorAll('.iteration-chip-evidence') as FakeDomNode[])
        .map((evidence) => evidence.textContent))
        .toEqual(['観測された境界', '観測参加者', '観測参加者']);
      const group = trace.parallelGroups[0];
      expect(group?.parentOccurrenceIds).toHaveLength(1);
      expect(group?.participantOccurrenceIds).toHaveLength(2);
      expect(group?.participantOccurrenceIds).not.toContain(group?.parentOccurrenceIds?.[0]);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps a parallel workflow_call as the direct participant and normalizes its CALL edge', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parallelFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      };
      const callFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'delegate',
        kind: 'workflow_call',
        occurrence: 1,
      };
      const childFrame: ExecutionStackFrame = {
        workflow: 'child',
        workflow_ref: 'child',
        step: 'work',
        kind: 'agent',
        occurrence: 1,
      };
      const event = (
        type: 'step_start' | 'step_complete',
        workflow: string,
        step: string,
        stack: readonly ExecutionStackFrame[],
      ): ExecutionEvent => ({
        type,
        workflow,
        step,
        iteration: 1,
        stack,
        ...(type === 'step_complete' ? { status: 'done' } : {}),
      });
      const chronological: ExecutionEvent[] = [
        event('step_start', 'default', 'reviewers', [parallelFrame]),
        event('step_start', 'default', 'review', [parallelFrame, {
          ...parallelFrame,
          step: 'review',
          kind: 'agent',
        }]),
        event('step_complete', 'default', 'review', [parallelFrame, {
          ...parallelFrame,
          step: 'review',
          kind: 'agent',
        }]),
        {
          type: 'workflow_call_start',
          workflow: 'default',
          step: 'delegate',
          childWorkflow: 'child',
          callInstance: '1',
          stack: [parallelFrame, callFrame],
        },
        event('step_start', 'child', 'work', [parallelFrame, callFrame, childFrame]),
        event('step_complete', 'child', 'work', [parallelFrame, callFrame, childFrame]),
        {
          type: 'workflow_call_complete',
          workflow: 'default',
          step: 'delegate',
          childWorkflow: 'child',
          callInstance: '1',
          status: 'completed',
          stack: [parallelFrame, callFrame],
        },
        event('step_complete', 'default', 'reviewers', [parallelFrame]),
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronological.slice().reverse(),
      );

      const group = trace.parallelGroups[0];
      expect(group?.parentOccurrenceIds).toHaveLength(1);
      expect(group?.participantOccurrenceIds).toHaveLength(2);
      const callOccurrence = trace.nodes
        .find((node) => node.kind === 'workflow' && node.label === 'child')
        ?.occurrences[0]?.id;
      const childOccurrence = trace.nodes
        .find((node) => node.workflow === 'child' && node.label === 'work')
        ?.occurrences[0]?.id;
      expect(callOccurrence).toBeDefined();
      expect(group?.participantOccurrenceIds).toContain(callOccurrence);
      expect(group?.participantOccurrenceIds).not.toContain(childOccurrence);
      expect(trace.calls[0]).toMatchObject({ targetObserved: true });

      let selectedCallId: string | undefined;
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: (_node, occurrence) => {
          selectedCallId = occurrence.id;
        },
      });
      expect(section.querySelectorAll('.execution-edge-call')).toHaveLength(0);
      const parallelEdges = section.querySelectorAll('.execution-edge-parallel') as FakeDomNode[];
      expect(parallelEdges).toHaveLength(4);
      expect(parallelEdges.some((edge) => edge.attributes['data-target-occurrence-id'] === callOccurrence
        || edge.attributes['data-source-occurrence-id'] === callOccurrence)).toBe(true);
      expect(parallelEdges.every((edge) => edge.attributes['data-edge-kind'] === 'parallel')).toBe(true);
      const callAnchor = section.querySelectorAll('.execution-parallel-call-participant')[0] as FakeDomNode;
      expect(callAnchor.attributes.role).toBe('button');
      expect(callAnchor.attributes.tabindex).toBe('0');
      expect(callAnchor.dataset.occurrenceId).toBe(callOccurrence);
      callAnchor.dispatchEvent('keydown', {
        key: 'Enter',
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
      expect(selectedCallId).toBe(callOccurrence);
      updateExecutionMapSelection(section, callOccurrence ?? null);
      expect(callAnchor.dataset.selected).toBe('true');
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('renders an explicit anchor when a parallel workflow_call has no observed child', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parallelFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      };
      const callFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'delegate',
        kind: 'workflow_call',
        occurrence: 1,
      };
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [
          {
            type: 'step_start',
            workflow: 'default',
            step: 'reviewers',
            iteration: 1,
            stack: [parallelFrame],
          },
          {
            type: 'workflow_call_start',
            workflow: 'default',
            step: 'delegate',
            childWorkflow: 'missing-child',
            callInstance: '1',
            stack: [parallelFrame, callFrame],
          },
        ].reverse(),
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });

      expect(trace.calls[0]).toMatchObject({ targetObserved: false });
      expect(trace.parallelGroups[0]?.participantOccurrenceIds).toHaveLength(1);
      expect(section.querySelectorAll('.execution-parallel-call-participant')).toHaveLength(1);
      expect(section.querySelectorAll('.execution-edge-call')).toHaveLength(0);
      expect(section.querySelectorAll('.execution-edge-parallel')).toHaveLength(2);
      const callId = trace.parallelGroups[0]?.participantOccurrenceIds?.[0];
      const parallelEdges = section.querySelectorAll('.execution-edge-parallel') as FakeDomNode[];
      expect(parallelEdges.every((edge) => (
        edge.attributes['data-target-participant-occurrence-id'] === callId
          || edge.attributes['data-source-participant-occurrence-id'] === callId
      ))).toBe(true);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('uses canonical parallel roles to separate same-name parent and direct agent', () => {
    const parallelFrame: ExecutionStackFrame = {
      workflow: 'default',
      workflow_ref: 'default',
      step: 'review',
      kind: 'parallel',
      occurrence: 1,
    };
    const parentParallel = {
      role: 'parent' as const,
      participationId: 'parallel-parent-1',
    };
    const directParallel = {
      role: 'direct_participant' as const,
      participationId: 'parallel-direct-1',
      parentParticipationId: 'parallel-parent-1',
    };
    const event = (
      type: 'step_start' | 'step_complete' | 'phase_start' | 'phase_complete',
      parallel: typeof parentParallel | typeof directParallel,
    ): ExecutionEvent => ({
      type,
      workflow: 'default',
      step: 'review',
      iteration: 1,
      stack: [parallelFrame],
      parallel,
      ...(type === 'step_complete' || type === 'phase_complete' ? { status: 'done' } : {}),
      ...(type.startsWith('phase_') ? { phase: 1, phaseName: 'execute' } : {}),
    });
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'completed' },
      [
        event('step_complete', parentParallel),
        event('phase_complete', directParallel),
        event('phase_start', directParallel),
        event('step_start', parentParallel),
      ],
    );

    const nodes = trace.nodes.filter((node) => node.label === 'review');
    expect(nodes).toHaveLength(2);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2);
    expect(nodes.flatMap((node) => node.occurrences).map((occurrence) => occurrence.parallelRole))
      .toEqual(expect.arrayContaining(['parent', 'direct_participant']));
    expect(trace.parallelGroups[0]?.parentOccurrenceIds).toHaveLength(1);
    expect(trace.parallelGroups[0]?.participantOccurrenceIds).toHaveLength(1);
  });

  it('keeps canonical participants with a shared parallel stack distinct', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parallelFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      };
      const parentParallel = {
        role: 'parent' as const,
        participationId: 'parallel-parent-1',
      };
      const participantParallel = (participationId: string) => ({
        role: 'direct_participant' as const,
        participationId,
        parentParticipationId: parentParallel.participationId,
      });
      const event = (
        type: 'step_start' | 'step_complete' | 'phase_start' | 'phase_complete',
        step: string,
        parallel: ReturnType<typeof participantParallel> | typeof parentParallel,
      ): ExecutionEvent => ({
        type,
        workflow: 'default',
        step,
        iteration: 1,
        stack: [parallelFrame],
        parallel,
        ...(type === 'step_complete' || type === 'phase_complete' ? { status: 'done' } : {}),
        ...(type.startsWith('phase_') ? { phase: 1, phaseName: 'execute' } : {}),
      });
      const chronological: ExecutionEvent[] = [
        event('step_start', 'reviewers', parentParallel),
        event('step_start', 'alpha', participantParallel('parallel-alpha')),
        event('phase_start', 'alpha', participantParallel('parallel-alpha')),
        event('phase_complete', 'alpha', participantParallel('parallel-alpha')),
        event('step_complete', 'alpha', participantParallel('parallel-alpha')),
        event('step_start', 'beta', participantParallel('parallel-beta')),
        event('step_complete', 'beta', participantParallel('parallel-beta')),
        event('step_complete', 'reviewers', parentParallel),
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronological.slice().reverse(),
      );

      const group = trace.parallelGroups[0];
      expect(group?.participantOccurrenceIds).toHaveLength(2);
      expect(trace.nodes.find((node) => node.label === 'alpha')?.occurrences).toHaveLength(1);
      expect(trace.nodes.find((node) => node.label === 'beta')?.occurrences).toHaveLength(1);

      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const parallelEdges = section.querySelectorAll('.execution-edge-parallel') as FakeDomNode[];
      expect(parallelEdges).toHaveLength(4);
      expect(parallelEdges.filter((edge) => edge.attributes['data-source-boundary'] === 'true')).toHaveLength(2);
      expect(parallelEdges.filter((edge) => edge.attributes['data-target-boundary'] === 'true')).toHaveLength(2);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps legacy participants with distinct step labels on a shared parallel stack', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parallelFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      };
      const event = (
        type: 'step_start' | 'step_complete' | 'phase_start' | 'phase_complete',
        step: string,
      ): ExecutionEvent => ({
        type,
        workflow: 'default',
        step,
        iteration: 1,
        stack: [parallelFrame],
        ...(type === 'step_complete' || type === 'phase_complete' ? { status: 'done' } : {}),
        ...(type.startsWith('phase_') ? { phase: 1, phaseName: 'execute' } : {}),
      });
      const chronological: ExecutionEvent[] = [
        event('step_start', 'reviewers'),
        event('step_start', 'alpha'),
        event('phase_start', 'alpha'),
        event('phase_complete', 'alpha'),
        event('step_complete', 'alpha'),
        event('step_start', 'beta'),
        event('step_complete', 'beta'),
        event('step_complete', 'reviewers'),
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronological.slice().reverse(),
      );

      const group = trace.parallelGroups[0];
      expect(group?.participantOccurrenceIds).toHaveLength(2);
      expect(trace.nodes.find((node) => node.label === 'alpha')?.occurrences).toHaveLength(1);
      expect(trace.nodes.find((node) => node.label === 'beta')?.occurrences).toHaveLength(1);

      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const parallelEdges = section.querySelectorAll('.execution-edge-parallel') as FakeDomNode[];
      expect(parallelEdges).toHaveLength(4);
      expect(parallelEdges.filter((edge) => edge.attributes['data-source-boundary'] === 'true')).toHaveLength(2);
      expect(parallelEdges.filter((edge) => edge.attributes['data-target-boundary'] === 'true')).toHaveLength(2);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('assigns canonical nested participants only to their nearest parallel group', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const outerFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'outer-group',
        kind: 'parallel',
        occurrence: 1,
      };
      const innerFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'inner-group',
        kind: 'parallel',
        occurrence: 1,
      };
      const outerParent = { role: 'parent' as const, participationId: 'outer-parent' };
      const outerAlpha = {
        role: 'direct_participant' as const,
        participationId: 'outer-alpha',
        parentParticipationId: outerParent.participationId,
      };
      const innerParent = { role: 'parent' as const, participationId: 'inner-parent' };
      const innerParticipant = (participationId: string) => ({
        role: 'direct_participant' as const,
        participationId,
        parentParticipationId: innerParent.participationId,
      });
      const event = (
        type: 'step_start' | 'step_complete',
        step: string,
        stack: readonly ExecutionStackFrame[],
        parallel: typeof outerParent | typeof outerAlpha | typeof innerParent | ReturnType<typeof innerParticipant>,
      ): ExecutionEvent => ({
        type,
        workflow: 'default',
        step,
        iteration: 1,
        stack,
        parallel,
        ...(type === 'step_complete' ? { status: 'done' } : {}),
      });
      const chronological: ExecutionEvent[] = [
        event('step_start', 'outer-group', [outerFrame], outerParent),
        event('step_start', 'alpha', [outerFrame], outerAlpha),
        event('step_complete', 'alpha', [outerFrame], outerAlpha),
        event('step_start', 'inner-group', [outerFrame, innerFrame], innerParent),
        event('step_start', 'beta', [outerFrame, innerFrame], innerParticipant('inner-beta')),
        event('step_complete', 'beta', [outerFrame, innerFrame], innerParticipant('inner-beta')),
        event('step_start', 'gamma', [outerFrame, innerFrame], innerParticipant('inner-gamma')),
        event('step_complete', 'gamma', [outerFrame, innerFrame], innerParticipant('inner-gamma')),
        event('step_complete', 'inner-group', [outerFrame, innerFrame], innerParent),
        event('step_complete', 'outer-group', [outerFrame], outerParent),
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronological.slice().reverse(),
      );
      const outerGroup = trace.parallelGroups.find((group) => group.label === 'outer-group');
      const innerGroup = trace.parallelGroups.find((group) => group.label === 'inner-group');
      expect(outerGroup?.participantOccurrenceIds).toHaveLength(2);
      expect(innerGroup?.participantOccurrenceIds).toHaveLength(2);
      expect(outerGroup?.parentOccurrenceIds).toHaveLength(1);
      expect(innerGroup?.parentOccurrenceIds).toHaveLength(1);

      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const parallelEdges = section.querySelectorAll('.execution-edge-parallel') as FakeDomNode[];
      expect(parallelEdges).toHaveLength(8);
      const edgeGroupPair = (source: string, target: string) => parallelEdges.filter((edge) => (
        edge.attributes['data-source-parallel-group-key'] === source
          && edge.attributes['data-target-parallel-group-key'] === target
      ));
      expect(edgeGroupPair(outerGroup!.key, outerGroup!.key)).toHaveLength(2);
      expect(edgeGroupPair(outerGroup!.key, innerGroup!.key)).toHaveLength(1);
      expect(edgeGroupPair(innerGroup!.key, outerGroup!.key)).toHaveLength(1);
      expect(edgeGroupPair(innerGroup!.key, innerGroup!.key)).toHaveLength(4);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('assigns legacy nested participants only to their nearest parallel group', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const outerFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'outer-group',
        kind: 'parallel',
        occurrence: 1,
      };
      const innerFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'inner-group',
        kind: 'parallel',
        occurrence: 1,
      };
      const event = (
        type: 'step_start' | 'step_complete',
        step: string,
        stack: readonly ExecutionStackFrame[],
      ): ExecutionEvent => ({
        type,
        workflow: 'default',
        step,
        iteration: 1,
        stack,
        ...(type === 'step_complete' ? { status: 'done' } : {}),
      });
      const chronological: ExecutionEvent[] = [
        event('step_start', 'outer-group', [outerFrame]),
        event('step_start', 'alpha', [outerFrame]),
        event('step_complete', 'alpha', [outerFrame]),
        event('step_start', 'inner-group', [outerFrame, innerFrame]),
        event('step_start', 'beta', [outerFrame, innerFrame]),
        event('step_complete', 'beta', [outerFrame, innerFrame]),
        event('step_start', 'gamma', [outerFrame, innerFrame]),
        event('step_complete', 'gamma', [outerFrame, innerFrame]),
        event('step_complete', 'inner-group', [outerFrame, innerFrame]),
        event('step_complete', 'outer-group', [outerFrame]),
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronological.slice().reverse(),
      );
      const outerGroup = trace.parallelGroups.find((group) => group.label === 'outer-group');
      const innerGroup = trace.parallelGroups.find((group) => group.label === 'inner-group');
      expect(outerGroup?.participantOccurrenceIds).toHaveLength(2);
      expect(innerGroup?.participantOccurrenceIds).toHaveLength(2);
      expect(outerGroup?.parentOccurrenceIds).toHaveLength(1);
      expect(innerGroup?.parentOccurrenceIds).toHaveLength(1);

      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const parallelEdges = section.querySelectorAll('.execution-edge-parallel') as FakeDomNode[];
      expect(parallelEdges).toHaveLength(8);
      const edgeGroupPair = (source: string, target: string) => parallelEdges.filter((edge) => (
        edge.attributes['data-source-parallel-group-key'] === source
          && edge.attributes['data-target-parallel-group-key'] === target
      ));
      expect(edgeGroupPair(outerGroup!.key, outerGroup!.key)).toHaveLength(2);
      expect(edgeGroupPair(outerGroup!.key, innerGroup!.key)).toHaveLength(1);
      expect(edgeGroupPair(innerGroup!.key, outerGroup!.key)).toHaveLength(1);
      expect(edgeGroupPair(innerGroup!.key, innerGroup!.key)).toHaveLength(4);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps a nested serial workflow_call CALL edge inside a parallel invocation', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parallelFrame: ExecutionStackFrame = {
      workflow: 'default',
      workflow_ref: 'default',
      step: 'reviewers',
      kind: 'parallel',
      occurrence: 1,
    };
    const outerCallFrame: ExecutionStackFrame = {
      workflow: 'default',
      workflow_ref: 'default',
      step: 'delegate',
      kind: 'workflow_call',
      occurrence: 1,
    };
    const outerStepFrame: ExecutionStackFrame = {
      workflow: 'child',
      workflow_ref: 'child',
      step: 'prepare',
      kind: 'agent',
      occurrence: 1,
    };
    const innerCallFrame: ExecutionStackFrame = {
      workflow: 'child',
      workflow_ref: 'child',
      step: 'nested',
      kind: 'workflow_call',
      occurrence: 1,
    };
    const innerStepFrame: ExecutionStackFrame = {
      workflow: 'nested',
      workflow_ref: 'nested',
      step: 'work',
      kind: 'agent',
      occurrence: 1,
    };
    const stepEvent = (
      type: 'step_start' | 'step_complete',
      workflow: string,
      step: string,
      stack: readonly ExecutionStackFrame[],
    ): ExecutionEvent => ({
      type,
      workflow,
      step,
      iteration: 1,
      stack,
      ...(type === 'step_complete' ? { status: 'done' } : {}),
    });
    const callEvent = (
      type: 'workflow_call_start' | 'workflow_call_complete',
      workflow: string,
      step: string,
      childWorkflow: string,
      stack: readonly ExecutionStackFrame[],
    ): ExecutionEvent => ({
      type,
      workflow,
      step,
      childWorkflow,
      callInstance: '1',
      stack,
      ...(type === 'workflow_call_complete' ? { status: 'completed' } : {}),
    });
    const chronological: ExecutionEvent[] = [
      stepEvent('step_start', 'default', 'before', []),
      stepEvent('step_complete', 'default', 'before', []),
      stepEvent('step_start', 'default', 'reviewers', [parallelFrame]),
      callEvent('workflow_call_start', 'default', 'delegate', 'child', [parallelFrame, outerCallFrame]),
      stepEvent('step_start', 'child', 'prepare', [parallelFrame, outerCallFrame, outerStepFrame]),
      stepEvent('step_complete', 'child', 'prepare', [parallelFrame, outerCallFrame, outerStepFrame]),
      stepEvent('step_start', 'child', 'nested', [parallelFrame, outerCallFrame, outerStepFrame]),
      callEvent('workflow_call_start', 'child', 'nested', 'nested', [parallelFrame, outerCallFrame, innerCallFrame]),
      stepEvent('step_start', 'nested', 'work', [parallelFrame, outerCallFrame, innerCallFrame, innerStepFrame]),
      stepEvent('step_complete', 'nested', 'work', [parallelFrame, outerCallFrame, innerCallFrame, innerStepFrame]),
      callEvent('workflow_call_complete', 'child', 'nested', 'nested', [parallelFrame, outerCallFrame, innerCallFrame]),
      stepEvent('step_complete', 'child', 'nested', [parallelFrame, outerCallFrame, outerStepFrame]),
      callEvent('workflow_call_complete', 'default', 'delegate', 'child', [parallelFrame, outerCallFrame]),
      stepEvent('step_complete', 'default', 'reviewers', [parallelFrame]),
      stepEvent('step_start', 'default', 'after', []),
    ];
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running' },
      chronological.slice().reverse(),
    );

    expect(trace.calls).toHaveLength(2);
    const section = renderExecutionMap(trace, {
      liveIndicator: new FakeDomNode('span'),
      emptyState: new FakeDomNode('div'),
      selectedOccurrenceId: null,
      onSelectOccurrence: () => undefined,
    });
    expect(section.querySelectorAll('.execution-edge-call')).toHaveLength(1);
    expect(section.querySelectorAll('.execution-edge-parallel')).toHaveLength(2);
      expect((section.querySelectorAll('.execution-edge-call')[0] as FakeDomNode | undefined)?.attributes['data-target-workflow'])
        .toBe('nested');
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps same-named parallel parents, direct participants, and nested groups distinct', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const outer: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'review',
        kind: 'parallel',
        occurrence: 1,
      };
      const direct: ExecutionStackFrame = {
        ...outer,
        kind: 'agent',
      };
      const inner: ExecutionStackFrame = {
        ...outer,
        occurrence: 2,
      };
      const nestedDirect: ExecutionStackFrame = {
        ...inner,
        kind: 'agent',
      };
      const event = (
        type: 'step_start' | 'step_complete',
        stack: readonly ExecutionStackFrame[],
      ): ExecutionEvent => ({
        type,
        workflow: 'default',
        step: 'review',
        iteration: 1,
        stack,
        ...(type === 'step_complete' ? { status: 'done' } : {}),
      });
      const chronological: ExecutionEvent[] = [
        event('step_start', [outer]),
        event('step_start', [outer, direct]),
        event('step_complete', [outer, direct]),
        event('step_start', [outer, inner]),
        event('step_start', [outer, inner, nestedDirect]),
        event('step_complete', [outer, inner, nestedDirect]),
        event('step_complete', [outer, inner]),
        event('step_complete', [outer]),
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronological.slice().reverse(),
      );
      const reviewNodes = trace.nodes.filter((node) => node.label === 'review');
      expect(reviewNodes).toHaveLength(4);
      expect(new Set(reviewNodes.map((node) => node.id)).size).toBe(4);
      expect(trace.parallelGroups).toHaveLength(2);
      const outerGroup = trace.parallelGroups.find((group) => group.parentOccurrenceIds?.some(
        (id) => reviewNodes.find((node) => node.occurrences.some((occurrence) => occurrence.id === id))?.occurrences
          .find((occurrence) => occurrence.id === id)?.stack?.length === 1,
      ));
      const innerGroup = trace.parallelGroups.find((group) => group !== outerGroup);
      expect(outerGroup?.participantOccurrenceIds).toHaveLength(2);
      expect(innerGroup?.participantOccurrenceIds).toHaveLength(1);
      expect(outerGroup?.participantOccurrenceIds).not.toContain(innerGroup?.participantOccurrenceIds?.[0]);

      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const parallelEdges = section.querySelectorAll('.execution-edge-parallel') as FakeDomNode[];
      expect(parallelEdges).toHaveLength(6);
      expect(parallelEdges.filter((edge) => edge.attributes['data-source-occurrence-id'] !== undefined
        || edge.attributes['data-target-occurrence-id'] !== undefined)).toHaveLength(4);
      expect(parallelEdges.some((edge) => edge.attributes['data-source-boundary'] === 'true'
        && edge.attributes['data-target-boundary'] === 'true')).toBe(true);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('groups parallel children by invocation and assigns local group ITER ordinals', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parent = (
        outerStep: string,
        outerOccurrence: number,
        parallelOccurrence: number,
      ): ExecutionStackFrame[] => [
        {
          workflow: 'root',
          workflow_ref: 'root-ref',
          step: 'peer-review',
          kind: 'workflow_call',
          occurrence: 1,
        },
        {
          workflow: 'peer-review',
          workflow_ref: 'peer-review-ref',
          step: outerStep,
          kind: 'workflow_call',
          occurrence: outerOccurrence,
        },
        {
          workflow: 'review',
          workflow_ref: 'review-ref',
          step: 'review',
          kind: 'parallel',
          occurrence: parallelOccurrence,
        },
      ];
      const event = (
        type: 'step_start' | 'step_complete',
        step: string,
        iteration: number | undefined,
        outerStep = 'reviewers',
        outerOccurrence = 1,
        parallelOccurrence = 1,
      ): ExecutionEvent => ({
        type,
        workflow: 'review',
        step,
        iteration,
        ...(type === 'step_complete' ? { status: 'done', matchedRuleIndex: 0 } : {}),
        stack: [...parent(outerStep, outerOccurrence, parallelOccurrence), {
          workflow: 'review',
          workflow_ref: 'review-ref',
          step,
          kind: 'agent',
          occurrence: 1,
        }],
      });
      const chronological: ExecutionEvent[] = [
        event('step_start', 'review', 4, 'initial-reviewers'),
        event('step_start', 'coding-review', 4, 'initial-reviewers'),
        event('step_complete', 'coding-review', 4, 'initial-reviewers'),
        event('step_start', 'architecture-review', 4, 'initial-reviewers'),
        event('step_complete', 'architecture-review', 4, 'initial-reviewers'),
        event('step_start', 'coding-review', 9),
        event('step_complete', 'coding-review', 9),
        event('step_start', 'architecture-review', 9),
        event('step_complete', 'architecture-review', 9),
        event('step_start', 'coding-review', 14, 'reviewers', 2),
        event('step_complete', 'coding-review', 14, 'reviewers', 2),
        event('step_start', 'coding-review', 4, 'reviewers', 1, 2),
        event('step_complete', 'coding-review', 4, 'reviewers', 1, 2),
        event('step_start', 'architecture-review', 4, 'reviewers', 1, 2),
        event('step_complete', 'architecture-review', 4, 'reviewers', 1, 2),
        event('step_start', 'missing-iteration', undefined),
        event('step_complete', 'missing-iteration', undefined),
      ];
      const trace = buildExecutionTrace(
        { workflow: 'review', status: 'running' },
        chronological.slice().reverse(),
      );

      expect(trace.parallelGroups.map((group) => [group.ordinal, group.iteration])).toEqual([
        [1, 4], [2, 9], [3, 14], [4, 4],
      ]);
      const firstFamilyKey = trace.parallelGroups[0]?.familyKey;
      const firstFamily = trace.parallelGroups.filter((group) => group.familyKey === firstFamilyKey);
      expect(firstFamily[0]?.occurrenceIds).toHaveLength(3);
      expect(firstFamily[1]?.occurrenceIds).toHaveLength(2);
      expect(firstFamily[2]?.occurrenceIds).toHaveLength(1);
      expect(firstFamily).toHaveLength(4);
      expect(firstFamily[3]?.occurrenceIds).toHaveLength(2);
      const missing = trace.nodes.find((node) => node.label === 'missing-iteration')?.occurrences[0];
      expect(missing?.parallelGroupKey).toBeUndefined();
      expect(missing?.parallelGroupAmbiguous).toBe(true);

      const selected: string[] = [];
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        selectedParallelGroupKey: null,
        onSelectOccurrence: () => undefined,
        onSelectParallelGroup: (_group, iteration) => selected.push(iteration.key),
      });
      const groupButtons = section.querySelectorAll('.execution-parallel-iteration') as FakeDomNode[];
      expect(groupButtons).toHaveLength(4);
      const firstGroupKey = trace.parallelGroups.find((group) => group.ordinal === 1)?.key;
      expect(firstGroupKey).toBeDefined();
      groupButtons[0]?.dispatchEvent('click');
      expect(selected).toEqual([firstGroupKey]);
      expect(groupButtons[0]?.textContent).toBe('ITER 1');
      const childChips = (section.querySelectorAll('.iteration-chip') as FakeDomNode[])
        .filter((chip) => chip.dataset.parallelGroupKey === firstGroupKey);
      expect(childChips).toHaveLength(3);
      expect(childChips.every((chip) => chip.children[0]?.textContent !== 'ITER 1')).toBe(true);
      expect(childChips.some((chip) => chip.children[0]?.textContent === 'RESULT 1')).toBe(true);
      const map = section.querySelectorAll('.execution-map')[0] as FakeDomNode;
      updateExecutionMapSelection(map, null, null, firstGroupKey ?? null);
      const parallelChips = (section.querySelectorAll('.iteration-chip') as FakeDomNode[])
        .filter((chip) => chip.dataset.parallelGroupKey !== '');
      const isHidden = (chip: FakeDomNode) => (
        (chip as unknown as { readonly hidden?: boolean }).hidden === true
      );
      expect(parallelChips.filter((chip) => !isHidden(chip))).toHaveLength(3);
      expect(parallelChips.filter(isHidden)).toHaveLength(5);
      expect(section.querySelectorAll('[data-edge-role="incoming-outgoing"]')).not.toHaveLength(0);
      expect(section.querySelectorAll('.execution-map-legend-incoming')).not.toHaveLength(0);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('uses verified call-site digests to separate same-occurrence sites and merge aliases', () => {
    const parallelFrame: ExecutionStackFrame = {
      workflow: 'review',
      workflow_ref: 'review-ref',
      step: 'review',
      kind: 'parallel',
      occurrence: 1,
    };
    const callFrame = (step: string): ExecutionStackFrame => ({
      workflow: 'peer-review',
      workflow_ref: 'peer-review-ref',
      step,
      kind: 'workflow_call',
      occurrence: 1,
    });
    const invocationIdentity = (step: string) => JSON.stringify({
      workflow: 'peer-review-ref',
      step,
      calls: [],
    });
    const namespace = (step: string, digest: string) => (
      `iteration-1--step-${step}--workflow-review--site-${digest}`
    );
    const childEvent = (step: string, callStep: string): ExecutionEvent => ({
      type: 'step_start',
      workflow: 'review',
      step,
      iteration: 1,
      stack: [callFrame(callStep), parallelFrame, {
        workflow: 'review',
        workflow_ref: 'review-ref',
        step,
        kind: 'agent',
        occurrence: 1,
      }],
    });
    const siteA = 'a'.repeat(64);
    const siteB = 'b'.repeat(64);
    const separateMeta = {
      workflow: 'review',
      status: 'running',
      resumePoint: {
        workflow_call_invocations: {
          [invocationIdentity('site-a')]: {
            call_instance: 1,
            report_namespace_segment: namespace('site-a', siteA),
          },
          [invocationIdentity('site-b')]: {
            call_instance: 1,
            report_namespace_segment: namespace('site-b', siteB),
          },
        },
      },
    };
    const separateTrace = buildExecutionTrace(
      separateMeta,
      [childEvent('coding-review', 'site-b'), childEvent('coding-review', 'site-a')],
    );
    expect(new Set(separateTrace.parallelGroups.map((group) => group.familyKey)).size).toBe(2);
    expect(separateTrace.parallelGroups.flatMap((group) => group.occurrenceIds)).toHaveLength(2);

    const aliasDigest = 'c'.repeat(64);
    const aliasMeta = {
      workflow: 'review',
      status: 'running',
      resumePoint: {
        workflow_call_invocations: {
          [invocationIdentity('initial-reviewers')]: {
            call_instance: 1,
            report_namespace_segment: namespace('initial-reviewers', aliasDigest),
          },
          [invocationIdentity('reviewers')]: {
            call_instance: 1,
            report_namespace_segment: namespace('reviewers', aliasDigest),
          },
        },
      },
    };
    const aliasTrace = buildExecutionTrace(
      aliasMeta,
      [childEvent('architecture-review', 'reviewers'), childEvent('coding-review', 'initial-reviewers')],
    );
    expect(new Set(aliasTrace.parallelGroups.map((group) => group.familyKey)).size).toBe(1);
  });

  it('reassigns presentation ITER ordinals across families with colliding local ordinals', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parent = (callStep: string): ExecutionStackFrame[] => [
        {
          workflow: 'peer-review',
          workflow_ref: 'peer-review-ref',
          step: callStep,
          kind: 'workflow_call',
          occurrence: 1,
        },
        {
          workflow: 'review',
          workflow_ref: 'review-ref',
          step: 'review',
          kind: 'parallel',
          occurrence: 1,
        },
      ];
      const invocationIdentity = (step: string) => JSON.stringify({
        workflow: 'peer-review-ref',
        step,
        calls: [],
      });
      const namespace = (step: string, digest: string) => (
        `iteration-1--step-${step}--workflow-review--site-${digest}`
      );
      const event = (
        type: 'step_start' | 'step_complete',
        step: string,
        iteration: number,
        callStep: string,
      ): ExecutionEvent => ({
        type,
        workflow: 'review',
        step,
        iteration,
        ...(type === 'step_complete' ? { status: 'done', matchedRuleIndex: 0 } : {}),
        stack: step === 'review'
          ? parent(callStep)
          : [...parent(callStep), {
              workflow: 'review',
              workflow_ref: 'review-ref',
              step,
              kind: 'agent',
              occurrence: 1,
            }],
      });
      const siteA = 'a'.repeat(64);
      const siteB = 'b'.repeat(64);
      const trace = buildExecutionTrace(
        {
          workflow: 'review',
          status: 'running',
          resumePoint: {
            workflow_call_invocations: {
              [invocationIdentity('site-a')]: {
                report_namespace_segment: namespace('site-a', siteA),
              },
              [invocationIdentity('site-b')]: {
                report_namespace_segment: namespace('site-b', siteB),
              },
            },
          },
        },
        [
          event('step_start', 'review', 4, 'site-a'),
          event('step_start', 'coding-review', 4, 'site-a'),
          event('step_complete', 'coding-review', 4, 'site-a'),
          event('step_start', 'review', 9, 'site-b'),
          event('step_start', 'coding-review', 9, 'site-b'),
          event('step_complete', 'coding-review', 9, 'site-b'),
          event('step_start', 'review', 14, 'site-b'),
          event('step_start', 'coding-review', 14, 'site-b'),
          event('step_complete', 'coding-review', 14, 'site-b'),
        ].reverse(),
      );
      const selected: string[] = [];
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        selectedParallelGroupKey: null,
        onSelectOccurrence: () => undefined,
        onSelectParallelGroup: (_group, iteration) => selected.push(iteration.key),
      });
      const groupButtons = section.querySelectorAll('.execution-parallel-iteration') as FakeDomNode[];
      expect(groupButtons).toHaveLength(3);
      expect(groupButtons.map((button) => button.textContent)).toEqual(['ITER 1', 'ITER 2', 'ITER 3']);
      expect(new Set(groupButtons.map((button) => button.dataset.parallelGroupKey)).size).toBe(3);
      const parallelChips = (section.querySelectorAll('.iteration-chip') as FakeDomNode[])
        .filter((chip) => chip.dataset.parallelGroupKey !== '');
      expect(parallelChips.every((chip) => (
        !chip.children.some((child) => child.textContent.startsWith('PARALLEL ITER'))
      ))).toBe(true);
      const thirdGroupKey = groupButtons[2]?.dataset.parallelGroupKey;
      expect(thirdGroupKey).toBeDefined();
      expect(parallelGroupPresentationOrdinal(trace, thirdGroupKey)).toBe(3);
      expect(parallelChips
        .filter((chip) => chip.dataset.parallelGroupKey === thirdGroupKey)
        .every((chip) => chip.attributes['aria-label']?.includes('PARALLEL ITER 3')))
        .toBe(true);

      groupButtons[1]?.dispatchEvent('click');
      expect(selected).toEqual([trace.parallelGroups[1]?.key]);

      const runDetail = new FakeDomNode('section');
      const inspector = new FakeDomNode('aside');
      const executionView = createExecutionView({
        runList: new FakeDomNode('div'),
        runListEmpty: new FakeDomNode('p'),
        taskCount: new FakeDomNode('span'),
        runDetail,
        inspector,
        onSelectRun: () => undefined,
        onStatusChange: () => undefined,
      });
      expect(executionView.renderDetail({
        project: { id: 'project-a', displayName: 'Project A' },
        meta: { workflow: 'review', runSlug: 'run-1', status: 'running', task: 'task' },
        events: [...trace.events].reverse(),
        reports: [],
      }, { projectId: 'project-a', slug: 'run-1' })).toBe(true);
      const inspectorTitle = inspector.querySelector('.inspector-selection-title');
      expect(inspectorTitle?.textContent).toBe('PARALLEL · review · ITER 3');
      executionView.dispose();
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('projects terminal phase outcomes for parallel children and hides false running state', () => {
    const parent: ExecutionStackFrame = {
      workflow: 'review',
      workflow_ref: 'review-ref',
      step: 'review',
      kind: 'parallel',
      occurrence: 1,
    };
    // Canonical parallel child records share the parent parallel frame; they
    // do not necessarily carry an additional agent frame.
    const childStack: ExecutionStackFrame[] = [parent];
    const event = (
      type: string,
      step: string,
      iteration: number,
      status?: string,
      phaseName?: string,
    ): ExecutionEvent => ({
      type,
      workflow: 'review',
      step,
      iteration,
      ...(status === undefined ? {} : { status }),
      ...(phaseName === undefined ? {} : { phaseName }),
      ...(type === 'phase_judge_stage'
        ? { stage: 1, method: 'structured_output', response: 'ok' }
        : {}),
      stack: step === 'review' ? [parent] : childStack,
    });
    const batch = (iteration: number, terminalStatus: string): ExecutionEvent[] => [
      event('step_start', 'review', iteration),
      event('step_start', 'coding-review', iteration),
      event('phase_start', 'coding-review', iteration, undefined, 'judge'),
      event('phase_judge_stage', 'coding-review', iteration, 'done', 'judge'),
      event('phase_complete', 'coding-review', iteration, terminalStatus, 'judge'),
      event('step_start', 'unobserved-review', iteration),
      event('step_complete', 'review', iteration, 'done'),
    ];
    const trace = buildExecutionTrace(
      { workflow: 'review', status: 'completed' },
      [
        ...batch(4, 'done'),
        ...batch(9, 'failed'),
        ...batch(14, 'aborted'),
      ].reverse(),
    );
    const occurrence = (step: string, iteration: number) => (
      trace.nodes.find((node) => node.label === step)?.occurrences.find(
        (candidate) => candidate.iteration === iteration,
      )
    );

    expect(occurrence('coding-review', 4)?.status).toBe('completed');
    expect(occurrence('coding-review', 9)?.status).toBe('failed');
    expect(occurrence('coding-review', 14)?.status).toBe('aborted');
    expect([4, 9, 14].map((iteration) => occurrence('unobserved-review', iteration)?.status))
      .toEqual(['unknown', 'unknown', 'unknown']);

    const activeTrace = buildExecutionTrace(
      { workflow: 'review', status: 'running' },
      [event('step_start', 'unobserved-review', 1), event('step_start', 'review', 1)].reverse(),
    );
    expect(activeTrace.nodes.find((node) => node.label === 'unobserved-review')?.occurrences[0]?.status)
      .toBe('running');
  });

  it('moves every parallel member by one scaled delta and reports each node position', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parent: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'review',
        kind: 'parallel',
        occurrence: 1,
      };
      const event = (step: string): ExecutionEvent => ({
        type: 'step_start',
        workflow: 'default',
        step,
        iteration: 1,
        stack: [parent, {
          workflow: 'default',
          workflow_ref: 'default',
          step,
          kind: 'agent',
          occurrence: 1,
        }],
      });
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [event('architecture-review'), event('coding-review')],
      );
      const selected: string[] = [];
      const moved: Array<{ id: string; x: number; y: number }> = [];
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
        onSelectParallelGroup: (_group, iteration) => selected.push(iteration.key),
        onMoveNode: (id, position) => moved.push({ id, ...position }),
      });
      const steps = section.querySelectorAll('.execution-step') as FakeDomNode[];
      const header = section.querySelectorAll('.execution-parallel-group-header')[0] as FakeDomNode;
      const iterationButton = section.querySelectorAll('.execution-parallel-iteration')[0] as FakeDomNode;
      const before = steps.map((step) => ({
        id: step.dataset.stepId,
        x: Number.parseFloat(step.style.left),
        y: Number.parseFloat(step.style.top),
      }));

      let interactivePointerDownStopped = false;
      iterationButton.dispatchEvent('pointerdown', {
        target: iterationButton,
        pointerId: 11,
        clientX: 40,
        clientY: 40,
        button: 0,
        stopPropagation: () => { interactivePointerDownStopped = true; },
      });
      iterationButton.dispatchEvent('pointerup', { target: iterationButton, pointerId: 11 });
      iterationButton.dispatchEvent('click', {
        target: iterationButton,
        stopPropagation: () => undefined,
      });
      expect(interactivePointerDownStopped).toBe(true);
      expect(selected).toHaveLength(1);
      expect(moved).toHaveLength(0);

      // Exercise the overlap/propagation failure mode: even if the group's
      // listener sees an interactive target, it must not start a drag.
      header.dispatchEvent('pointerdown', {
        target: iterationButton,
        pointerId: 13,
        clientX: 40,
        clientY: 40,
        button: 0,
        stopPropagation: () => undefined,
        preventDefault: () => undefined,
      });
      header.dispatchEvent('pointermove', {
        target: iterationButton,
        pointerId: 13,
        clientX: 100,
        clientY: 70,
        preventDefault: () => undefined,
      });
      header.dispatchEvent('pointerup', { target: iterationButton, pointerId: 13 });
      expect(moved).toHaveLength(0);

      let pointerDownPrevented = false;
      header.dispatchEvent('pointerdown', {
        target: header,
        pointerId: 12,
        clientX: 40,
        clientY: 40,
        button: 0,
        preventDefault: () => { pointerDownPrevented = true; },
      });
      expect(pointerDownPrevented).toBe(true);
      header.dispatchEvent('pointermove', {
        pointerId: 12,
        clientX: 100,
        clientY: 70,
        preventDefault: () => undefined,
      });
      header.dispatchEvent('pointerup', { pointerId: 12 });

      const after = steps.map((step) => ({
        id: step.dataset.stepId,
        x: Number.parseFloat(step.style.left),
        y: Number.parseFloat(step.style.top),
      }));
      expect(after.map((position, index) => [
        position.x - before[index]!.x,
        position.y - before[index]!.y,
      ])).toEqual([[60, 30], [60, 30]]);
      expect(moved.map(({ id }) => id)).toEqual(after.map(({ id }) => id));
      expect(moved.map(({ x, y }) => [x, y])).toEqual(after.map(({ x, y }) => [x, y]));
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps every ITER batch in one presentation family frame and group drag set', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const parallelFrame: ExecutionStackFrame = {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      };
      const event = (
        type: 'step_start' | 'step_complete',
        step: string,
        iteration: number,
      ): ExecutionEvent => ({
        type,
        workflow: 'default',
        step,
        iteration,
        stack: [parallelFrame],
        ...(type === 'step_complete' ? { status: 'done' } : {}),
      });
      const chronological: ExecutionEvent[] = [
        event('step_start', 'reviewers', 1),
        event('step_start', 'alpha', 1),
        event('step_complete', 'alpha', 1),
        event('step_complete', 'reviewers', 1),
        event('step_start', 'reviewers', 2),
        event('step_start', 'beta', 2),
        event('step_complete', 'beta', 2),
        event('step_complete', 'reviewers', 2),
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronological.slice().reverse(),
      );

      expect(trace.parallelGroups).toHaveLength(2);
      expect(trace.parallelGroups.map((group) => (
        group.nodeIds.map((nodeId) => trace.nodes.find((node) => node.id === nodeId)?.label)
      ))).toEqual([
        ['reviewers', 'alpha'],
        ['reviewers', 'beta'],
      ]);
      const iterationKeys = trace.parallelGroups.map((group) => group.key);
      const moved: string[] = [];
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
        onMoveNode: (id) => moved.push(id),
      });
      const map = section.querySelectorAll('.execution-map')[0] as FakeDomNode;
      const header = section.querySelectorAll('.execution-parallel-group-header')[0] as FakeDomNode;
      expect(section.querySelectorAll('.execution-parallel-group')).toHaveLength(1);
      expect(section.querySelectorAll('.execution-parallel-iteration')).toHaveLength(2);

      // Switching the selected batch must not rebuild the visual group's
      // member set from only the selected traceGroup.
      for (const key of iterationKeys) {
        updateExecutionMapSelection(map, null, null, key);
      }
      header.dispatchEvent('pointerdown', {
        target: header,
        pointerId: 21,
        clientX: 0,
        clientY: 0,
        button: 0,
        preventDefault: () => undefined,
      });
      header.dispatchEvent('pointermove', {
        pointerId: 21,
        clientX: 40,
        clientY: 30,
        preventDefault: () => undefined,
      });
      header.dispatchEvent('pointerup', { pointerId: 21 });

      expect(new Set(moved)).toEqual(new Set(
        trace.nodes.map((node) => node.id),
      ));
      expect(moved).toHaveLength(3);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('zooms only for Cmd/Ctrl wheel with cursor-centered scroll correction and clamps bounds', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [{ type: 'step_start', step: 'plan', iteration: 1 }],
      );
      const scales: number[] = [];
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
        onScaleChange: (scale) => scales.push(scale),
      });
      const map = section.querySelectorAll('.execution-map')[0] as FakeDomNode;
      const canvas = section.querySelectorAll('.execution-map-canvas')[0] as FakeDomNode;
      map.rect = { left: 10, top: 20, right: 410, width: 400, height: 300 };
      map.scrollLeft = 100;
      map.scrollTop = 50;

      let prevented = false;
      map.dispatchEvent('wheel', {
        deltaY: -1,
        clientX: 110,
        clientY: 120,
        metaKey: false,
        ctrlKey: false,
        preventDefault: () => { prevented = true; },
      });
      expect(prevented).toBe(false);
      expect(canvas.dataset.scale).toBe('1');

      map.dispatchEvent('wheel', {
        deltaY: -100000,
        clientX: 110,
        clientY: 120,
        metaKey: true,
        ctrlKey: false,
        preventDefault: () => { prevented = true; },
      });
      expect(prevented).toBe(true);
      expect(Number(canvas.dataset.scale)).toBe(MAX_MAP_SCALE);
      const overlay = section.querySelectorAll('.execution-edge-overlay')[0] as FakeDomNode;
      expect(overlay.attributes.width).toBe('640');
      expect(map.scrollLeft).toBe(300);
      expect(map.scrollTop).toBe(200);

      prevented = false;
      map.dispatchEvent('wheel', {
        deltaY: 100000,
        clientX: 210,
        clientY: 170,
        metaKey: false,
        ctrlKey: true,
        preventDefault: () => { prevented = true; },
      });
      expect(prevented).toBe(true);
      expect(Number(canvas.dataset.scale)).toBe(MIN_MAP_SCALE);
      expect(overlay.attributes.width).toBe('640');
      expect(scales).toEqual([MAX_MAP_SCALE, MIN_MAP_SCALE]);
      expect(clampMapScale(Number.NaN)).toBe(1);
      expect(clampMapScale(-10)).toBe(MIN_MAP_SCALE);
      expect(clampMapScale(10)).toBe(MAX_MAP_SCALE);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps every edge on the fixed NEXT-to-PREV ports', () => {
    const canvas = { left: 0, top: 0 };
    const source = { left: 10, top: 10, right: 110, bottom: 110 };
    const rightTarget = { left: 300, top: 20, right: 400, bottom: 120 };
    const rightGeometry = edgeAnchorGeometry(source, rightTarget, canvas);
    expect(rightGeometry.source.side).toBe('right');
    expect(rightGeometry.target.side).toBe('left');
    const zoomedGeometry = edgeAnchorGeometry(source, rightTarget, canvas, 2);
    expect(zoomedGeometry.source.x).toBe(rightGeometry.source.x / 2);
    expect(zoomedGeometry.source.y).toBe(rightGeometry.source.y / 2);
    expect(zoomedGeometry.target.x).toBe(rightGeometry.target.x / 2);
    expect(zoomedGeometry.target.y).toBe(rightGeometry.target.y / 2);
    const rightPath = curvePath(rightGeometry.source, rightGeometry.target, 'transition');
    expect(rightPath).toContain(` ${rightGeometry.target.x} ${rightGeometry.target.y}`);
    const rightPathNumbers = rightPath.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
    expect(rightPathNumbers[6]! - rightPathNumbers[4]!).toBeGreaterThan(0);

    const lowerTarget = { left: 20, top: 300, right: 120, bottom: 400 };
    const lowerGeometry = edgeAnchorGeometry(source, lowerTarget, canvas);
    expect(lowerGeometry.source.side).toBe('right');
    expect(lowerGeometry.target.side).toBe('left');
    const lowerPath = curvePath(lowerGeometry.source, lowerGeometry.target, 'transition');
    expect(lowerPath).toContain(` ${lowerGeometry.target.x} ${lowerGeometry.target.y}`);
    const lowerPathNumbers = lowerPath.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
    expect(lowerPathNumbers[6]! - lowerPathNumbers[4]!).toBeGreaterThan(0);
    expect(lowerPath).not.toBe(curvePath(rightGeometry.source, rightGeometry.target, 'transition'));

    const movedTarget = { left: -320, top: 20, right: -220, bottom: 120 };
    const movedGeometry = edgeAnchorGeometry(source, movedTarget, canvas);
    expect(movedGeometry.source.side).toBe('right');
    expect(movedGeometry.target.side).toBe('left');
    expect(curvePath(movedGeometry.source, movedGeometry.target, 'transition')).not.toBe(lowerPath);

    const measuredPorts = edgeAnchorGeometry(
      source,
      rightTarget,
      canvas,
      2,
      false,
      {
        source: { left: 90, top: 50, right: 110, bottom: 70 },
        target: { left: 300, top: 70, right: 320, bottom: 90 },
      },
    );
    expect(measuredPorts.source).toMatchObject({ x: 50, y: 30, side: 'right' });
    expect(measuredPorts.target).toMatchObject({ x: 155, y: 40, side: 'left' });
  });

  it('uses measured DOM rectangles when refreshing rendered edge geometry', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [
          { type: 'step_start', step: 'plan', iteration: 1 },
          { type: 'step_complete', step: 'plan', iteration: 1, status: 'done' },
          { type: 'step_start', step: 'review', iteration: 1 },
          { type: 'step_complete', step: 'review', iteration: 1, status: 'done' },
        ].reverse(),
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const map = section.querySelectorAll('.execution-map')[0] as FakeDomNode;
      const canvas = section.querySelectorAll('.execution-map-canvas')[0] as FakeDomNode;
      const chips = section.querySelectorAll('.iteration-chip') as FakeDomNode[];
      expect(chips).toHaveLength(2);
      const sourceRect = { left: 110, top: 120, right: 190, bottom: 144, width: 80, height: 24 };
      const targetRect = { left: 330, top: 130, right: 410, bottom: 154, width: 80, height: 24 };
      const canvasRect = { left: 10, top: 20 };
      chips[0]!.rect = sourceRect;
      chips[1]!.rect = targetRect;
      canvas.rect = { ...canvasRect, right: 650, bottom: 500, width: 640, height: 480 };
      map.dispatchEvent('scroll');

      const geometry = edgeAnchorGeometry(sourceRect, targetRect, canvasRect);
      const path = section.querySelectorAll('.execution-edge-transition')[0] as FakeDomNode;
      expect(path.attributes.d).toBe(curvePath(geometry.source, geometry.target, 'transition'));
      expect(geometry.source.side).toBe('right');
      expect(geometry.target.side).toBe('left');
      expect(geometry.target.x).toBe((targetRect.left - canvasRect.left));
      expect(geometry.target.y).toBe((targetRect.top + targetRect.bottom) / 2 - canvasRect.top);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('keeps a cyclic execution path within bounded layout columns', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const chronologicalEvents: ExecutionEvent[] = [
        { type: 'step_start', workflow: 'default', step: 'plan', iteration: 1 },
        { type: 'step_complete', workflow: 'default', step: 'plan', iteration: 1, status: 'done' },
        { type: 'step_start', workflow: 'default', step: 'review', iteration: 1 },
        { type: 'step_complete', workflow: 'default', step: 'review', iteration: 1, status: 'done' },
        { type: 'step_start', workflow: 'default', step: 'plan', iteration: 2 },
      ];
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        chronologicalEvents.slice().reverse(),
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const steps = section.querySelectorAll('.execution-step') as FakeDomNode[];
      const xPositions = steps.map((step) => Number(step.dataset.layoutX));

      expect(steps).toHaveLength(2);
      expect(Math.max(...xPositions)).toBeLessThanOrEqual(298);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('pans the map from empty space without stealing chip controls', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [{ type: 'step_start', step: 'plan', iteration: 1 }],
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const map = section.querySelectorAll('.execution-map')[0] as FakeDomNode;
      const header = section.querySelectorAll('.execution-step-header')[0] as FakeDomNode;
      const emptyTarget = { target: map, pointerId: 7, clientX: 10, clientY: 20, button: 0 };

      map.dispatchEvent('pointerdown', emptyTarget);
      expect(map.dataset.panPending).toBe('true');
      expect(map.hasPointerCapture(7)).toBe(true);
      map.dispatchEvent('pointermove', {
        ...emptyTarget,
        clientX: 40,
        clientY: 60,
        preventDefault: () => undefined,
      });
      expect(map.dataset.panning).toBe('true');
      expect(map.scrollLeft).toBe(-30);
      expect(map.scrollTop).toBe(-40);
      map.dispatchEvent('pointercancel', { pointerId: 7 });
      expect(map.dataset.panPending).toBeUndefined();
      expect(map.dataset.panning).toBeUndefined();
      expect(map.hasPointerCapture(7)).toBe(false);

      map.dispatchEvent('pointerdown', {
        target: header,
        pointerId: 8,
        clientX: 10,
        clientY: 20,
        button: 0,
      });
      expect(map.dataset.panPending).toBeUndefined();
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('annotates an attempted call without drawing an edge to an unobserved child', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [{
          type: 'workflow_call_start',
          workflow: 'default',
          step: 'delegate',
          childWorkflow: 'missing-child',
          callInstance: '1',
        }],
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });

      expect(section.querySelectorAll('.execution-call-connector')).toHaveLength(0);
      expect(section.querySelectorAll('.execution-call-boundary')).toHaveLength(0);
      expect(section.querySelectorAll('.execution-edge-call')).toHaveLength(0);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('does not expose a builtin digest as the main call label', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const ref = `builtin:sha256:${'b'.repeat(64)}`;
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [{
          type: 'workflow_call_start',
          workflow: 'default',
          step: 'delegate',
          childWorkflow: ref,
          callInstance: '1',
        }],
        undefined,
        undefined,
        'en',
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });

      expect(section.querySelectorAll('.execution-step')).toHaveLength(0);
      expect(trace.calls[0]?.displayChildWorkflow).toBe('Builtin workflow · bbbbbbbb');
      expect(section.querySelectorAll('.execution-call-connector')).toHaveLength(0);
      expect(section.querySelectorAll('.execution-step')).toHaveLength(0);
    } finally {
      runtime.document = previousDocument;
    }
  });

  it('cleans map scroll and fallback resize listeners when the section is replaced', () => {
    const runtime = globalThis as unknown as {
      document?: FakeDomDocument;
      window?: {
        addEventListener: (type: string, listener: unknown) => void;
        removeEventListener: (type: string, listener: unknown) => void;
      };
      ResizeObserver?: unknown;
    };
    const previousDocument = runtime.document;
    const previousWindow = runtime.window;
    const previousResizeObserver = runtime.ResizeObserver;
    const resizeListeners = new Map<string, unknown>();
    runtime.document = new FakeDomDocument();
    runtime.window = {
      addEventListener: (type, listener) => resizeListeners.set(type, listener),
      removeEventListener: (type, listener) => {
        if (resizeListeners.get(type) === listener) resizeListeners.delete(type);
      },
    };
    runtime.ResizeObserver = undefined;
    try {
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [{ type: 'step_start', step: 'plan', iteration: 1 }],
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const map = section.querySelectorAll('.execution-map')[0] as FakeDomNode;
      expect(map.listeners.has('scroll')).toBe(true);
      expect(resizeListeners.has('resize')).toBe(true);

      disposeExecutionMap(section);

      expect(map.listeners.has('scroll')).toBe(false);
      expect(map.listeners.has('pointerdown')).toBe(false);
      expect(map.listeners.has('pointermove')).toBe(false);
      expect(resizeListeners.has('resize')).toBe(false);
      disposeExecutionMap(section);
    } finally {
      runtime.document = previousDocument;
      runtime.window = previousWindow;
      runtime.ResizeObserver = previousResizeObserver;
    }
  });

  it('disconnects ResizeObserver when a map section is disposed', () => {
    const runtime = globalThis as unknown as {
      document?: FakeDomDocument;
      ResizeObserver?: unknown;
    };
    const previousDocument = runtime.document;
    const previousResizeObserver = runtime.ResizeObserver;
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      readonly observed: FakeDomNode[] = [];
      disconnectCount = 0;

      constructor(readonly callback: () => void) {
        FakeResizeObserver.instances.push(this);
      }

      observe(node: FakeDomNode) {
        this.observed.push(node);
      }

      disconnect() {
        this.disconnectCount += 1;
      }

      trigger() {
        this.callback();
      }
    }
    runtime.document = new FakeDomDocument();
    runtime.ResizeObserver = FakeResizeObserver;
    try {
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [{ type: 'step_start', step: 'plan', iteration: 1 }],
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });
      const observer = FakeResizeObserver.instances.at(-1);
      expect(observer?.observed).toHaveLength(2);

      disposeExecutionMap(section);

      expect(observer?.disconnectCount).toBe(1);
      observer?.trigger();
      disposeExecutionMap(section);
      expect(observer?.disconnectCount).toBe(1);
    } finally {
      runtime.document = previousDocument;
      runtime.ResizeObserver = previousResizeObserver;
    }
  });
});
