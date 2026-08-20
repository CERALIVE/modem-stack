import type { MmLocation } from '../../backend';
import { epochMillis, runtimePath } from '../../domain';
import { resolveFccUnlockCoverage } from '../../fcc';
import { advanceGnssFixState, GNSS_OFF, type GnssFixState } from '../../location';
import { createDbusSmsPort } from '../../sms';
import type { DbusTransport } from '../../transport';
import type { MmUssd } from '../../ussd';
import type { ProviderExecutionContext } from '../contracts';
import type {
	ModemManagerProviderOperations,
	ModemManagerSnapshotResult,
	SmsPortResult,
} from './types';

export interface ModuleOperationsOptions {
	readonly transport: DbusTransport;
	readonly destination: string;
	readonly location: MmLocation;
	readonly ussd: MmUssd;
	readonly now: () => number;
	readSnapshot(context: ProviderExecutionContext): Promise<ModemManagerSnapshotResult>;
}

type ModuleOperationSurface = Pick<
	ModemManagerProviderOperations,
	'location' | 'sms' | 'ussd' | 'initiateUssd' | 'respondUssd' | 'cancelUssd' | 'fccCoverage'
>;

export class ModemManagerModuleOperations {
	readonly operations: ModuleOperationSurface;
	readonly #options: ModuleOperationsOptions;
	readonly #smsPorts = new Map<string, ReturnType<typeof createDbusSmsPort>>();
	readonly #locationStates = new Map<string, GnssFixState>();

	constructor(options: ModuleOperationsOptions) {
		this.#options = options;
		this.operations = {
			location: {
				status: async (context) => {
					const path = await this.#modemPath(context);
					return path === undefined
						? { ok: false, reason: 'modem-not-found' }
						: this.#options.location.getLocationStatus(runtimePath(path));
				},
				enable: async (context, sources) => {
					const path = await this.#modemPath(context);
					if (path === undefined) return this.#unsupportedToggle();
					const result = await this.#options.location.enableGnss(runtimePath(path), sources);
					if (result.outcome === 'applied') {
						this.#setLocationState(context, {
							kind: 'gnss-enabled',
							at: epochMillis(this.#options.now()),
						});
					}
					return result;
				},
				disable: async (context) => {
					const path = await this.#modemPath(context);
					if (path === undefined) return this.#unsupportedToggle();
					const result = await this.#options.location.disableGnss(runtimePath(path));
					if (result.outcome === 'applied')
						this.#setLocationState(context, { kind: 'gnss-disabled' });
					return result;
				},
				readFix: async (context) => {
					const path = await this.#modemPath(context);
					if (path === undefined)
						return { outcome: 'unsupported' as const, reason: 'modem-not-found' };
					const read = await this.#options.location.readFix(runtimePath(path));
					this.#setLocationState(context, {
						kind: 'read',
						at: epochMillis(this.#options.now()),
						read,
					});
					return read;
				},
				state: (context) => this.#locationStates.get(String(context.physicalModemId)) ?? GNSS_OFF,
				tick: (context) =>
					this.#setLocationState(context, {
						kind: 'tick',
						at: epochMillis(this.#options.now()),
					}),
			},
			sms: (context) => this.#sms(context),
			ussd: options.ussd,
			initiateUssd: (context, ussdCommand) =>
				this.#ussd(context, (path) => options.ussd.initiate(runtimePath(path), ussdCommand)),
			respondUssd: (context, ussdResponse) =>
				this.#ussd(context, (path) => options.ussd.respond(runtimePath(path), ussdResponse)),
			cancelUssd: (context) =>
				this.#ussd(context, (path) => options.ussd.cancel(runtimePath(path))),
			fccCoverage: resolveFccUnlockCoverage,
		};
	}

	async stop(): Promise<void> {
		for (const port of this.#smsPorts.values()) await port.stop();
		this.#smsPorts.clear();
		this.#options.ussd.stop();
	}

	async #sms(context: ProviderExecutionContext): Promise<SmsPortResult> {
		const snapshot = await this.#options.readSnapshot(context);
		if (!snapshot.ok) return { ok: false, reason: snapshot.reason };
		if (!snapshot.capabilities.sms) return { ok: false, reason: 'unsupported' };
		let port = this.#smsPorts.get(snapshot.modemPath);
		if (port === undefined) {
			port = createDbusSmsPort({
				transport: this.#options.transport,
				modemPath: snapshot.modemPath,
				destination: this.#options.destination,
			});
			this.#smsPorts.set(snapshot.modemPath, port);
		}
		return { ok: true, port };
	}

	async #ussd(
		context: ProviderExecutionContext,
		run: (path: string) => ReturnType<MmUssd['initiate']>,
	) {
		const path = await this.#modemPath(context);
		return path === undefined
			? {
					ok: false as const,
					snapshot: this.#options.ussd.snapshot(runtimePath('/')),
					refusal: 'unsupported' as const,
				}
			: run(path);
	}

	async #modemPath(context: ProviderExecutionContext): Promise<string | undefined> {
		const snapshot = await this.#options.readSnapshot(context);
		return snapshot.ok ? snapshot.modemPath : undefined;
	}

	#setLocationState(
		context: ProviderExecutionContext,
		event: Parameters<typeof advanceGnssFixState>[1],
	): GnssFixState {
		const key = String(context.physicalModemId);
		const next = advanceGnssFixState(this.#locationStates.get(key) ?? GNSS_OFF, event);
		this.#locationStates.set(key, next);
		return next;
	}

	#unsupportedToggle() {
		return {
			outcome: 'unsupported' as const,
			reason: 'modem-not-found',
			enabledSources: new Set<string>(),
		};
	}
}
