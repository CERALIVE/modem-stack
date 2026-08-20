import { z } from 'zod';
import type { ProviderMatchRequest } from '../contracts';
import {
	UFI_API_PATH,
	type UfiCommand,
	type UfiHttpResponse,
	type UfiReadCommand,
	type UfiTransport,
} from './transport';

export type UfiCredentials = { readonly username: string; readonly password: string };

export type UfiOptions = {
	readonly interfaceName: string;
	readonly adminUrl: string;
	readonly transport: UfiTransport;
	/** Ephemeral bench input. Injected by the caller, never persisted, never logged. */
	readonly credentials: UfiCredentials;
	readonly now?: () => number;
};

/** The HIMI firmware's own word for "your session is gone". */
export const UFI_SESSION_REFUSAL = 'SessionOut';

const flatRecordSchema = z.record(z.string(), z.union([z.string(), z.number()]));
const ufiReplySchema = z.object({
	reply: z.string(),
	session: z.string().optional(),
	params: flatRecordSchema.optional(),
});

export type UfiReply = z.infer<typeof ufiReplySchema>;

export function parseUfiReply(body: string): UfiReply | undefined {
	const parsed = z
		.string()
		.transform((value, context) => {
			try {
				return JSON.parse(value);
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				context.addIssue({ code: 'custom', message: 'invalid JSON' });
				return z.NEVER;
			}
		})
		.pipe(ufiReplySchema)
		.safeParse(body);
	return parsed.success ? parsed.data : undefined;
}

/**
 * Session acquisition, bounded to ONE login per physical modem per generation.
 *
 * The bound is a set of spent keys rather than a counter reset on failure: a HIMI
 * device that refused a credential refuses it again, and a provider that re-tries on
 * every poll turns a wrong password into a lockout nobody asked for. A refused or
 * expired session therefore surfaces as an honest auth-expired READING; the next
 * enumeration (a new generation) gets the next single attempt.
 */
export class UfiSessionRuntime {
	readonly #sessions = new Map<string, string>();
	readonly #spent = new Set<string>();

	constructor(protected readonly options: UfiOptions) {}

	protected async session(request: ProviderMatchRequest): Promise<string | undefined> {
		const key = this.sessionKey(request);
		const held = this.#sessions.get(key);
		if (held !== undefined) return held;
		if (this.#spent.has(key)) return undefined;
		this.#spent.add(key);

		const response = await this.request(
			'login',
			JSON.stringify({
				cmdid: 'login',
				username: this.options.credentials.username,
				password: this.options.credentials.password,
			}),
		);
		const reply = response.status === 200 ? parseUfiReply(response.body) : undefined;
		const session = reply?.reply === 'ok' ? reply.session : undefined;
		if (session === undefined || session === '') return undefined;
		this.#sessions.set(key, session);
		return session;
	}

	protected read(command: UfiReadCommand, session: string): Promise<UfiHttpResponse> {
		return this.request(command, JSON.stringify({ cmdid: command, sessionId: session }), session);
	}

	/** A refused session is dropped so the NEXT generation may spend its own attempt. */
	protected forgetSession(request: ProviderMatchRequest): void {
		this.#sessions.delete(this.sessionKey(request));
	}

	protected sessionKey(request: ProviderMatchRequest): string {
		return `${request.physicalModemId}:${request.generation}`;
	}

	protected observedAt(): number {
		return this.options.now?.() ?? Date.now();
	}

	private request(command: UfiCommand, body: string, session?: string): Promise<UfiHttpResponse> {
		return this.options.transport.request({
			method: 'POST',
			url: `${this.options.adminUrl}${UFI_API_PATH}`,
			command,
			body,
			headers: [
				...(session === undefined ? [] : [`Authorization: ${session}`]),
				'Content-Type: application/json;charset=UTF-8',
			],
			interfaceName: this.options.interfaceName,
			redirect: 'error',
		});
	}
}
