import type { ModemRef } from '../../ports';
import type { DbusTransport } from '../../transport';
import type { ModemActor } from '../modem-actor';

export interface MmMutationContext {
	readonly transport: DbusTransport;
	readonly actor: ModemActor;
	readonly destination: string;
	readonly resolveStableKey: (modem: ModemRef) => string;
}

export function describeMutationError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
