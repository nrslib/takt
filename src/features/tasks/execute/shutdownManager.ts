import { blankLine, warn, error } from '../../../shared/ui/index.js';
import { getLabel } from '../../../shared/i18n/index.js';

export interface ShutdownCallbacks {
  onGraceful: () => void;
  onForceKill: () => void;
}

export interface ShutdownManagerOptions {
  callbacks: ShutdownCallbacks;
  gracefulTimeoutMs?: number;
}

type ShutdownState = 'idle' | 'graceful' | 'forcing';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const NON_INTERACTIVE_SHUTDOWN_TIMEOUT_MS = 5_000;

function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('TAKT_SHUTDOWN_TIMEOUT_MS must be a positive integer');
  }

  return value;
}

function resolveShutdownTimeoutMs(): number {
  const configuredTimeout = parseTimeoutMs(process.env.TAKT_SHUTDOWN_TIMEOUT_MS);
  if (configuredTimeout !== undefined) {
    return configuredTimeout;
  }
  if (process.env.TAKT_NO_TTY === '1') {
    return NON_INTERACTIVE_SHUTDOWN_TIMEOUT_MS;
  }
  return DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

export class ShutdownManager {
  private readonly callbacks: ShutdownCallbacks;
  private readonly gracefulTimeoutMs: number;
  private state: ShutdownState = 'idle';
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private readonly sigintHandler: () => void;

  constructor(options: ShutdownManagerOptions) {
    this.callbacks = options.callbacks;
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? resolveShutdownTimeoutMs();
    this.sigintHandler = () => this.handleSigint();
  }

  install(): void {
    process.on('SIGINT', this.sigintHandler);
  }

  cleanup(): void {
    process.removeListener('SIGINT', this.sigintHandler);
    this.clearTimeout();
  }

  private handleSigint(): void {
    if (this.state === 'idle') {
      this.beginGracefulShutdown();
      return;
    }

    if (this.state === 'graceful') {
      this.forceShutdown();
    }
  }

  private beginGracefulShutdown(): void {
    this.state = 'graceful';

    blankLine();
    warn(getLabel('workflow.sigintGraceful'));
    this.callbacks.onGraceful();

    this.timeoutId = setTimeout(() => {
      this.timeoutId = undefined;
      if (this.state !== 'graceful') {
        return;
      }

      blankLine();
      error(getLabel('workflow.sigintTimeout', undefined, {
        timeoutMs: String(this.gracefulTimeoutMs),
      }));
      this.forceShutdown();
    }, this.gracefulTimeoutMs);
  }

  private forceShutdown(): void {
    if (this.state === 'forcing') {
      return;
    }

    this.state = 'forcing';
    this.clearTimeout();

    blankLine();
    error(getLabel('workflow.sigintForce'));
    this.callbacks.onForceKill();
  }

  private clearTimeout(): void {
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }
}
