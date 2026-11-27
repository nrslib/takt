import { join } from 'node:path';
import { z } from 'zod/v4';
import type { RemoteControl } from '../../core/worker-pool/remoteExecutionProtocol.js';
import { readPrivateFile, writePrivateFile } from '../daemon/privateFile.js';

export class RemoteControlReceiver {
  constructor(private readonly directory: string) {}

  async apply(control: RemoteControl, apply: (control: RemoteControl) => Promise<void>): Promise<number> {
    const sequencePath = join(this.directory, 'control-sequence.json');
    const bytes = await readPrivateFile(sequencePath, 256);
    const acknowledged = bytes === undefined ? 0 : z.number().int().nonnegative().safe().parse(JSON.parse(bytes.toString('utf8')) as unknown);
    const journalPath = join(this.directory, 'applied-controls', `${control.sequence}.json`);
    const journal = await readPrivateFile(journalPath, 1024 * 1024);
    const encoded = JSON.stringify(control);
    if (journal !== undefined && journal.toString('utf8') !== encoded) throw new Error('Remote control sequence has different content');
    if (control.sequence <= acknowledged) {
      if (journal === undefined) throw new Error('Applied remote control journal is missing');
      return acknowledged;
    }
    if (control.sequence !== acknowledged + 1) throw new Error('Remote control sequence contains a gap');
    if (journal === undefined) {
      await apply(control);
      await writePrivateFile(journalPath, encoded);
    }
    await writePrivateFile(sequencePath, JSON.stringify(control.sequence));
    return control.sequence;
  }
}
