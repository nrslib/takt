import { createHash } from 'node:crypto';
import type { EventInput, WatchObservation } from '../../../core/daemon/events.js';
import type { DaemonIngress } from '../../../core/daemon/ports.js';

export interface WatchRecord {
  episode: number;
  active: boolean;
  input: EventInput | null;
  accepted: boolean;
}

/** B の非同期保存へ接続する。write は原子的・永続的に完了し、read は最後の write を返す。 */
export interface WatchRecordStore {
  read(key: string): Promise<WatchRecord | undefined>;
  write(key: string, record: WatchRecord): Promise<void>;
}

export interface WatchTarget {
  targetId: string;
  generation: string;
  conversationId: string;
}

export function watchKey(target: WatchTarget, kind: WatchObservation['kind']): string {
  return createHash('sha256').update(JSON.stringify([target.conversationId, target.targetId, target.generation, kind])).digest('hex');
}

/** 同じキーへの呼出しは観測ループが直列化する。受付前に入力自体を保存し、応答喪失でも同じ ID を再送する。 */
export class WatchObservations {
  constructor(
    private readonly records: WatchRecordStore,
    private readonly ingress: Pick<DaemonIngress, 'accept'>,
    private readonly now: () => number,
  ) {}

  async normal(target: WatchTarget, kind: WatchObservation['kind']): Promise<void> {
    const key = watchKey(target, kind);
    const record = await this.records.read(key);
    if (record?.active) await this.records.write(key, { episode: record.episode, active: false, input: null, accepted: false });
  }

  async abnormal(target: WatchTarget, observation: WatchObservation): Promise<void> {
    const key = watchKey(target, observation.kind);
    let record = await this.records.read(key);
    if (!record?.active) {
      const episode = record === undefined ? 1 : record.episode + 1;
      const id = `watch-${key}-${episode}`;
      record = { episode, active: true, accepted: false, input: {
        eventId: id, requestId: id, conversationId: target.conversationId, source: 'watcher',
        occurredAt: observation.observedAt, event: { kind: 'watch_observation', observation },
      } };
      await this.records.write(key, record);
    }
    if (record.accepted) return;
    if (record.input === null) throw new Error('Active watch record has no event');
    const admission = await this.ingress.accept(record.input);
    if (admission.kind === 'rejected') throw new Error(`Watch admission rejected: ${admission.reason}`);
    await this.records.write(key, { ...record, accepted: true });
  }

  async changed(target: WatchTarget, observation: Extract<WatchObservation, { kind: 'director_state_changed' }>): Promise<void> {
    const key = createHash('sha256').update(JSON.stringify([target.conversationId, target.targetId, observation.kind])).digest('hex');
    let record = await this.records.read(key);
    const previous = record?.input?.event;
    if (previous?.kind !== 'watch_observation' || previous.observation.generation !== observation.generation) {
      const episode = (record?.episode ?? 0) + 1;
      const id = `watch-${key}-${episode}`;
      record = { episode, active: true, accepted: false, input: {
        eventId: id, requestId: id, conversationId: target.conversationId, source: 'watcher',
        occurredAt: observation.observedAt, event: { kind: 'watch_observation', observation },
      } };
      await this.records.write(key, record);
    }
    if (record === undefined || record.input === null) throw new Error('Missing state change event');
    if (record.accepted) return;
    const admission = await this.ingress.accept(record.input);
    if (admission.kind === 'rejected') throw new Error(`State change admission rejected: ${admission.reason}`);
    await this.records.write(key, { ...record, accepted: true });
  }

  evidence(target: WatchTarget): { targetId: string; generation: string; observedAt: string } {
    return { targetId: target.targetId, generation: target.generation, observedAt: new Date(this.now()).toISOString() };
  }
}
