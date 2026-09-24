import { resolveSetting } from './settings.js';
import { createClient } from './sdk-adapter.js';

export function readSetting(value) {
  return resolveSetting(value, 'default');
}

export function buildClient(setting, transport) {
  return createClient({ setting: readSetting(setting) }, transport);
}
