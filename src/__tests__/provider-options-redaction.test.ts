import { describe, expect, it } from 'vitest';
import { redactProviderOptions } from '../core/workflow/providerOptionsRedaction.js';

describe('provider option redaction', () => {
  it('redacts credentials embedded in Pi extension URLs', () => {
    const originalExtensions = [
      'https://user:secret@example.com/pi-extension.git',
      'https://example.com/pi-extension.git?token=secret&ref=main',
      'https://example.com/pi-extension.git?access_token=access-secret&auth_token=auth-secret&client_secret=client-secret',
      'https://example.com/pi-extension.git?api%5Fkey=encoded-secret',
      'https://example.com/pi-extension.git?token=secret value&ref=main',
      '  https://spaced:secret@example.com/pi-extension.git  ',
      'git+ssh://git@example.com/pi-extension.git',
      'npm:pi-fff',
    ];
    const options = {
      pi: {
        extensions: [...originalExtensions],
      },
    };

    expect(redactProviderOptions(options)).toEqual({
      pi: {
        extensions: [
          'https://[configured]@example.com/pi-extension.git',
          'https://example.com/pi-extension.git?token=[configured]&ref=main',
          'https://example.com/pi-extension.git?access_token=[configured]&auth_token=[configured]&client_secret=[configured]',
          'https://example.com/pi-extension.git?api%5Fkey=[configured]',
          'https://example.com/pi-extension.git?token=[configured]&ref=main',
          'https://[configured]@example.com/pi-extension.git',
          'git+ssh://[configured]@example.com/pi-extension.git',
          'npm:pi-fff',
        ],
      },
    });
    expect(options.pi.extensions).toEqual(originalExtensions);
  });
});
