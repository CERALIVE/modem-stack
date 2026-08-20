#!/usr/bin/env bun
/**
 * CLI: pack `@ceralive/modem-control` and assert the published artifact's shape.
 *
 * Exits non-zero with every violation named. Run it directly (`bun run
 * scripts/assert-tarball-shape.ts`); `scripts/tarball-shape.test.ts` drives the same
 * rules from `bun test`.
 */
import { packTarball } from './pack-tarball';
import { allViolations } from './tarball-shape';

const packed = await packTarball();
const violations = await allViolations(packed.shape);

console.log(`tarball: ${packed.tarball}`);
console.log(`entries: ${packed.listing.length}`);

if (violations.length > 0) {
	console.error(`\n${violations.length} shape violation(s):`);
	for (const violation of violations) {
		console.error(`  - ${violation}`);
	}
	process.exit(1);
}

console.log('tarball shape OK — built ESM + declarations, no raw source, no service artifact');
