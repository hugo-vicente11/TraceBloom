/**
 * Vendors the canonical pricing map (pricing/model-prices.json) into both SDKs:
 *
 *   packages/sdk-ts/src/pricing-data.json         (imported at compile time)
 *   packages/sdk-py/src/tracebloom/_pricing.json  (loaded as package data)
 *
 * The copies are byte-identical to the canonical file; each SDK has a unit test
 * asserting exactly that, so a hand-edited (forked) copy fails CI. Run with
 * `pnpm pricing:sync` after editing the canonical file.
 */

import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = join(root, 'pricing', 'model-prices.json');

// Fail loudly on malformed JSON before propagating it anywhere.
const parsed = JSON.parse(readFileSync(canonical, 'utf8'));
if (typeof parsed.models !== 'object' || parsed.models === null) {
  throw new Error('pricing/model-prices.json must have a "models" object');
}
for (const [model, price] of Object.entries(parsed.models)) {
  if (typeof price?.input !== 'number' || typeof price?.output !== 'number') {
    throw new Error(`pricing/model-prices.json: model "${model}" needs numeric input/output`);
  }
}

const targets = [
  join(root, 'packages', 'sdk-ts', 'src', 'pricing-data.json'),
  join(root, 'packages', 'sdk-py', 'src', 'tracebloom', '_pricing.json'),
];

for (const target of targets) {
  copyFileSync(canonical, target);
  console.log(`[sync-pricing] wrote ${target}`);
}
