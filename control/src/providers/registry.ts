import { DomainError } from '../domain';
import type { ProviderDefinition, ProviderOperationsSurface } from './contracts';

export class ProviderRegistryError extends DomainError {
	override readonly name = 'ProviderRegistryError';

	constructor(readonly reason: 'duplicate-provider' | 'empty-profile-version') {
		super(`provider registration refused: ${reason}`);
	}
}

export interface ProviderRegistry {
	readonly revision: number;
	register<TObservation, TOperations extends ProviderOperationsSurface>(
		definition: ProviderDefinition<TObservation, TOperations>,
	): void;
	list(): readonly ProviderDefinition[];
}

class InMemoryProviderRegistry implements ProviderRegistry {
	/** Startup registration is the registry's documented mutation boundary. */
	readonly #definitions: ProviderDefinition[] = [];
	#revision = 0;

	get revision(): number {
		return this.#revision;
	}

	register<TObservation, TOperations extends ProviderOperationsSurface>(
		definition: ProviderDefinition<TObservation, TOperations>,
	): void {
		if (this.#definitions.some((candidate) => candidate.id === definition.id)) {
			throw new ProviderRegistryError('duplicate-provider');
		}
		if (definition.profileVersion.trim().length === 0) {
			throw new ProviderRegistryError('empty-profile-version');
		}
		this.#definitions.push(definition);
		this.#revision += 1;
	}

	list(): readonly ProviderDefinition[] {
		return [...this.#definitions];
	}
}

export function createProviderRegistry(): ProviderRegistry {
	return new InMemoryProviderRegistry();
}
