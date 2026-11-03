import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractiveSessionRecord } from '../features/interactive/interactiveSessionRecords.js';

const store = vi.hoisted(() => ({ listRecords: vi.fn() }));
const picker = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock('../features/interactive/interactiveSessionRecords.js', () => store);
vi.mock('../shared/prompt/index.js', () => ({ selectOption: picker }));
vi.mock('../shared/ui/index.js', () => ({ info }));
vi.mock('../shared/i18n/index.js', () => ({
  getLabel: (key: string, _lang: string, params?: Record<string, string>) => params?.response ?? params?.count ?? key,
}));

import { selectRecentSession } from '../features/interactive/sessionSelector.js';

function record(overrides: Partial<InteractiveSessionRecord> = {}): InteractiveSessionRecord {
  return { provider: 'codex', sessionId: 's1', inputs: ['first', 'second', 'last'], response: 'reply', modified: '2026-01-28T10:00:00Z', messageCount: 6, ...overrides };
}

describe('selectRecentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.listRecords.mockReturnValue([]);
    picker.mockResolvedValue(null);
  });

  it('reports an empty recorded session list', async () => {
    expect(await selectRecentSession('/project', 'en', 'codex')).toBeNull();
    expect(store.listRecords).toHaveBeenCalledWith('/project', 'codex');
    expect(picker).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
  });

  it.each(['__new__', null])('returns null for new session or cancellation (%s)', async (selected) => {
    store.listRecords.mockReturnValue([record()]);
    picker.mockResolvedValue(selected);
    expect(await selectRecentSession('/project', 'en', 'codex')).toBeNull();
  });

  it('returns the selected session and displays recent inputs, response and metadata', async () => {
    store.listRecords.mockReturnValue([record()]);
    picker.mockResolvedValue('s1');
    expect(await selectRecentSession('/project', 'en', 'codex')).toBe('s1');
    const options = picker.mock.calls[0]![1] as Array<{ value: string; label: string; description?: string; details?: string[] }>;
    expect(options.map((option) => option.value)).toEqual(['__new__', 's1']);
    expect(options[1]).toMatchObject({ label: 'last', details: ['second', 'first', 'reply'] });
    expect(options[1]?.description).toContain('6');
    expect(options[1]?.description).toContain('Jan');
  });

  it('renders multiline long input and response as truncated single lines', async () => {
    store.listRecords.mockReturnValue([record({ inputs: ['old\nline', 'a'.repeat(100)], response: 'b'.repeat(100) + '\nend' })]);
    await selectRecentSession('/project', 'en', 'codex');
    const item = (picker.mock.calls[0]![1] as Array<{ label: string; details: string[] }>)[1]!;
    expect(item.label.length).toBeLessThan(100);
    expect(item.details[1]!.length).toBeLessThan(100);
    expect([item.label, ...item.details].every((line) => !line.includes('\n'))).toBe(true);
  });
});
