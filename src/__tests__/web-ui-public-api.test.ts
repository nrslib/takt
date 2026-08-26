import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, sendChatMessage, startTask } from '../../web-ui/public/api.js';

describe('Web UI public API response handling', () => {
  const fetchMock = vi.fn();

  async function initializeSession(token = 'web-token'): Promise<void> {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token, capabilities: { nativeDirectoryPicker: false } }),
    });
    await getSession();
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('preserves a server-provided JSON error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'run already exists' }),
    });

    await expect(getSession()).rejects.toThrow('run already exists');
  });

  it('uses HTTP status when an error response is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('not JSON'); },
    });

    await expect(getSession()).rejects.toThrow('Request failed: 502');
  });

  it('rejects a successful response without a JSON body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => null,
    });

    await expect(getSession()).rejects.toThrow('Invalid response: 204');
  });

  it('uses the shared mutation options for starting a task', async () => {
    await initializeSession();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ started: true }),
    });

    await expect(startTask({ projectId: 'project', workflow: 'default' }))
      .resolves.toEqual({ started: true });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': 'web-token',
      },
      body: JSON.stringify({ projectId: 'project', workflow: 'default' }),
    });
  });

  it('refreshes an invalid session token and retries a mutation once', async () => {
    await initializeSession('expired-token');
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Session token is invalid' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: 'fresh-token', capabilities: { nativeDirectoryPicker: false } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ started: true }),
      });

    await expect(startTask({ projectId: 'project', workflow: 'default' }))
      .resolves.toEqual({ started: true });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/tasks', expect.objectContaining({
      headers: expect.objectContaining({ 'X-TAKT-Web-Token': 'expired-token' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/session', undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/tasks', expect.objectContaining({
      headers: expect.objectContaining({ 'X-TAKT-Web-Token': 'fresh-token' }),
    }));
  });

  it('streams thinking chunks before returning the final chat reply', async () => {
    await initializeSession();
    const payload = [
      JSON.stringify({ type: 'thinking', content: '調査中' }),
      JSON.stringify({ type: 'thinking', content: 'です。' }),
      JSON.stringify({
        type: 'reply',
        reply: { kind: 'assistant_response', content: '回答です。' },
      }),
      '',
    ].join('\n');
    const encoded = new TextEncoder().encode(payload);
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.subarray(0, 31));
        controller.enqueue(encoded.subarray(31));
        controller.close();
      },
    }), { status: 200 }));
    const thinking: string[] = [];

    await expect(sendChatMessage('session-1', '相談', (content) => {
      thinking.push(content);
    })).resolves.toEqual({ kind: 'assistant_response', content: '回答です。' });
    expect(thinking).toEqual(['調査中', 'です。']);
  });

  it('surfaces an error emitted after chat streaming starts', async () => {
    await initializeSession();
    const payload = [
      JSON.stringify({ type: 'thinking', content: '確認中' }),
      JSON.stringify({ type: 'error', message: 'provider failed' }),
      '',
    ].join('\n');
    fetchMock.mockResolvedValue(new Response(payload, { status: 200 }));

    await expect(sendChatMessage('session-1', '相談', () => {}))
      .rejects.toThrow('provider failed');
  });
});
