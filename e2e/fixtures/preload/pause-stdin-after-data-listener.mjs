const deadline = Date.now() + 10_000;

const timer = setInterval(() => {
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
