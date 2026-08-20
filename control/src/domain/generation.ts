import type { Brand } from './brand';
import { nonNegativeInteger } from './brand';

/** Monotonic lifetime of one physical enumeration/provider selection. */
export type DeviceGeneration = Brand<number, 'DeviceGeneration'>;

export function deviceGeneration(value: number): DeviceGeneration {
	return nonNegativeInteger(value, 'deviceGeneration') as DeviceGeneration;
}

/** Re-enumeration or provider replacement starts the next fenced lifetime. */
export function nextDeviceGeneration(current: DeviceGeneration): DeviceGeneration {
	return deviceGeneration(current + 1);
}

/** Whether an async completion still belongs to the current device lifetime. */
export function isCurrentGeneration(
	completion: DeviceGeneration,
	current: DeviceGeneration,
): boolean {
	return completion === current;
}
