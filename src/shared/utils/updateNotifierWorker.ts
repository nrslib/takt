import { createRequire } from 'node:module';
// @ts-expect-error -- update-notifier v7.x has no type definitions
import updateNotifier from 'update-notifier';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json') as { name: string; version: string };
const notifier = updateNotifier({ pkg });
notifier.notify();
