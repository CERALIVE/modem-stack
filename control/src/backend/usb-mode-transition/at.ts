import type { InhibitLease, ModemManagerPort } from '../../ports';
import {
	type AtAuditSink,
	AtCommandLease,
	type AtCommandSender,
	computeAtAllowlist,
} from '../at-lease';
import { releaseInhibit } from './admission';

export interface TransitionAtLeaseOptions {
	readonly sender: AtCommandSender;
	readonly allowlistedCommands: readonly string[];
	readonly timeoutMs: number;
	readonly modemManager: Pick<ModemManagerPort, 'uninhibit'>;
	readonly currentInhibit: () => InhibitLease | undefined;
	readonly clearInhibit: () => void;
	readonly steps: string[];
	readonly audit?: AtAuditSink;
}

export function createTransitionAtLease(options: TransitionAtLeaseOptions): AtCommandLease {
	return new AtCommandLease({
		sender: options.sender,
		allowlist: computeAtAllowlist(options.allowlistedCommands),
		timeoutMs: options.timeoutMs,
		onWatchdog: async () => {
			const held = options.currentInhibit();
			options.clearInhibit();
			await releaseInhibit(options.modemManager, held, options.steps);
		},
		...(options.audit !== undefined ? { audit: options.audit } : {}),
	});
}
