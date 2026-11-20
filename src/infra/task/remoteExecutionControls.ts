import { join } from 'node:path';
import { z } from 'zod/v4';
import { RemoteControlSchema, type RemoteControl } from '../../core/worker-pool/remoteExecutionProtocol.js';
import { readPrivateFile, writePrivateFile } from '../daemon/privateFile.js';

const stateSchema = z.object({ acknowledgedSequence: z.number().int().nonnegative(),
  controls: z.array(RemoteControlSchema) }).strict();

export class RemoteExecutionControls {
  constructor(private readonly directory: string) {}

  async poll(acknowledgedSequence: number, candidates: readonly Omit<RemoteControl, 'sequence'>[]): Promise<RemoteControl[]> {
    const path = join(this.directory, 'controls.json');
    const bytes = await readPrivateFile(path, 4 * 1024 * 1024);
    const state = bytes === undefined ? { acknowledgedSequence: 0, controls: [] }
      : stateSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (!Number.isSafeInteger(acknowledgedSequence) || acknowledgedSequence < 0
      || acknowledgedSequence > state.controls.length) throw new Error('Invalid remote control acknowledgement');
    for (const candidate of candidates) {
      const previous = state.controls.find((control) => control.kind === candidate.kind && control.instructionId === candidate.instructionId);
      if (previous !== undefined) {
        if (previous.kind === 'tell' && (previous.content !== candidate.content || previous.issuedAt !== candidate.issuedAt)) throw new Error('Remote instruction changed after being saved');
        continue;
      }
      state.controls.push(RemoteControlSchema.parse({ ...candidate, sequence: state.controls.length + 1 }));
    }
    state.acknowledgedSequence = Math.max(state.acknowledgedSequence, acknowledgedSequence);
    const encoded = JSON.stringify(state);
    if (Buffer.byteLength(encoded, 'utf8') > 4 * 1024 * 1024) throw new Error('Remote control journal exceeds its capacity');
    await writePrivateFile(path, encoded);
    return state.controls.filter((control) => control.sequence > acknowledgedSequence).slice(0, 16);
  }
}
