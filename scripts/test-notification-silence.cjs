const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { basename } = require('node:path');
const workerThreads = require('node:worker_threads');

const notificationSilencePreload = __filename;
const preloadOption = `--require=${JSON.stringify(notificationSilencePreload)}`;
const installed = Symbol.for('takt.testNotificationSilence');

function withNotificationSilenceEnv(env) {
  const options = env.NODE_OPTIONS ?? '';
  return {
    ...env,
    NODE_OPTIONS: options.includes(preloadOption) ? options : `${preloadOption} ${options}`.trimEnd(),
  };
}

function isNotificationCommand(file, args) {
  const command = basename(file);
  return ['afplay', 'paplay', 'aplay', 'notify-send'].includes(command)
    || (command === 'osascript' && args.some((arg) => /^\s*display\s+notification\b/.test(arg)));
}

function silentCommand(file, args) {
  return isNotificationCommand(file, args)
    ? { file: process.execPath, args: ['-e', ''] }
    : { file, args };
}

function installNotificationSilence() {
  if (globalThis[installed]) return;
  globalThis[installed] = true;
  process.env.NODE_OPTIONS = withNotificationSilenceEnv(process.env).NODE_OPTIONS;

  // The normalized boundary also covers execFile's native promisify implementation
  // and fork without changing callbacks, streams, or ChildProcess lifecycle events.
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function (options) {
    const command = silentCommand(options.file, options.args.slice(1));
    const envPairs = options.envPairs.filter((entry) => !entry.startsWith('NODE_OPTIONS='));
    const nodeOptions = options.envPairs.find((entry) => entry.startsWith('NODE_OPTIONS='));
    // The no-op must not execute a caller's --import hook again: that hook
    // may itself notify, which would recursively start another no-op.
    const env = withNotificationSilenceEnv({
      NODE_OPTIONS: command.file === options.file ? nodeOptions?.slice('NODE_OPTIONS='.length) : undefined,
    });
    return originalSpawn.call(this, {
      ...options,
      file: command.file,
      args: command.file === options.file ? options.args : [command.file, ...command.args],
      envPairs: [...envPairs, `NODE_OPTIONS=${env.NODE_OPTIONS}`],
    });
  };

  for (const method of ['spawnSync', 'execFileSync']) {
    const original = childProcess[method];
    childProcess[method] = function (file, args, options) {
      const hasArgs = Array.isArray(args);
      const omittedArgs = args === undefined || args === null;
      const suppliedOptions = hasArgs || omittedArgs ? options : args;
      const invalidOptions = suppliedOptions !== undefined && (
        suppliedOptions === null
          ? method === 'spawnSync'
          : typeof suppliedOptions !== 'object' || Array.isArray(suppliedOptions)
      );
      // Let Node report invalid overloads instead of normalizing them away.
      if (typeof file !== 'string'
        || (!hasArgs && !omittedArgs && typeof args !== 'object')
        || invalidOptions) {
        return original.apply(this, arguments);
      }
      const opts = suppliedOptions ?? {};
      const command = silentCommand(file, hasArgs ? args : []);
      return original.call(this, command.file, command.args, {
        ...opts,
        env: withNotificationSilenceEnv({
          ...(opts.env ?? process.env),
          ...(command.file !== file ? { NODE_OPTIONS: undefined } : {}),
        }),
      });
    };
  }

  const originalExecSync = childProcess.execSync;
  childProcess.execSync = function (command, options) {
    return originalExecSync.call(this, command, {
      ...options,
      env: withNotificationSilenceEnv(options?.env ?? process.env),
    });
  };

  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class extends OriginalWorker {
    constructor(filename, options) {
      // Worker execArgv can replace the parent's preload, and NODE_OPTIONS in
      // the worker's env alone does not execute a preload in the new isolate.
      const suppliedExecArgv = options?.execArgv;
      const canPreload = options !== null
        && (suppliedExecArgv === undefined || Array.isArray(suppliedExecArgv));
      const execArgv = suppliedExecArgv ?? process.execArgv;
      super(filename, canPreload ? {
        ...options,
        execArgv: execArgv.includes(notificationSilencePreload)
          ? execArgv
          : ['--require', notificationSilencePreload, ...execArgv],
      } : options);
    }
  };

  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, encoding, callback) {
    let output = chunk;
    if (typeof chunk === 'string') {
      output = chunk.replaceAll('\x07', '');
    } else if (chunk instanceof Uint8Array && chunk.includes(7)) {
      output = chunk.filter((byte) => byte !== 7);
    }
    if (output === chunk || output.length > 0) {
      return originalWrite.call(this, output, encoding, callback);
    }
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) process.nextTick(done);
    return true;
  };
  syncBuiltinESMExports();
}

module.exports = { installNotificationSilence, withNotificationSilenceEnv, notificationSilencePreload };

if (process.env.NODE_OPTIONS?.includes(preloadOption)
  || process.execArgv.includes(notificationSilencePreload)) {
  installNotificationSilence();
}
