// A STATEFUL `nmcli` stub: a test double that actually remembers what it was told.
//
// Unlike a mock that returns canned strings, this runs a tiny state machine over the
// real `nmcli` argv grammar and keeps profiles + active-device state, so a `connection
// show` after a `connection add`/`modify` reflects exactly what was written — real
// readback, the way A4.1's `NmcliNmPort` will assert its nine-field GSM writes. It is
// NOT the shipping adapter; it is the harness A4.1 injects in place of a live nmcli.
//
// Property keys are stored verbatim (dotted `gsm.apn`, `connection.autoconnect`, …), so
// every field a caller writes round-trips — the stub imposes no field whitelist.

export interface NmcliResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

interface Profile {
	readonly uuid: string;
	readonly settings: Map<string, string>;
}

const ok = (stdout: string): NmcliResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string): NmcliResult => ({ stdout: '', stderr, exitCode: 10 });

// nmcli shorthands used on `add`/`modify`, mapped to their canonical dotted keys.
const KEY_ALIASES: Readonly<Record<string, string>> = {
	type: 'connection.type',
	'con-name': 'connection.id',
	ifname: 'connection.interface-name',
	autoconnect: 'connection.autoconnect',
};

const canonicalKey = (key: string): string => KEY_ALIASES[key] ?? key;

let uuidCounter = 0;
const nextUuid = (): string => {
	uuidCounter += 1;
	return `fake-uuid-${uuidCounter.toString().padStart(4, '0')}`;
};

export class StatefulNmcliRunner {
	readonly #profiles = new Map<string, Profile>();
	readonly #active = new Map<string, string>(); // ifname -> uuid
	readonly #calls: string[][] = [];

	/** Every argv the runner has seen, in order — for call-order / spy assertions. */
	get calls(): readonly (readonly string[])[] {
		return this.#calls;
	}

	run(argv: readonly string[]): NmcliResult {
		this.#calls.push([...argv]);
		const { terse, fields, rest } = parseGlobals(argv);
		const object = rest[0];
		const command = rest[1];
		const args = rest.slice(2);
		if (object === 'connection' || object === 'c') {
			return this.#connection(command, args, terse, fields);
		}
		if (object === 'device' || object === 'd') {
			return this.#device(command, args);
		}
		return fail(`fake nmcli: unsupported object '${object ?? ''}'`);
	}

