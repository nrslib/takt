import type { WorkflowEvents } from '../types.js';

type CompanionEventName = Extract<keyof WorkflowEvents, `companion:${string}`>;
type CompanionEventArguments<TEvent extends CompanionEventName> = Parameters<WorkflowEvents[TEvent]>;
export type CompanionEventEmitter = <TEvent extends CompanionEventName>(
  event: TEvent,
  ...args: CompanionEventArguments<TEvent>
) => void;

export class CompanionEventPublisher {
  private completed = false;

  constructor(
    private readonly step: string,
    private readonly emit: CompanionEventEmitter,
  ) {}

  start(companion: string): void {
    this.emit('companion:start', { step: this.step, companion });
  }

  poolSelected(selected: readonly string[], rationale: string): void {
    this.emit('companion:pool_selected', {
      step: this.step,
      selected: [...selected],
      rationale,
    });
  }

  finding(companion: string, findingId: string, severity: 'must_fix' | 'should_fix' | 'nit'): void {
    this.emit('companion:finding', {
      step: this.step,
      companion,
      findingId,
      severity,
    });
  }

  fixRound(sequence: number, openMustFixCount: number): void {
    this.emit('companion:fix_round', { step: this.step, sequence, openMustFixCount });
  }

  complete(openMustFixCount: number, escalated: boolean): void {
    if (this.completed) throw new Error(`Companion completion already published for "${this.step}"`);
    this.completed = true;
    this.emit('companion:complete', { step: this.step, openMustFixCount, escalated });
  }
}
