import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationPlan } from '../features/interactive/conversationPlan.js';
import { makeSessionContext } from './test-helpers.js';

const doubles = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  info: vi.fn(),
  plan: vi.fn(),
  loop: vi.fn(),
}));

vi.mock('../shared/utils/private-file.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/private-file.js')>()),
  readPrivateFileState: doubles.read,
  writePrivateFileWithModeExpected: doubles.write,
}));
vi.mock('../infra/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/paths.js')>()),
  ensureDir: vi.fn(),
}));
vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/ui/index.js')>()),
  info: doubles.info,
}));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/index.js')>()),
  hasInteractiveTerminal: () => false,
}));
vi.mock('../features/interactive/conversationPlan.js', () => ({
  createAssistantConversationPlan: doubles.plan,
}));
vi.mock('../features/interactive/conversationLoop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/conversationLoop.js')>()),
  runConversationLoop: doubles.loop,
}));
vi.mock('../features/interactive/taskInstructionFormat.js', () => ({
  resolveFormalSpecConfiguration: vi.fn().mockResolvedValue({
    mode: false, comments: true, modelCheckTimeoutSeconds: 300,
  }),
}));

import { interactiveMode } from '../features/interactive/interactive.js';

beforeEach(() => {
  vi.clearAllMocks();
  doubles.loop.mockResolvedValue({ action: 'save_task', task: 'current task' });
  doubles.read.mockImplementation((path: string) => ({
    state: { path, exists: true },
    content: Buffer.from(JSON.stringify({
      version: 1, publicationId: 'unrelated-run', status: 'pending',
      state: { status: 'error', errorMessage: 'unrelated provider unavailable',
        workflowName: 'unrelated-workflow', timestamp: '2026-10-09T00:00:00.000Z' },
    })),
  }));
});

describe('readline interactive entry', () => {
  it.each(['en', 'ja'] as const)('should return the current task in %s without displaying or consuming another run', async (lang) => {
    const plan: ConversationPlan = {
      ctx: makeSessionContext({ lang }),
      strategy: {
        systemPrompt: 'test prompt', formalSpec: false, modelCheckTimeoutSeconds: 300,
        allowedTools: [], transformPrompt: (message) => message, introMessage: 'conversation ready',
      },
    };
    doubles.plan.mockReturnValue(plan);

    expect(await interactiveMode('/test-project')).toEqual({ action: 'save_task', task: 'current task' });

    expect(doubles.info).not.toHaveBeenCalled();
    expect(doubles.read.mock.calls.filter(([path]) => String(path).endsWith('/session-state.json'))).toEqual([]);
    expect(doubles.write.mock.calls.filter(([path]) => String(path).endsWith('/session-state.json'))).toEqual([]);
  });
});