	#connection(
		command: string | undefined,
		args: readonly string[],
		terse: boolean,
		fields: readonly string[] | undefined,
	): NmcliResult {
		switch (command) {
			case 'add':
				return this.#add(args);
			case 'modify':
			case 'mod':
				return this.#modify(args);
			case 'delete':
			case 'del':
				return this.#delete(args);
			case 'up':
				return this.#up(args);
			case 'down':
				return this.#down(args);
			case 'show':
				return this.#show(args, terse, fields);
			default:
				return fail(`fake nmcli: unsupported connection command '${command ?? ''}'`);
		}
	}

	#device(command: string | undefined, args: readonly string[]): NmcliResult {
		if (command === 'disconnect') {
			const ifname = args[0];
			if (ifname === undefined) {
				return fail('fake nmcli: device disconnect requires an ifname');
			}
			this.#active.delete(ifname);
			return ok(`Device '${ifname}' successfully disconnected.`);
		}
		return fail(`fake nmcli: unsupported device command '${command ?? ''}'`);
	}

	#add(args: readonly string[]): NmcliResult {
		const settings = new Map<string, string>();
		applyPairs(settings, args);
		const name = settings.get('connection.id') ?? 'unnamed';
		const uuid = nextUuid();
		this.#profiles.set(uuid, { uuid, settings });
		return ok(`Connection '${name}' (${uuid}) successfully added.`);
	}

	#modify(args: readonly string[]): NmcliResult {
		const profile = this.#resolve(args[0]);
		if (profile === undefined) {
			return fail(`fake nmcli: unknown connection '${args[0] ?? ''}'`);
		}
		applyPairs(profile.settings, args.slice(1));
		return ok('');
	}

	#delete(args: readonly string[]): NmcliResult {
		const profile = this.#resolve(args[0]);
		if (profile === undefined) {
			return fail(`fake nmcli: unknown connection '${args[0] ?? ''}'`);
		}
		this.#profiles.delete(profile.uuid);
		for (const [ifname, uuid] of this.#active) {
			if (uuid === profile.uuid) {
				this.#active.delete(ifname);
			}
		}
		return ok(`Connection '${profile.uuid}' successfully deleted.`);
	}

	#up(args: readonly string[]): NmcliResult {
		const profile = this.#resolve(args[0]);
		if (profile === undefined) {
			return fail(`fake nmcli: unknown connection '${args[0] ?? ''}'`);
		}
		const ifname = valueAfter(args, 'ifname');
		if (ifname === undefined) {
			return fail('fake nmcli: connection up requires `ifname <dev>`');
		}
		this.#active.set(ifname, profile.uuid);
		return ok(`Connection successfully activated (D-Bus active path: /fake/${profile.uuid})`);
	}

	#down(args: readonly string[]): NmcliResult {
		const profile = this.#resolve(args[0]);
		if (profile === undefined) {
			return fail(`fake nmcli: unknown connection '${args[0] ?? ''}'`);
		}
		for (const [ifname, uuid] of this.#active) {
			if (uuid === profile.uuid) {
				this.#active.delete(ifname);
			}
		}
		return ok('Connection successfully deactivated');
	}

	#show(
		args: readonly string[],
		terse: boolean,
		fields: readonly string[] | undefined,
	): NmcliResult {
		const activeOnly = args.includes('--active');
		const id = args.find((arg) => arg !== '--active');
		if (id !== undefined) {
			const profile = this.#resolve(id);
			if (profile === undefined) {
				return fail(`fake nmcli: unknown connection '${id}'`);
			}
			return ok(this.#dumpProfile(profile, terse, fields));
		}
		const rows = [...this.#profiles.values()].filter(
			(profile) => !activeOnly || this.#ifnameFor(profile.uuid) !== undefined,
		);
		const cols = fields ?? ['NAME', 'UUID', 'TYPE', 'DEVICE'];
		const lines = rows.map((profile) =>
			cols.map((field) => this.#fieldValue(profile, field)).join(terse ? ':' : '  '),
		);
		return ok(lines.join('\n'));
	}

	#dumpProfile(profile: Profile, terse: boolean, fields: readonly string[] | undefined): string {
		const keys = fields ?? [...profile.settings.keys()];
		const sep = terse ? ':' : ' : ';
		return keys.map((key) => `${key}${sep}${this.#fieldValue(profile, key)}`).join('\n');
	}

	#fieldValue(profile: Profile, field: string): string {
		switch (field) {
			case 'NAME':
				return profile.settings.get('connection.id') ?? '';
			case 'UUID':
				return profile.uuid;
			case 'TYPE':
				return profile.settings.get('connection.type') ?? '';
			case 'DEVICE':
				return this.#ifnameFor(profile.uuid) ?? '';
			default:
				return profile.settings.get(field) ?? '';
		}
	}

	#ifnameFor(uuid: string): string | undefined {
		for (const [ifname, activeUuid] of this.#active) {
			if (activeUuid === uuid) {
				return ifname;
			}
		}
		return undefined;
	}

	#resolve(idOrUuid: string | undefined): Profile | undefined {
		if (idOrUuid === undefined) {
			return undefined;
		}
		const byUuid = this.#profiles.get(idOrUuid);
		if (byUuid !== undefined) {
			return byUuid;
		}
		return [...this.#profiles.values()].find(
			(profile) => profile.settings.get('connection.id') === idOrUuid,
		);
	}
}

function parseGlobals(argv: readonly string[]): {
	terse: boolean;
	fields: readonly string[] | undefined;
	rest: readonly string[];
} {
	let terse = false;
	let fields: readonly string[] | undefined;
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === '-t' || token === '--terse') {
			terse = true;
		} else if (
			token === '-f' ||
			token === '--fields' ||
			token === '-g' ||
			token === '--get-values'
		) {
			if (token === '-g' || token === '--get-values') {
				terse = true;
			}
			const value = argv[i + 1];
			fields = value ? value.split(',') : [];
			i += 1;
		} else {
			rest.push(token as string);
		}
	}
	return { terse, fields, rest };
}

function applyPairs(settings: Map<string, string>, args: readonly string[]): void {
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i];
		if (key === undefined) {
			break;
		}
		settings.set(canonicalKey(key), args[i + 1] ?? '');
	}
}

function valueAfter(args: readonly string[], token: string): string | undefined {
	const index = args.indexOf(token);
	return index >= 0 ? args[index + 1] : undefined;
}
