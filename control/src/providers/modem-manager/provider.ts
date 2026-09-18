import {
	createMmDbusBackend,
	fetchManagedObjects,
	MM_BUS_NAME,
	type MmDbusBackend,
	MmLocation,
	ModemActor,
	type QuiesceHook,
} from '../../backend';
import {
	BAND_CERTIFICATION_CATALOG,
	type BandCertificationCatalog,
	type BandCertificationEntry,
	type BandSku,
	findBandCertification,
} from '../../band';
import {
	epochMillis,
	type ObservationEnvelope,
	sourceEpoch,
	stableKeyFromPhysicalModemId,
} from '../../domain';
import { type NormalizedModemObservation, unavailableObservation } from '../../observations';
import type { ObservationListener } from '../../ports';
import type { DbusTransport } from '../../transport';
import { MmUssd } from '../../ussd';
import type {
	ProviderDefinition,
	ProviderExecutionContext,
	ProviderMatchRequest,
} from '../contracts';
import { mapModemManagerError } from './errors';
import { createGenericOperations } from './generic-operations';
import { ModemManagerModuleOperations } from './module-operations';
import type { RuntimeCompositionOperationDeps } from './runtime-composition-operation';
import { buildModemManagerSnapshot } from './snapshot';
import type {
	ModemManagerProviderLifecycle,
	ModemManagerProviderOperations,
	ModemManagerSnapshotResult,
} from './types';

const PROFILE = 'generic-mm';

export interface ModemManagerProviderOptions {
	readonly transport: DbusTransport;
	readonly destination?: string;
	readonly quiesce?: QuiesceHook;
	readonly now?: () => number;
	/**
	 * `Signal.Setup` reporting rate in whole seconds, defaulting to
	 * `DEFAULT_SIGNAL_INTERVAL_SECONDS` (5).
	 *
	 * The backend has accepted this since it was written; the provider had no way to pass
	 * it, so an embedder constructing a provider — which is every embedder — was pinned to
	 * the default with no seam to change it. That is the gap this closes, and it is why
	 * the option is threaded rather than re-implemented here.
	 */
	readonly signalIntervalSeconds?: number;
	/**
	 * The band-lock certification catalog. Defaults to the one shipped in this package,
	 * which is EMPTY — so a band write is refused on every device until a human-reviewed
	 * commit adds an entry carrying its bench transcript.
	 */
	readonly bandCertificationCatalog?: BandCertificationCatalog;
	/**
	 * The device's SKU, if the embedding process can resolve one.
	 *
	 * ModemManager's `Modem` interface carries `Model` and `Revision` but NO USB
	 * `vid:pid`, and `BandSku` is keyed on all three — so this package structurally
	 * cannot build one from the bus alone, and a partial match would certify a family
	 * no reviewer looked at. With no resolver injected there is no SKU, hence no entry,
	 * hence no band write: fail-closed, which is this module's whole stance.
	 */
	readonly bandSku?: (context: ProviderExecutionContext) => BandSku | undefined;
	readonly runtimeComposition?: RuntimeCompositionOperationDeps;
}

export class ModemManagerProvider implements ModemManagerProviderLifecycle {
	readonly definition: ProviderDefinition<
		NormalizedModemObservation,
		ModemManagerProviderOperations
	>;
	readonly #transport: DbusTransport;
	readonly #destination: string;
	readonly #now: () => number;
	readonly #backend: MmDbusBackend;
	readonly #bandCatalog: BandCertificationCatalog;
	readonly #bandSku: (context: ProviderExecutionContext) => BandSku | undefined;
	readonly #stableKeyByPath = new Map<string, string>();
	readonly #moduleOperations: ModemManagerModuleOperations;
	#startPromise: ReturnType<MmDbusBackend['start']> | undefined;
	#epoch = 1;

