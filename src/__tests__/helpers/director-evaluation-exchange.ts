import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod/v4';

const decisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool'), name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal('final'), text: z.string() }).strict(),
]);
export type DirectorEvaluationDecision = z.infer<typeof decisionSchema>;

export async function createDirectorEvaluationExchange(parent: string) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'run-'));
  let sequence = 0;
  return {
    directory,
    async request(payload: Record<string, unknown>, signal: AbortSignal) {
      const id = String(++sequence).padStart(4, '0');
      const input = { ...payload, id };
      const inputPath = join(directory, `${id}.input.json`);
      const responsePath = join(directory, `${id}.response.json`);
      await writeFile(inputPath, JSON.stringify(input, null, 2));
      console.log(JSON.stringify({ evaluationInput: id, inputPath, responsePath, evaluationDirectory: directory }));
      const deadline = Date.now() + 240_000;
      while (true) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new Error('Current AI evaluation response timed out');
        let raw: string;
        try { raw = await readFile(responsePath, 'utf8'); }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          await delay(25, undefined, { signal });
          continue;
        }
        signal.throwIfAborted();
        return { input, decision: decisionSchema.parse(JSON.parse(raw)) };
      }
    },
  };
}
