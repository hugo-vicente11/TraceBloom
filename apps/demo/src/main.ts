/**
 * Demo CLI.
 *
 *   tracebloom-demo seed [--force] [--skip-hero]   # load the curated demo (idempotent)
 *   tracebloom-demo reset                          # wipe demo data, reseed fresh
 *   tracebloom-demo verify [--timeout <seconds>]   # post-seed assertions (CI smoke)
 */

import { resetDemo, seedDemo } from './seed.js';
import { verifyDemo } from './verify.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'seed';
  switch (command) {
    case 'seed':
      await seedDemo({ force: args.includes('--force'), skipHero: args.includes('--skip-hero') });
      break;
    case 'reset':
      await resetDemo();
      break;
    case 'verify': {
      const timeoutIndex = args.indexOf('--timeout');
      const seconds = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : Number.NaN;
      await verifyDemo({
        regressionTimeoutMs: Number.isFinite(seconds) ? seconds * 1000 : undefined,
      });
      break;
    }
    default:
      console.error(
        `unknown command "${command}". Usage: tracebloom-demo <seed [--force] [--skip-hero] | reset | verify [--timeout <s>]>`,
      );
      process.exit(2);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('[demo] fatal:', error);
    process.exit(1);
  });
