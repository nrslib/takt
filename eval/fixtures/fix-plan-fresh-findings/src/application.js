import { consumerA } from './consumer-a.js';
import { consumerB } from './consumer-b.js';
import { consumerC } from './consumer-c.js';
import { capture, restore } from './state-transfer.js';
import { viewA } from './view-a.js';
import { viewB } from './view-b.js';

export async function inspectCache(primary, secondary, key, equivalentKeys) {
  const image = capture(primary, equivalentKeys);
  restore(secondary, image);

  return {
    eventual: await consumerA(primary, key, 2),
    tiered: consumerB(primary, secondary, key),
    batch: await consumerC(primary, equivalentKeys),
    restored: secondary.get(key),
    text: viewA(primary, key),
    record: viewB(primary, key),
  };
}
