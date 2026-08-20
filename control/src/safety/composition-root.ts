import { ModemActor, type QuiesceHook } from '../backend/modem-actor';
import type { PhysicalModemId } from '../domain';
import type {
	MutationAdmissionPort,
	ResourceOwnershipLease,
	ResourceOwnershipPort,
	ResourceOwnershipRequest,
	ResourceOwnershipResult,
	UhubctlPort,
} from '../ports';

let compositionRootExists = false;

export class CompositionRootAlreadyExistsError extends Error {
	override readonly name = 'CompositionRootAlreadyExistsError';

	constructor() {
		super('a modem-control composition root already exists in this process');
	}
}

export type ModemControlCompositionRootOptions = {
	readonly admission: MutationAdmissionPort;
	readonly ownership: ResourceOwnershipPort | undefined;
	readonly quiesce?: QuiesceHook;
	readonly uhubctl?: UhubctlPort;
};

export class ModemControlCompositionRoot {
	readonly admission: MutationAdmissionPort;
	readonly ownership: ResourceOwnershipPort;
	readonly uhubctl: UhubctlPort | undefined;
	readonly #quiesce: QuiesceHook | undefined;
	readonly #actors = new Map<PhysicalModemId, ModemActor>();
	readonly #ownershipLeases: ResourceOwnershipLease[] = [];
	#disposed = false;

	constructor(options: ModemControlCompositionRootOptions) {
		if (compositionRootExists) throw new CompositionRootAlreadyExistsError();
		if (options.ownership === undefined) throw new MissingResourceOwnershipPortError();
		compositionRootExists = true;
		this.admission = options.admission;
		this.ownership = options.ownership;
		this.#quiesce = options.quiesce;
		this.uhubctl = options.uhubctl;
	}

	actorFor(modemId: PhysicalModemId): ModemActor {
		const existing = this.#actors.get(modemId);
		if (existing !== undefined) return existing;
		const actor = new ModemActor(this.#quiesce);
		this.#actors.set(modemId, actor);
		return actor;
	}

	async acquireOwnership(request: ResourceOwnershipRequest): Promise<ResourceOwnershipResult> {
		const result = await this.ownership.acquire(request);
		if (result.status === 'acquired') this.#ownershipLeases.push(result.lease);
		return result;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		try {
			for (const lease of this.#ownershipLeases.splice(0).reverse()) {
				await lease.release();
			}
		} finally {
			this.#actors.clear();
			compositionRootExists = false;
		}
	}
}

export class MissingResourceOwnershipPortError extends Error {
	override readonly name = 'MissingResourceOwnershipPortError';

	constructor() {
		super('a ResourceOwnershipPort is required; no pass-through default exists');
	}
}

export function createModemControlCompositionRoot(
	options: ModemControlCompositionRootOptions,
): ModemControlCompositionRoot {
	return new ModemControlCompositionRoot(options);
}
