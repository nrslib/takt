import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, startRun } from '../../web-ui/public/api.js';

describe('Web UI public API response handling', () => {
  const fetchMock = vi.fn();

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

  it('uses the shared mutation options for starting a run', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ started: true }),
    });

    await expect(startRun('web-token', { projectId: 'project', workflow: 'default' }))
      .resolves.toEqual({ started: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': 'web-token',
      },
      body: JSON.stringify({ projectId: 'project', workflow: 'default' }),
    });
  });
});
