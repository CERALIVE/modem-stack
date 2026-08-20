// Qualcomm UFI / HIMI transport shape.
//
// HIMI is not a REST surface: every call is `POST /himiapi/json` and the VERB lives in
// the JSON body's `cmdid`. So "read-only" cannot be expressed here as an HTTP-method
// restriction the way it can for HiLink. The command vocabulary is frozen as a union
// instead — a request this transport can carry names a member of `UFI_COMMANDS`, and no
// `set*` / flash / reset member exists — which makes a write UNREPRESENTABLE rather than
// merely refused at runtime.

/** The seven read commands the HIMI firmware answers. Bench-observed, not inferred. */
export const UFI_READ_COMMANDS = [
	'getoverview',
	'getsysinfo',
	'getallstatus',
	'getapninfo',
	'getnetworkmode',
	'gethimiusbtether',
	'getproduceinfo',
] as const;
export type UfiReadCommand = (typeof UFI_READ_COMMANDS)[number];

/**
 * The ONE non-read command. It opens a server-side session and changes nothing on the
 * device; the modem's configuration, radio and storage are untouched by it.
 */
export const UFI_SESSION_COMMANDS = ['login'] as const;
export type UfiSessionCommand = (typeof UFI_SESSION_COMMANDS)[number];

export const UFI_COMMANDS = [...UFI_READ_COMMANDS, ...UFI_SESSION_COMMANDS] as const;
export type UfiCommand = UfiReadCommand | UfiSessionCommand;

export const UFI_API_PATH = '/himiapi/json';

export type UfiHttpRequest = {
	readonly method: 'POST';
	readonly url: string;
	/** Frozen vocabulary: the field a write would have to travel in cannot name one. */
	readonly command: UfiCommand;
	readonly body: string;
	readonly headers: readonly string[];
	readonly interfaceName: string;
	readonly redirect: 'error';
};

export type UfiHttpResponse = {
	readonly status: number;
	readonly body: string;
};

export interface UfiTransport {
	request(request: UfiHttpRequest): Promise<UfiHttpResponse>;
}
