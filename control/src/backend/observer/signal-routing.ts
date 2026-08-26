import type { SignalEvent } from '../../transport';
import { MM_BUS_NAME } from '../constants';

export type OwnerSignal =
	| { readonly kind: 'unrelated' }
	| { readonly kind: 'lost' }
	| { readonly kind: 'owned'; readonly owner: string };

export function routeOwnerSignal(event: SignalEvent): OwnerSignal {
	if (event.body[0] !== MM_BUS_NAME) {
		return { kind: 'unrelated' };
	}
	const newOwner = typeof event.body[2] === 'string' ? event.body[2] : '';
	return newOwner.length === 0 ? { kind: 'lost' } : { kind: 'owned', owner: newOwner };
}

export function isCurrentOwnerSignal(
	event: SignalEvent,
	currentOwner: string | undefined,
): boolean {
	return currentOwner !== undefined && event.sender === currentOwner;
}
