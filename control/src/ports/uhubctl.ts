import type {
	PowerCapability,
	PowerCycleContext,
	PowerCycleResult,
} from '../backend/power-contract';

/** Consumer-supplied USB-hub actuator. This package intentionally ships no implementation. */
export interface UhubctlPort {
	readonly capability: PowerCapability;
	cycle(context: PowerCycleContext): Promise<PowerCycleResult>;
}
