import type {
	EvidenceStrength,
	MatcherEvidence,
	MatcherScore,
	ProviderDefinition,
	ProviderMatcher,
	ProviderMatchRequest,
	ProviderMatchResult,
} from './contracts';
import type { ProviderRegistry } from './registry';

const STRENGTH_POINTS = {
	none: 0,
	weak: 1,
	moderate: 2,
	strong: 3,
} as const satisfies Record<EvidenceStrength, number>;

type Candidate = {
	readonly provider: ProviderDefinition;
	readonly profile: string;
	points: number;
};

type CacheEntry = {
	readonly signature: string;
	readonly result: ProviderMatchResult;
};

function scoreOf(points: number): MatcherScore {
	if (points <= 0) return 'unsupported';
	if (points === 1) return 'maybe';
	if (points === 2) return 'likely';
	return 'supported';
}

function confidenceOf(points: number): number {
	return Math.min(1, points / 3);
}

function cacheSignature(request: ProviderMatchRequest, registryRevision: number): string {
	return JSON.stringify({
		registryRevision,
		generation: request.generation,
		transport: request.transport,
		passiveFacts: request.passiveFacts,
		composition: request.composition,
		firmware: request.firmware ?? null,
	});
}

function addCandidate(
	candidates: Map<string, Candidate>,
	provider: ProviderDefinition,
	profile: string,
	strength: EvidenceStrength,
): void {
	const key = `${provider.id}\u0000${profile}`;
	const existing = candidates.get(key);
	if (existing === undefined) {
		candidates.set(key, { provider, profile, points: STRENGTH_POINTS[strength] });
		return;
	}
	existing.points += STRENGTH_POINTS[strength];
}

function unresolvedResult(
	status: 'unsupported' | 'ambiguous',
	request: ProviderMatchRequest,
	points: number,
	evidence: readonly MatcherEvidence[],
	conflicts: readonly MatcherEvidence[],
): ProviderMatchResult {
	return {
		status,
		provider: null,
		profile: null,
		score: scoreOf(points),
		confidence: confidenceOf(points),
		evidence,
		conflicts,
		operations: null,
		writable: false,
		generation: request.generation,
		physicalModemId: request.physicalModemId,
	};
}

async function evaluate(
	registry: ProviderRegistry,
	request: ProviderMatchRequest,
): Promise<ProviderMatchResult> {
	const evidence: MatcherEvidence[] = [];
	const conflicts: MatcherEvidence[] = [];
	const candidates = new Map<string, Candidate>();
	const eligible: ProviderDefinition[] = [];

	for (const provider of registry.list()) {
		const transportMatches = provider.eligibleTransports.includes(request.transport);
		evidence.push({
			provider: provider.id,
			profile: null,
			stage: 'transport-eligibility',
			source: request.transport,
			signal: transportMatches ? 'match' : 'mismatch',
			strength: 'none',
			detail: transportMatches ? 'eligible-transport' : 'ineligible-transport',
		});
		if (transportMatches) eligible.push(provider);
	}

	for (const provider of eligible) {
		for (const matcher of provider.passiveMatchers) {
			const actual = request.passiveFacts
				.filter((fact) => fact.kind === matcher.fact)
				.map((fact) => fact.value);
			const signal =
				actual.length === 0
					? 'unknown'
					: actual.some((value) => matcher.expected.includes(value))
						? 'match'
						: 'mismatch';
			const item: MatcherEvidence = {
				provider: provider.id,
				profile: matcher.profiles.length === 1 ? (matcher.profiles[0] ?? null) : null,
				stage: 'passive-facts',
				source: matcher.id,
				signal,
				strength: matcher.strength,
				detail: signal === 'match' ? 'expected-fact-present' : 'expected-fact-not-proven',
			};
			evidence.push(item);
			if (signal === 'mismatch' && matcher.required) conflicts.push(item);
			if (signal === 'match') {
				for (const profile of matcher.profiles) {
					addCandidate(candidates, provider, profile, matcher.strength);
				}
			}
		}
	}

	for (const provider of eligible) {
		for (const probe of provider.unauthenticatedProbes) {
			const result = await probe.run(request);
			const item: MatcherEvidence = {
				provider: provider.id,
				profile: result.profiles.length === 1 ? (result.profiles[0] ?? null) : null,
				stage: 'unauthenticated-fingerprint',
				source: probe.id,
				signal: result.signal,
				strength: result.strength,
				detail: result.detail,
			};
			evidence.push(item);
			if (result.signal === 'mismatch') conflicts.push(item);
			if (result.signal === 'match') {
				for (const profile of result.profiles) {
					addCandidate(candidates, provider, profile, result.strength);
				}
			}
		}
	}

	const ranked = [...candidates.values()].sort((left, right) => right.points - left.points);
	const top = ranked[0];
	if (top === undefined) return unresolvedResult('unsupported', request, 0, evidence, conflicts);
	if (ranked[1]?.points === top.points) {
		return unresolvedResult('ambiguous', request, top.points, evidence, conflicts);
	}

	if (top.provider.authenticatedProfile !== undefined) {
		const auth = await top.provider.authenticatedProfile.authenticate(request, [top.profile]);
		const matched = auth.status === 'matched' && auth.profile === top.profile;
		const item: MatcherEvidence = {
			provider: top.provider.id,
			profile: top.profile,
			stage: 'authenticated-profile',
			source: top.provider.authenticatedProfile.algorithm,
			signal: matched ? 'match' : auth.status === 'unavailable' ? 'unknown' : 'mismatch',
			strength: 'strong',
			detail: auth.detail,
		};
		evidence.push(item);
		if (!matched) {
			conflicts.push(item);
			return unresolvedResult('ambiguous', request, top.points, evidence, conflicts);
		}
		top.points += STRENGTH_POINTS.strong;
	}

	const context = { ...request, profile: top.profile };
	for (const reader of top.provider.capabilityReaders) {
		const result = await reader.read(context);
		const item: MatcherEvidence = {
			provider: top.provider.id,
			profile: top.profile,
			stage: 'capability-read',
			source: reader.id,
			signal: result.signal,
			strength: result.strength,
			detail: result.detail,
		};
		evidence.push(item);
		if (result.signal === 'match') top.points += STRENGTH_POINTS[result.strength];
		if (result.signal === 'mismatch') conflicts.push(item);
	}

	if (scoreOf(top.points) !== 'supported') {
		return unresolvedResult('ambiguous', request, top.points, evidence, conflicts);
	}
	const operations = top.provider.operations(top.profile);
	return {
		status: 'selected',
		provider: top.provider.id,
		profile: top.profile,
		score: 'supported',
		confidence: confidenceOf(top.points),
		evidence,
		conflicts,
		operations,
		writable: operations.access === 'read-write',
		generation: request.generation,
		physicalModemId: request.physicalModemId,
	};
}

class GenerationScopedProviderMatcher implements ProviderMatcher {
	/** Cache mutation is scoped by physical modem, generation, firmware and composition. */
	readonly #cache = new Map<string, CacheEntry>();

	constructor(private readonly registry: ProviderRegistry) {}

	async match(request: ProviderMatchRequest): Promise<ProviderMatchResult> {
		const key = request.physicalModemId;
		const signature = cacheSignature(request, this.registry.revision);
		const cached = this.#cache.get(key);
		if (cached?.signature === signature) return cached.result;

		const result = await evaluate(this.registry, request);
		this.#cache.set(key, { signature, result });
		return result;
	}
}

export function createProviderMatcher(registry: ProviderRegistry): ProviderMatcher {
	return new GenerationScopedProviderMatcher(registry);
}
