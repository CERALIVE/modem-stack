// Data-usage sampler — internal all-interface sampler over `/proc/net/dev`
// CUMULATIVE counters (A4.3). Public surface consumed by the A6.1 bench CLI `usage`
// command (via `UsageSnapshot`) and the composition root that wires the sampler.

export {
	applySample,
	type BaselineKey,
	baselineKey,
	initialAccount,
	type SampleInput,
	type SlotAccount,
} from './accounting';
export { clampCycleDay, cycleStart, daysInMonth } from './billing-cycle';
export { readBootId } from './boot-id';
export {
	type CounterSource,
	parseProcNetDev,
	procNetDevCounterSource,
} from './proc-net-dev';
export {
	createUsageSampler,
	type SlotUsageSnapshot,
	type UsageObservation,
	UsageSampler,
	type UsageSamplerOptions,
	type UsageSnapshot,
} from './sampler';
export {
	createUsageFileStore,
	type PersistedSlot,
	type PersistedUsage,
	USAGE_SCHEMA_VERSION,
	type UsageFileStoreOptions,
	type UsageLogEvent,
	type UsageLogger,
	type UsageStore,
} from './store';
