import { beforeEach, afterEach, expect } from 'vitest';

const realSetInterval = globalThis.setInterval;
const realHrtime = process.hrtime.bigint.bind(process.hrtime);
const realWrite = process.stderr.write.bind(process.stderr);
const state = globalThis as { __lagDiag?: boolean; __lagTest?: string };
if (!state.__lagDiag) {
  state.__lagDiag = true;
  let last = realHrtime();
  const timer = realSetInterval(() => {
    const now = realHrtime();
    const gapMs = Number(now - last) / 1e6 - 1000;
    if (gapMs > 5000) realWrite(`[LAGDIAG] ${Math.round(gapMs)}ms during ${state.__lagTest ?? '(none)'}\n`);
    last = now;
  }, 1000);
  timer.unref();
}
beforeEach(() => { state.__lagTest = `${expect.getState().testPath} > ${expect.getState().currentTestName}`; });
afterEach(() => { state.__lagTest = `after ${expect.getState().testPath} > ${expect.getState().currentTestName}`; });
