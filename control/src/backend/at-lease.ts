// The AT-command lease baseline — the ONLY channel raw AT commands may travel.
//
// Three non-negotiable safety properties (draft §rounds 5/6, §84 raw-AT lease):
//   1. ALLOWLIST — only `ATI` (identify) plus the exact commands a certified catalog
//      entry declares may ever be sent. Anything else is rejected BEFORE the sender
//      is touched. There is no escape hatch.
//   2. WATCHDOG — a command that does not return within the timeout fires the
//      `onWatchdog` hook (the transition wires this to force-uninhibit) and rejects,
//      so a hung AT write can never wedge the transaction forever.
//   3. AUDIT + REDACTION — every attempt is recorded through A2.2's `redact` (never a
//      reimplementation), so an identifier that lands in an audit entry's context is
//      stripped before it is stored.

import { type EpochMillis, epochMillis } from '../domain';
import { redact } from '../redact';
import { RUNTIME_COMPOSITION_QUERY_REGISTRY } from '../usb-mode/runtime-capability';

/** Named read-only fence: the exact vendor READ/TEST forms reviewed for runtime discovery. */
export const AT_RUNTIME_QUERY_ALLOWLIST: ReadonlySet<string> = new Set(
	Object.values(RUNTIME_COMPOSITION_QUERY_REGISTRY).flatMap(({ current, enumerate }) => [
		current,
		enumerate,
	]),
);

/** Identify plus reviewed runtime queries. Exact catalog/runtime SET commands union in per use. */
export const AT_BASELINE_ALLOWLIST: ReadonlySet<string> = new Set([
	'ATI',
	...AT_RUNTIME_QUERY_ALLOWLIST,
]);

/** Union the baseline allowlist with a catalog entry's declared transition commands. */
export function computeAtAllowlist(commands: Iterable<string>): ReadonlySet<string> {
	return new Set<string>([...AT_BASELINE_ALLOWLIST, ...commands]);
}

/** An AT command's response. `ok` (an `OK` terminator) is NEVER transition-success alone. */
export interface AtResponse {
	readonly ok: boolean;
	readonly raw: string;
}

/** The raw AT transport — a serial write, injected so tests need no hardware. */
export interface AtCommandSender {
	send(command: string): Promise<AtResponse>;
}

/** One audited AT attempt. Recorded only after passing through `redact`. */
export interface AtAuditEntry {
	readonly command: string;
	readonly outcome: 'sent' | 'rejected' | 'timeout' | 'error';
	readonly at: EpochMillis;
	readonly ok?: boolean;
	readonly reason?: string;
	readonly context?: Record<string, unknown>;
}

/** Where audit entries go — receives a REDACTED copy of each `AtAuditEntry`. */
export interface AtAuditSink {
	record(entry: unknown): void;
}

/** Thrown when a command outside the allowlist is attempted — the sender is never called. */
export class AtCommandNotAllowedError extends Error {
	constructor(command: string) {
		super(`AT command not in allowlist: ${command}`);
		this.name = 'AtCommandNotAllowedError';
		Object.setPrototypeOf(this, AtCommandNotAllowedError.prototype);
	}
}

/** Thrown when a command exceeds the watchdog timeout. */
export class AtCommandTimeoutError extends Error {
	constructor(command: string, timeoutMs: number) {
		super(`AT command timed out after ${timeoutMs}ms: ${command}`);
		this.name = 'AtCommandTimeoutError';
		Object.setPrototypeOf(this, AtCommandTimeoutError.prototype);
	}
}

/** Construction dependencies for an `AtCommandLease`. */
export interface AtCommandLeaseDeps {
	readonly sender: AtCommandSender;
	readonly allowlist: ReadonlySet<string>;
	readonly audit?: AtAuditSink;
	readonly now?: () => EpochMillis;
	readonly timeoutMs?: number;
	/** Fired when a command exceeds the timeout — the transition wires force-uninhibit here. */
	readonly onWatchdog?: (command: string) => void | Promise<void>;
}

const DEFAULT_AT_TIMEOUT_MS = 10_000;

/**
 * A held AT-command lease. `run` enforces the allowlist, bounds the send with a
 * watchdog, and audits every attempt (redacted). The allowlist is fixed at
 * construction from `computeAtAllowlist(entry)`, so a lease can only ever emit the
 * commands one certified SKU permits.
 */
export class AtCommandLease {
	readonly #sender: AtCommandSender;
	readonly #allowlist: ReadonlySet<string>;
	readonly #audit: AtAuditSink | undefined;
	readonly #now: () => EpochMillis;
	readonly #timeoutMs: number;
	readonly #onWatchdog: ((command: string) => void | Promise<void>) | undefined;

	constructor(deps: AtCommandLeaseDeps) {
		this.#sender = deps.sender;
		this.#allowlist = deps.allowlist;
		this.#audit = deps.audit;
		this.#now = deps.now ?? ((): EpochMillis => epochMillis(Date.now()));
		this.#timeoutMs = deps.timeoutMs ?? DEFAULT_AT_TIMEOUT_MS;
		this.#onWatchdog = deps.onWatchdog;
	}

	/** Send one AT command through the lease. `context` is redacted into the audit entry. */
	async run(command: string, context?: Record<string, unknown>): Promise<AtResponse> {
		const ctx = context !== undefined ? { context } : {};
		if (!this.#allowlist.has(command)) {
			this.#record({
				command,
				outcome: 'rejected',
				at: this.#now(),
				reason: 'not in allowlist',
				...ctx,
			});
			throw new AtCommandNotAllowedError(command);
		}
		try {
			const response = await this.#sendWithWatchdog(command);
			this.#record({ command, outcome: 'sent', at: this.#now(), ok: response.ok, ...ctx });
			return response;
		} catch (error) {
			const timedOut = error instanceof AtCommandTimeoutError;
			if (timedOut) {
				await this.#onWatchdog?.(command);
			}
			this.#record({
				command,
				outcome: timedOut ? 'timeout' : 'error',
				at: this.#now(),
				reason: error instanceof Error ? error.message : String(error),
				...ctx,
			});
			throw error;
		}
	}

	async #sendWithWatchdog(command: string): Promise<AtResponse> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const watchdog = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new AtCommandTimeoutError(command, this.#timeoutMs)),
				this.#timeoutMs,
			);
		});
		try {
			return await Promise.race([this.#sender.send(command), watchdog]);
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}

	#record(entry: AtAuditEntry): void {
		this.#audit?.record(redact(entry));
	}
}
