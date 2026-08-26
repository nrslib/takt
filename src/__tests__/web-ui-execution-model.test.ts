import { describe, expect, it } from 'vitest';
import {
  buildExecutionTrace,
  encodeIdPart,
  reportDirectory,
  reportDisplayName,
} from '../../web-ui/public/execution-model.js';
import type { ExecutionEvent, ExecutionStackFrame } from '../../web-ui/public/execution-model.js';
import {
  disposeExecutionMap,
  renderExecutionMap,
} from '../../web-ui/public/execution-map.js';

class FakeDomNode {
  className = '';
  textContent = '';
  children: FakeDomNode[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  style = { setProperty: (_property: string, _value: string) => undefined };
  scrollLeft = 0;
  scrollTop = 0;
  scrollWidth = 640;
  scrollHeight = 320;
  rect = { left: 0, top: 0, right: 80, width: 80, height: 24 };
  listeners = new Map<string, () => void>();

  constructor(readonly tagName: string) {}

  append(...children: FakeDomNode[]) {
    this.children.push(...children.flat().filter(Boolean));
  }

  addEventListener(type: string, listener: unknown) {
    if (typeof listener === 'function') this.listeners.set(type, listener as () => void);
  }

  removeEventListener(type: string, listener: unknown) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  dispatchEvent(type: string) {
    this.listeners.get(type)?.();
  }

  replaceChildren(...children: FakeDomNode[]) {
    this.children = children;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replaceAll('-', '')] = value;
  }

  matches(selector: string) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('[')) {
      const [, name, value] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) ?? [];
      if (name === undefined) return false;
      const dataName = name.startsWith('data-') ? name.slice(5).replaceAll('-', '') : undefined;
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
}

class FakeDomDocument {
  createElement(tagName: string) {
    return new FakeDomNode(tagName);
  }

  createElementNS(_namespace: string, tagName: string) {
    return new FakeDomNode(tagName);
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

  it('represents repeated logical steps as selectable loop passes', () => {
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
    expect(trace.loops).toEqual([
      expect.objectContaining({
        logicalId: review?.id,
        iteration: 2,
      }),
    ]);
    expect(trace.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'loop', sourceLogicalId: review?.id, targetLogicalId: review?.id }),
    ]));
    expect(trace.totalOccurrences).toBe(3);
  });

  it('keeps workflow calls distinct and assigns observed child lanes a deeper level', () => {
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'completed' },
      [
        { type: 'step_complete', workflow: 'review-fix', step: 'fix', persona: 'Coder', iteration: 1, status: 'done' },
        { type: 'step_start', workflow: 'review-fix', step: 'fix', persona: 'Coder', iteration: 1 },
        {
          type: 'workflow_call_complete',
          workflow: 'default',
          step: 'review',
          childWorkflow: 'review-fix',
          callInstance: '2',
          status: 'completed',
        },
        {
          type: 'workflow_call_start',
          workflow: 'default',
          step: 'review',
          childWorkflow: 'review-fix',
          callInstance: '2',
        },
      ],
    );

    const call = trace.nodes.find((node) => node.kind === 'workflow');
    expect(call).toMatchObject({
      workflow: 'default',
      label: 'review-fix',
      occurrences: [expect.objectContaining({ callInstance: '2', status: 'completed' })],
    });
    expect(trace.calls).toEqual([
      expect.objectContaining({ workflow: 'default', childWorkflow: 'review-fix', callInstance: '2' }),
    ]);
    expect(trace.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflow: 'default', depth: 0 }),
      expect.objectContaining({ workflow: 'review-fix', depth: 1 }),
    ]));
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

  it('renders observed loop and workflow-call connectors in the map contract', () => {
    const runtime = globalThis as unknown as { document?: FakeDomDocument };
    const previousDocument = runtime.document;
    runtime.document = new FakeDomDocument();
    try {
      const trace = buildExecutionTrace(
        { workflow: 'default', status: 'running' },
        [
          {
            type: 'workflow_call_complete',
            workflow: 'default',
            step: 'delegate',
            childWorkflow: 'child',
            callInstance: '1',
            status: 'completed',
          },
          {
            type: 'workflow_call_start',
            workflow: 'default',
            step: 'delegate',
            childWorkflow: 'child',
            callInstance: '1',
          },
          {
            type: 'step_complete',
            workflow: 'child',
            step: 'work',
            iteration: 1,
            status: 'done',
          },
          {
            type: 'step_start',
            workflow: 'child',
            step: 'work',
            iteration: 1,
          },
          { type: 'step_complete', step: 'review', iteration: 2, status: 'done' },
          { type: 'step_start', step: 'review', iteration: 2 },
          { type: 'step_complete', step: 'review', iteration: 1, status: 'done' },
          { type: 'step_start', step: 'review', iteration: 1 },
        ],
      );
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
      });

      expect(section.querySelectorAll('.execution-loop-connector')).toHaveLength(1);
      expect(section.querySelectorAll('[data-loop-id]')).toHaveLength(1);
      expect(section.querySelectorAll('.execution-call-connector')).toHaveLength(1);
      expect(section.querySelectorAll('[data-call-id]')).toHaveLength(1);
      expect(section.querySelectorAll('.execution-edge-loop')).toHaveLength(1);
      expect(section.querySelectorAll('.execution-edge-call')).toHaveLength(1);
      expect(section.querySelectorAll('[data-source-occurrence-id]')).toHaveLength(4);
      expect(section.querySelectorAll('[data-target-occurrence-id]')).toHaveLength(4);
      expect(section.querySelectorAll('[data-edge]')).toHaveLength(2);
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

      expect(section.querySelectorAll('[data-target-observed="false"]')).toHaveLength(1);
      expect(section.querySelectorAll('.execution-edge-call')).toHaveLength(0);
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
