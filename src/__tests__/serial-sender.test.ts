import { expect, it } from 'vitest';
import { SerialSender } from '../shared/utils/serialSender.js';

function fixture() {
  const written: string[] = [];
  const completions: Array<(error: Error | null) => void> = [];
  const sender = new SerialSender<string>((message, done) => { written.push(message); completions.push(done); });
  return { sender, written, completions };
}

it('writes the next message only after the previous write has completed', async () => {
  const f = fixture();
  const first = f.sender.send('first');
  const second = f.sender.send('second');
  expect(f.written).toEqual(['first']);
  f.completions[0]!(null);
  await first;
  expect(f.written).toEqual(['first', 'second']);
  f.completions[1]!(null);
  await expect(second).resolves.toBeUndefined();
});

it('fails only the sender whose write failed and continues with the next message', async () => {
  const f = fixture();
  const failed = f.sender.send('failed');
  const next = f.sender.send('next');
  const error = new Error('write failed');
  f.completions[0]!(error);
  await expect(failed).rejects.toBe(error);
  expect(f.written).toEqual(['failed', 'next']);
  f.completions[1]!(null);
  await expect(next).resolves.toBeUndefined();
});

it('releases the in-flight and waiting senders when closed and refuses later messages', async () => {
  const f = fixture();
  const inFlight = f.sender.send('in-flight');
  const waiting = f.sender.send('waiting');
  const error = new Error('disconnected');
  f.sender.close(error);
  await expect(inFlight).rejects.toBe(error);
  await expect(waiting).rejects.toBe(error);
  await expect(f.sender.send('later')).rejects.toBe(error);
  f.completions[0]!(null);
  expect(f.written).toEqual(['in-flight']);
});
