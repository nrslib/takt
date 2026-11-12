import '../environment.js';
import { BuiltinProjectRuntime } from '../../features/workerPool/builtinProjectRuntime.js';
import { ProjectRequestSchema, type ProjectReply } from '../../core/worker-pool/projectProtocol.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { getErrorMessage } from '../../shared/utils/error.js';

if (process.send === undefined) throw new Error('Builtin worker requires Node IPC');
const send = (reply: ProjectReply): void => {
  if (process.connected) process.send!(reply, (error: Error | null) => { if (error !== null) void stop(); });
};
const runtime = new BuiltinProjectRuntime(process.cwd(), (taskName) => send({ kind: 'finished', taskName }),
  () => { process.exitCode = 1; void stop(); });
let closing: Promise<void> | undefined;
const stop = (): Promise<void> => closing ??= runtime.close().catch((error: unknown) => {
  process.stderr.write(`${sanitizeSensitiveText(getErrorMessage(error))}\n`);
  process.exitCode = 1;
}).finally(() => { if (process.connected) process.disconnect(); });
process.on('message', (value: unknown) => {
  void (async () => {
    const request = ProjectRequestSchema.parse(value);
    try {
      switch (request.kind) {
        case 'inspect': {
          const result = await runtime.inspect();
          send('kind' in result ? { ...result, id: request.id } : { kind: 'snapshot', id: request.id, work: result });
          break;
        }
        case 'waiting': send({ ...await runtime.setWaitingReasons(request.reasons), id: request.id }); break;
        case 'start': send({ kind: 'started', id: request.id, result: await runtime.start(request.taskName, request.workerName) }); break;
        case 'shutdown': await stop(); break;
      }
    } catch (error) { send({ kind: 'error', id: request.id, message: sanitizeSensitiveText(getErrorMessage(error)) }); }
  })().catch(() => { process.exitCode = 1; void stop(); });
});
process.on('disconnect', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
