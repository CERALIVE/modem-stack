// `modem-control usage` — print the data-usage sampler snapshot.
//
// Takes one sampling pass over the per-interface cumulative counters for the supplied
// per-slot observations, then prints the queryable `UsageSnapshot` (A4.3). `cycleBytes`
// is CUMULATIVE-COUNTER-DERIVED per-cycle usage — never a rate — and `thresholdExceeded`
// is advisory only. A `flush()` bounds unpersisted loss on exit.

import type { UsageObservation, UsageSampler } from '@ceralive/modem-control';
import type { CliIo } from '../io';

/** Sample once and print the usage snapshot. Returns a process exit code. */
export async function runUsage(
	io: CliIo,
	sampler: UsageSampler,
	observations: readonly UsageObservation[],
): Promise<number> {
	await sampler.sample(observations);
	const snapshot = sampler.snapshot();
	io.out(`usage: bootId=${snapshot.bootId} slots=${snapshot.slots.length}`);
	for (const slot of snapshot.slots) {
		const threshold =
			slot.thresholdBytes !== undefined
				? ` threshold=${slot.thresholdBytes} exceeded=${slot.thresholdExceeded}`
				: '';
		io.out(
			`  ${slot.logicalSlotId}: cycleBytes=${slot.cycleBytes} cycleStart=${slot.cycleStartMs} paused=${slot.paused}${threshold}`,
		);
	}
	await sampler.flush();
	return 0;
}