	constructor(options: ModemManagerProviderOptions) {
		this.#transport = options.transport;
		this.#destination = options.destination ?? MM_BUS_NAME;
		this.#now = options.now ?? Date.now;
		this.#bandCatalog = options.bandCertificationCatalog ?? BAND_CERTIFICATION_CATALOG;
		this.#bandSku = options.bandSku ?? (() => undefined);
		const actor = new ModemActor(options.quiesce);
		const resolveStableKey = (modem: string): string => this.#stableKeyByPath.get(modem) ?? modem;
		this.#backend = createMmDbusBackend({
			transport: this.#transport,
			destination: this.#destination,
			actor,
			now: this.#now,
			...(options.signalIntervalSeconds === undefined
				? {}
				: { signalIntervalSeconds: options.signalIntervalSeconds }),
		});
		const location = new MmLocation({
			transport: this.#transport,
			actor,
			destination: this.#destination,
			resolveStableKey,
			now: this.#now,
		});
		const ussd = new MmUssd({
			transport: this.#transport,
			actor,
			destination: this.#destination,
			resolveStableKey,
		});
		this.#moduleOperations = new ModemManagerModuleOperations({
			transport: this.#transport,
			destination: this.#destination,
			location,
			ussd,
			now: this.#now,
			readSnapshot: (context) => this.readSnapshot(context),
		});
		const operations: ModemManagerProviderOperations = {
			access: 'read-write',
			...createGenericOperations({
				backend: this.#backend,
				readSnapshot: (context) => this.readSnapshot(context),
				...(options.runtimeComposition === undefined
					? {}
					: { runtimeComposition: options.runtimeComposition }),
			}),
			...this.#moduleOperations.operations,
		};
		this.definition = {
			id: 'modemmanager',
			profileVersion: '1',
			eligibleTransports: ['modemmanager'],
			passiveMatchers: [],
			unauthenticatedProbes: [
				{ id: 'object-manager-modem', run: (request) => this.#probe(request) },
			],
			capabilityReaders: [
				{ id: 'runtime-modem-interface', read: (context) => this.#capability(context) },
			],
			observe: (context) => this.#observeNormalized(context),
			operations: () => operations,
			contractFixtures: [],
		};
	}

	start(): ReturnType<MmDbusBackend['start']> {
		this.#startPromise ??= this.#backend.start();
		return this.#startPromise;
	}

	observe(listener: ObservationListener): () => void {
		return this.#backend.observe(listener);
	}

	async stop(): Promise<void> {
		await this.#moduleOperations.stop();
		await this.#backend.stop();
	}

	async readSnapshot(context: ProviderExecutionContext): Promise<ModemManagerSnapshotResult> {
		try {
			await this.start();
			const tree = await fetchManagedObjects(this.#transport, this.#destination);
			const snapshot = buildModemManagerSnapshot(
				tree,
				context,
				this.#now,
				this.#epoch,
				this.#bandCertification(context),
			);
			if (snapshot === undefined) return { ok: false, reason: 'not-found' };
			this.#stableKeyByPath.set(snapshot.modemPath, `modem:${context.physicalModemId}`);
			return { ok: true, ...snapshot };
		} catch (error) {
			return { ok: false, reason: mapModemManagerError(error).reason };
		}
	}

	#bandCertification(context: ProviderExecutionContext): BandCertificationEntry | undefined {
		const sku = this.#bandSku(context);
		return sku === undefined ? undefined : findBandCertification(this.#bandCatalog, sku);
	}

	async #probe(request: ProviderMatchRequest) {
		const snapshot = await this.readSnapshot({ ...request, profile: PROFILE });
		return {
			signal: snapshot.ok
				? ('match' as const)
				: snapshot.reason === 'not-found'
					? ('mismatch' as const)
					: ('unknown' as const),
			strength: 'strong' as const,
			profiles: [PROFILE],
			detail: snapshot.ok ? 'runtime-modem-interface-present' : snapshot.reason,
		};
	}

	async #capability(context: ProviderExecutionContext) {
		const snapshot = await this.readSnapshot(context);
		return {
			signal: snapshot.ok
				? ('match' as const)
				: snapshot.reason === 'not-found'
					? ('mismatch' as const)
					: ('unknown' as const),
			strength: 'strong' as const,
			detail: snapshot.ok ? 'generic-controls-derived-from-runtime-properties' : snapshot.reason,
		};
	}

	async #observeNormalized(
		context: ProviderExecutionContext,
	): Promise<readonly ObservationEnvelope<NormalizedModemObservation>[]> {
		const snapshot = await this.readSnapshot(context);
		if (snapshot.ok) return [snapshot.observation];
		return [
			unavailableObservation<NormalizedModemObservation>(
				'modemmanager',
				{
					stableKey: stableKeyFromPhysicalModemId(context.physicalModemId),
					generation: context.generation,
					sourceEpoch: sourceEpoch(this.#epoch),
					observedAt: epochMillis(this.#now()),
				},
				snapshot.reason === 'not-found' ? 'device-absent' : 'provider-unavailable',
			),
		];
	}
}

export function createModemManagerProvider(
	options: ModemManagerProviderOptions,
): ModemManagerProvider {
	return new ModemManagerProvider(options);
}
