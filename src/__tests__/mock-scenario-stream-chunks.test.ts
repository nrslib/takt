/**
 * Unit tests for gradual text streaming from mock scenarios (`text_chunks`).
 *
 * The Ink TUI only misrenders when text arrives in several stream events over
 * time, so the mock provider needs to reproduce that timing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scenarioFiles = vi.hoisted(() => new Map<string, string>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: string) => scenarioFiles.has(path),
    readFileSync: (path: string) => {
      const content = scenarioFiles.get(path);
      if (content === undefined) {
        throw new Error(`No scenario file registered at ${path}`);
      }
      return content;
    },
  };
});

import { callMock } from '../infra/mock/client.js';
import { loadScenarioFile, resetScenario, setMockScenario } from '../infra/mock/scenario.js';
import type { StreamEvent } from '../shared/types/provider.js';

function collectStream(events: StreamEvent[]): (event: StreamEvent) => void {
  return (event) => { events.push(event); };
}

function textsOf(events: StreamEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'text' ? [event.data.text] : []));
}

afterEach(() => {
  resetScenario();
});

describe('callMock: text_chunks streaming', () => {
  it('emits one text event per chunk in order and keeps content unchanged', async () => {
    setMockScenario([{
      status: 'done',
      content: 'Hello brave world',
      textChunks: [
        { text: 'Hello ' },
        { text: 'brave ' },
        { text: 'world' },
      ],
    }]);
    const events: StreamEvent[] = [];

    const result = await callMock('coder', 'task text', {
      cwd: '/tmp/project',
      onStream: collectStream(events),
    });

    expect(textsOf(events)).toEqual(['Hello ', 'brave ', 'world']);
    expect(result.content).toBe('Hello brave world');
    expect(result.status).toBe('done');
    expect(events[0]?.type).toBe('init');
    expect(events.at(-1)?.type).toBe('result');
  });

  it('emits exactly one text event carrying the whole content without text_chunks', async () => {
    setMockScenario([{ status: 'done', content: 'Single event content' }]);
    const events: StreamEvent[] = [];

    const result = await callMock('coder', 'task text', {
      cwd: '/tmp/project',
      onStream: collectStream(events),
    });

    expect(textsOf(events)).toEqual(['Single event content']);
    expect(result.content).toBe('Single event content');
  });

  it('waits the per-chunk delay before emitting each chunk', async () => {
    setMockScenario([{
      status: 'done',
      content: 'ab',
      textChunks: [
        { text: 'a', delayMs: 20 },
        { text: 'b', delayMs: 20 },
      ],
    }]);
    const arrivals: Array<{ text: string; elapsed: number }> = [];
    const start = Date.now();

    await callMock('coder', 'task text', {
      cwd: '/tmp/project',
      onStream: (event) => {
        if (event.type === 'text') {
          arrivals.push({ text: event.data.text, elapsed: Date.now() - start });
        }
      },
    });

    expect(arrivals.map((arrival) => arrival.text)).toEqual(['a', 'b']);
    expect(arrivals[0]!.elapsed).toBeGreaterThanOrEqual(15);
    expect(arrivals[1]!.elapsed).toBeGreaterThanOrEqual(arrivals[0]!.elapsed);
  });

  it('stops streaming further chunks and returns the aborted response on mid-stream abort', async () => {
    setMockScenario([{
      status: 'done',
      content: 'first second',
      textChunks: [
        { text: 'first ' },
        { text: 'second', delayMs: 5000 },
      ],
    }]);
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await callMock('coder', 'task text', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
      onStream: collectStream(events),
    });

    expect(textsOf(events)).toEqual(['first ']);
    expect(events.some((event) => event.type === 'result')).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.content).toContain('[MOCK:ABORTED]');
  });
});

describe('loadScenarioFile: text_chunks', () => {
  beforeEach(() => {
    scenarioFiles.clear();
  });

  function registerScenario(name: string, json: string): string {
    const filePath = `/scenarios/${name}`;
    scenarioFiles.set(filePath, json);
    return filePath;
  }

  it('maps text_chunks and delay_ms to textChunks and delayMs', () => {
    const filePath = registerScenario('chunks.json', JSON.stringify([{
      content: 'ab',
      text_chunks: [{ text: 'a', delay_ms: 120 }, { text: 'b' }],
    }]));

    const entries = loadScenarioFile(filePath);

    expect(entries[0]!.textChunks).toEqual([{ text: 'a', delayMs: 120 }, { text: 'b' }]);
  });

  it('throws with the entry index when text_chunks is not an array', () => {
    const filePath = registerScenario('not-array.json', '[{"content": "a", "text_chunks": "a"}]');

    expect(() => loadScenarioFile(filePath)).toThrow(
      'Scenario entry [0] "text_chunks" must be an array',
    );
  });

  it('throws with the entry and chunk index when a chunk is not an object', () => {
    const filePath = registerScenario(
      'not-object.json',
      '[{"content": "a"}, {"content": "b", "text_chunks": ["a"]}]',
    );

    expect(() => loadScenarioFile(filePath)).toThrow(
      'Scenario entry [1] text_chunks[0] must be an object',
    );
  });

  it('throws when a chunk has no text string', () => {
    const filePath = registerScenario(
      'no-text.json',
      '[{"content": "a", "text_chunks": [{"delay_ms": 10}]}]',
    );

    expect(() => loadScenarioFile(filePath)).toThrow(
      'Scenario entry [0] text_chunks[0] must have a "text" string',
    );
  });

  it('throws when a chunk delay_ms is not a number', () => {
    const filePath = registerScenario(
      'bad-delay.json',
      '[{"content": "a", "text_chunks": [{"text": "a", "delay_ms": "10"}]}]',
    );

    expect(() => loadScenarioFile(filePath)).toThrow(
      'Scenario entry [0] text_chunks[0] "delay_ms" must be a number if provided',
    );
  });
});
