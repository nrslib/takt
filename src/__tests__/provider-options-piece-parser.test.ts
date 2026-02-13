import { describe, expect, it } from 'vitest';
import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';

describe('normalizePieceConfig provider_options', () => {
  it('piece-level global を movement に継承し、movement 側で上書きできる', () => {
    const raw = {
      name: 'provider-options',
      piece_config: {
        provider_options: {
          codex: { network_access: true },
          opencode: { network_access: false },
        },
      },
      movements: [
        {
          name: 'codex-default',
          provider: 'codex',
          instruction: '{task}',
        },
        {
          name: 'codex-override',
          provider: 'codex',
          provider_options: {
            codex: { network_access: false },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      codex: { networkAccess: true },
      opencode: { networkAccess: false },
    });
    expect(config.movements[0]?.providerOptions).toEqual({
      codex: { networkAccess: true },
      opencode: { networkAccess: false },
    });
    expect(config.movements[1]?.providerOptions).toEqual({
      codex: { networkAccess: false },
      opencode: { networkAccess: false },
    });
  });
});
