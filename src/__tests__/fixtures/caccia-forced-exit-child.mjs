import { mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot = process.env.TAKT_SOURCE_ROOT;
const projectCwd = process.env.TAKT_CACCIA_PROJECT_CWD;
const remote = process.env.TAKT_CACCIA_REMOTE;
const branch = process.env.TAKT_CACCIA_BRANCH;
const headSha = process.env.TAKT_CACCIA_HEAD_SHA;
const reportPath = process.env.TAKT_CACCIA_REPORT_PATH;
const timeoutMarkerPath = process.env.TAKT_CACCIA_TIMEOUT_MARKER;
const cloneCount = Number(process.env.TAKT_CACCIA_CLONE_COUNT);
const route = process.env.TAKT_CACCIA_ROUTE;
const failFirstCleanup = process.env.TAKT_CACCIA_FAIL_FIRST_CLEANUP === 'true';
const activeClonePaths = new Set();

function reportGracefulStart() {
  const clonePaths = [...activeClonePaths];
  process.send?.({
    type: 'graceful-started',
    clonePaths,
    cloneExists: clonePaths.map((path) => fs.existsSync(path)),
  });
}

if (
  sourceRoot === undefined
  || projectCwd === undefined
  || remote === undefined
  || branch === undefined
  || headSha === undefined
  || reportPath === undefined
  || timeoutMarkerPath === undefined
  || (route !== 'worker-pool' && route !== 'standalone' && route !== 'pipeline')
) {
  throw new Error('Caccia forced-exit child is missing fixture configuration');
}

const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  const message = args.map(String).join(' ');
  if (message.includes('5000ms')) {
    fs.writeFileSync(timeoutMarkerPath, message, 'utf8');
  }
  originalConsoleLog(...args);
};

if (failFirstCleanup) {
  const originalMkdtempSync = fs.mkdtempSync.bind(fs);
  const originalRmSync = fs.rmSync.bind(fs);
  let firstClonePath;
  let forcingExit = false;
  fs.mkdtempSync = (prefix, options) => {
    const path = originalMkdtempSync(prefix, options);
    if (prefix.endsWith('takt-caccia-42-') && firstClonePath === undefined) {
      firstClonePath = path;
    }
    return path;
  };
  fs.rmSync = (path, options) => {
    if (forcingExit && path === firstClonePath) {
      throw new Error(`injected exit cleanup failure for ${path}`);
    }
    return originalRmSync(path, options);
  };
  syncBuiltinESMExports();
  process.once('exit', () => {
    forcingExit = true;
  });
}

const githubModule = pathToFileURL(join(sourceRoot, 'src/infra/github/pr.js')).href;
mock.module(githubModule, {
  namedExports: {
    fetchCacciaPullRequestDetails: () => ({
      number: 42,
      headBranch: branch,
      headSha,
      headRepositorySshUrl: remote,
    }),
    fetchCacciaPullRequestHeadSha: () => headSha,
    fetchCodeRabbitReviewStatus: () => ({
      headSha,
      hasCodeRabbitPost: true,
      reviewedHeadShas: [headSha],
    }),
    fetchCodeRabbitReviewThreads: () => [{
      id: 'thread-42',
      author: 'coderabbitai',
      body: 'Apply the requested correction.',
    }],
    resolveReviewThread: async () => undefined,
  },
});

const workflowModule = pathToFileURL(join(sourceRoot, 'src/features/tasks/execute/workflowExecutionApi.js')).href;
mock.module(workflowModule, {
  namedExports: {
    runWorkflowExecution: async (options) => {
      activeClonePaths.add(options.cwd);
      if (route !== 'worker-pool') {
        options.abortSignal?.addEventListener('abort', reportGracefulStart, { once: true });
      }
      fs.mkdirSync(join(projectCwd, '.takt', 'runs', 'caccia-forced-exit'), { recursive: true });
      fs.writeFileSync(reportPath, 'workflow reached before forced exit\n', 'utf8');
      process.send?.({ type: 'workflow-started', cwd: options.cwd });
      return new Promise(() => undefined);
    },
  },
});

const { runCaccia, runLinkedCacciaSafely } = await import(
  pathToFileURL(join(sourceRoot, 'src/features/caccia/index.ts')).href
);
if (route === 'worker-pool') {
  const taskExecutionModule = pathToFileURL(join(sourceRoot, 'src/features/tasks/execute/runTaskExecution.js')).href;
  mock.module(taskExecutionModule, {
    namedExports: {
      executeRunTaskAndComplete: async (_task, _taskRunner, _cwd, _taskExecutionOptions, workerContext) => {
        workerContext.abortSignal.addEventListener('abort', () => {
          reportGracefulStart();
        }, { once: true });
        await Promise.all(Array.from(
          { length: cloneCount },
          () => runLinkedCacciaSafely(projectCwd, 'https://github.com/org/repo/pull/42', workerContext.abortSignal),
        ));
        return true;
      },
    },
  });

  const { runWithWorkerPool } = await import(
    pathToFileURL(join(sourceRoot, 'src/features/tasks/execute/parallelExecution.js')).href
  );
  const listenersBeforeRun = new Set(process.listeners('SIGINT'));
  const workerPoolExecution = runWithWorkerPool(
    {},
    [{ filePath: join(projectCwd, '.takt', 'tasks.yaml'), name: 'Caccia task', data: null }],
    1,
    projectCwd,
    undefined,
    undefined,
    30_000,
  );
  const addedSigintListeners = process.listeners('SIGINT').filter((listener) => !listenersBeforeRun.has(listener));
  process.send?.({ type: 'shutdown-handler-registered', listenerCount: addedSigintListeners.length });
  if (addedSigintListeners.length !== 1) {
    throw new Error(`Expected one worker-pool SIGINT handler, found ${addedSigintListeners.length}`);
  }

  process.on('message', (message) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) {
      return;
    }
    if (message.type === 'invoke-shutdown-handler') {
      addedSigintListeners[0]();
      process.send?.({ type: 'shutdown-handler-invoked' });
    }
  });
  await workerPoolExecution;
} else {
  setInterval(() => undefined, 1_000);
  if (route === 'standalone') {
    await runCaccia({
      entry: 'standalone',
      prNumber: 42,
      projectCwd,
      settings: { enabled: true, waitTimeoutMs: 1_000, maxIterations: 1, workflow: 'caccia' },
    });
  } else {
    await runLinkedCacciaSafely(projectCwd, 'https://github.com/org/repo/pull/42');
  }
}
