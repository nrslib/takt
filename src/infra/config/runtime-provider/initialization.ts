/**
 * First-run generation of the global runtime.yaml (issue #1136).
 *
 * On first run the global `~/.takt/runtime.yaml` is generated. A fresh environment gets an
 * *active* file built from the selected provider/model (`profiles.default` + `defaults.profile`);
 * an existing legacy environment gets only an *inactive* `version: 1` file so behavior does not
 * switch. An existing file is never overwritten, only schema-validated content is written, and
 * the write is atomic (temp file + rename).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { ProviderType } from '../../../shared/types/provider.js';
import { writeFileAtomic } from '../project/sessionStore.js';
import { DEFAULT_PROFILE_NAME, RUNTIME_PROVIDER_VERSION } from './constants.js';
import { RuntimeProviderFileSchema, type RuntimeProviderFile } from './schema.js';

export interface RuntimeProviderSelection {
  provider: ProviderType;
  model: string;
}

export interface GenerateGlobalRuntimeProviderFileInput {
  runtimeFilePath: string;
  selection: RuntimeProviderSelection | undefined;
  hasLegacyProviderConfig: boolean;
}

export function generateGlobalRuntimeProviderFile(
  input: GenerateGlobalRuntimeProviderFileInput,
): void {
  if (existsSync(input.runtimeFilePath)) {
    return;
  }
  const content = buildContent(input);
  const validated = RuntimeProviderFileSchema.parse(content);
  mkdirSync(dirname(input.runtimeFilePath), { recursive: true });
  writeFileAtomic(input.runtimeFilePath, stringifyYaml(validated));
}

function buildContent(input: GenerateGlobalRuntimeProviderFileInput): RuntimeProviderFile {
  if (input.hasLegacyProviderConfig) {
    return { version: RUNTIME_PROVIDER_VERSION };
  }
  if (!input.selection) {
    throw new Error('Cannot generate an active runtime.yaml without a provider/model selection');
  }
  return {
    version: RUNTIME_PROVIDER_VERSION,
    provider: {
      defaults: { profile: DEFAULT_PROFILE_NAME },
      profiles: {
        [DEFAULT_PROFILE_NAME]: {
          provider: input.selection.provider,
          model: input.selection.model,
        },
      },
    },
  };
}
