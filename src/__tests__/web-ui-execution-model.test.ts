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
  disposeExecutionMap,
  renderExecutionMap,
} from '../../web-ui/public/execution-map.js';
import { resolveLogSelection } from '../../web-ui/public/execution-view.js';

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
  rect = { left: 0, top: 0, right: 80, width: 80, height: 24 };
  listeners = new Map<string, (event?: Record<string, unknown>) => void>();
  pointerCaptures = new Set<number>();

  constructor(readonly tagName: string) {}

  append(...children: FakeDomNode[]) {
    this.children.push(...children.flat().filter(Boolean));
  }

  addEventListener(type: string, listener: unknown) {
    if (typeof listener === 'function') {
      this.listeners.set(type, listener as (event?: Record<string, unknown>) => void);
    }
  }

  removeEventListener(type: string, listener: unknown) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  dispatchEvent(type: string, event: Record<string, unknown> = {}) {
    this.listeners.get(type)?.(event);
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
    expect(trace.nodes.find((node) => node.label === 'plan')?.occurrences[0]?.ordinal).toBe(2);
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
        (chip) => /^STEP \d+/.test(chip.textContent),
      )).toBe(true);
      expect(section.querySelectorAll('.execution-edge-transition')).toHaveLength(2);
      expect(section.querySelectorAll('.execution-edge-loop')).toHaveLength(1);
      expect(section.querySelectorAll('.execution-edge-call')).toHaveLength(1);
      expect(section.querySelectorAll('[data-edge]')).toHaveLength(4);
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
      expect(section.querySelectorAll('.workflow-lane')).toHaveLength(0);
    } finally {
      runtime.document = previousDocument;
    }
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
      const moved: Array<{ id: string; x: number; y: number }> = [];
      const section = renderExecutionMap(trace, {
        liveIndicator: new FakeDomNode('span'),
        emptyState: new FakeDomNode('div'),
        selectedOccurrenceId: null,
        onSelectOccurrence: () => undefined,
        onMoveNode: (id, position) => moved.push({ id, ...position }),
      });
      const steps = section.querySelectorAll('.execution-step') as FakeDomNode[];
      const header = section.querySelectorAll('.execution-parallel-group-header')[0] as FakeDomNode;
      const before = steps.map((step) => ({
        id: step.dataset.stepId,
        x: Number.parseFloat(step.style.left),
        y: Number.parseFloat(step.style.top),
      }));

      header.dispatchEvent('pointerdown', {
        pointerId: 12,
        clientX: 40,
        clientY: 40,
        button: 0,
      });
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
