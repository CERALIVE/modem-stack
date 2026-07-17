// Method-call dispatch and reply correlation for the D-Bus transport seam.
//
// A call marshals its body through the codec, registers a pending record so a bus drop can
// reject it, and installs a per-call reply callback guarded by a `done` flag — so a reply
// that arrives after the call already timed out or the connection dropped is silently
// ignored rather than mis-correlated onto a stale promise. `rejectAll` mass-rejects every
// in-flight call when the connection drops.

import { decodeBody, encodeBody } from './codec';
import { messageType, type RawBus, type RawMessage, type ReplyContext } from './dbus-native';
import { DisconnectedError, TransportError } from './errors';
import type { DbusValue, MethodCall, MethodReply } from './types';

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

interface PendingCall {
	settle(): void;
	reject(error: unknown): void;
}

export class CallDispatcher {
	readonly #pending = new Set<PendingCall>();
	readonly #callTimeoutMs: number;

	constructor(callTimeoutMs: number) {
		this.#callTimeoutMs = callTimeoutMs;
	}

	async call(bus: RawBus | null, connected: boolean, call: MethodCall): Promise<MethodReply> {
		if (!connected || bus === null) {
			throw new DisconnectedError('cannot call method: transport not connected');
		}

		const signature = call.signature ?? '';
		const args = call.args ?? [];
		const message: RawMessage = {
			type: messageType.methodCall,
			destination: call.destination,
			path: call.path,
			interface: call.interface,
			member: call.member,
		};
		if (signature.length > 0) {
			// Throws UnsupportedSignatureError / BigIntRequiredError before anything hits
			// the wire.
			message.signature = signature;
			message.body = encodeBody(signature, args);
		}

		const timeoutMs = call.timeoutMs ?? this.#callTimeoutMs;
		const pendingSet = this.#pending;
		return new Promise<MethodReply>((resolve, reject) => {
			let done = false;
			const pending: PendingCall = {
				settle: finish,
				reject: (error) => {
					finish();
					reject(error);
				},
			};

			function finish(): void {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				pendingSet.delete(pending);
			}

			const timer = setTimeout(() => {
				finish();
				reject(
					new TransportError(
						`Method call ${call.interface}.${call.member} timed out after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);

			pendingSet.add(pending);

			bus.invoke(
				message,
				function reply(this: ReplyContext, error: unknown, ...body: unknown[]): void {
					if (done) {
						// Reply arrived after timeout/disconnect already settled the promise — ignore.
						return;
					}
					finish();
					if (error) {
						reject(error instanceof Error ? error : new TransportError(String(error)));
						return;
					}
					try {
						const replySignature = this.signature ?? '';
						const decoded: DbusValue[] =
							replySignature.length > 0 ? decodeBody(replySignature, body) : [];
						resolve({ signature: replySignature, body: decoded });
					} catch (decodeError) {
						reject(decodeError);
					}
				},
			);
		});
	}

	rejectAll(cause: unknown): void {
		for (const pending of this.#pending) {
			pending.reject(cause);
		}
		this.#pending.clear();
	}
}
