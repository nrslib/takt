import { existsSync } from 'node:fs';

const triggerPath = process.env.TAKT_E2E_PAUSE_STDIN_TRIGGER;
if (!triggerPath) {
  throw new Error('TAKT_E2E_PAUSE_STDIN_TRIGGER is required');
}

const LISTENER_WAIT_MS = 20_000;
let deadline;

const timer = setInterval(() => {
  if (!existsSync(triggerPath)) {
    return;
  }
  deadline ??= Date.now() + LISTENER_WAIT_MS;

  if (process.stdin.isTTY && process.stdin.listenerCount('data') > 0) {
    clearInterval(timer);
    process.stdin.pause();
    process.stdout.write('[e2e] stdin paused\n');
    return;
  }

  if (Date.now() >= deadline) {
    clearInterval(timer);
    process.stderr.write('[e2e] stdin data listener was not registered\n');
  }
}, 10);

timer.unref();
