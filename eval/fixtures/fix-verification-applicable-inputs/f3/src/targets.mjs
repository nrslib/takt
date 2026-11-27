import { displayName } from './shared/display-name.mjs';

export function targetRows(config) {
  return config.targets.map(name => displayName(name));
}
