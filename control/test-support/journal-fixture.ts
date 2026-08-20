import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	defineOperationDescriptor,
	deviceGeneration,
	type OperationDescriptor,
	type OperationResult,
	physicalModemId,
} from '../src/domain';
import { createJournalEngine, type JournalEngine } from '../src/journal/engine';
import type { JournalEntry } from '../src/journal/entry';
import { createFileJournalStore } from '../src/journal/store';
import type { OperationJournalEvent } from '../src/operations/contracts';

export const JOURNAL_MODEM_A = physicalModemId('serial:journal-a');
export const JOURNAL_MODEM_B = physicalModemId('serial:journal-b');
export const JOURNAL_GENERATION = deviceGeneration(7);

export function journalDescriptor(
	overrides: Partial<OperationDescriptor<string, string>> = {},
): OperationDescriptor<string, string> {
	return defineOperationDescriptor({
		id: 'set-usb-mode',
		support: { read: { supported: true }, write: { supported: true } },
		authority: 'provider',
		provider: 'fixture-provider',
		constraints: { kind: 'unconstrained' },
		livePreconditions: ['device-present'],
		availability: { state: 'available' },
		mutationImpact: 'write',
		retryClass: 'never',
		readback: { required: false },
		rollback: { required: false },
		journal: { required: true, reason: 'stranded writes must survive a restart' },
		admission: { required: false },
		evidence: { profiles: ['fixture'], firmware: ['1.0'] },
		confidence: 'high',
		...overrides,
	});
}

export function startedEvent(
	operationId: string,
	overrides: Partial<Extract<OperationJournalEvent<string, string>, { phase: 'started' }>> = {},
): OperationJournalEvent<string, string> {
	return {
		phase: 'started',
		operationId,
		physicalModemId: JOURNAL_MODEM_A,
		generation: JOURNAL_GENERATION,
		descriptor: journalDescriptor(),
		input: 'lte',
		...overrides,
	};
}

export function completedEvent(
	operationId: string,
	result: OperationResult<string>,
	overrides: Partial<Extract<OperationJournalEvent<string, string>, { phase: 'completed' }>> = {},
): OperationJournalEvent<string, string> {
	return {
		phase: 'completed',
		operationId,
		physicalModemId: JOURNAL_MODEM_A,
		generation: JOURNAL_GENERATION,
		descriptor: journalDescriptor(),
		result,
		...overrides,
	};
}

export function appliedResult(value = 'lte'): OperationResult<string> {
	return {
		status: 'applied',
		value,
		generation: JOURNAL_GENERATION,
		requiresReconciliation: false,
	};
}

export function unknownOutcomeResult(
	reason: 'stale-generation' | 'write-reply-timed-out' | 'write-reply-dropped',
): OperationResult<string> {
	return {
		status: 'unknown-outcome',
		reason,
		generation: JOURNAL_GENERATION,
		requiresReconciliation: true,
	};
}

export function failedResult(reason: string): OperationResult<string> {
	return {
		status: 'failed',
		reason,
		generation: JOURNAL_GENERATION,
		requiresReconciliation: false,
	};
}

export function journalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
	return {
		schemaVersion: 1,
		phase: 'started',
		operationId: 'op-1',
		physicalModemId: JOURNAL_MODEM_A as string,
		generation: JOURNAL_GENERATION as number,
		recordedAtMs: 1_000,
		descriptor: {
			descriptorId: 'set-usb-mode',
			provider: 'fixture-provider',
			authority: 'provider',
			mutationImpact: 'write',
			profiles: ['fixture'],
			firmware: ['1.0'],
			confidence: 'high',
		},
		...overrides,
	} as JournalEntry;
}

export interface JournalHarness {
	readonly dir: string;
	readonly path: string;
	/** A fresh engine over the SAME path — the "restart" in a replay test. */
	restart(): JournalEngine;
	dispose(): Promise<void>;
}

export async function createJournalHarness(fileName = 'operations.jsonl'): Promise<JournalHarness> {
	const dir = await mkdtemp(join(tmpdir(), 'modem-journal-'));
	const path = join(dir, fileName);
	let tick = 0;
	return {
		dir,
		path,
		restart(): JournalEngine {
			return createJournalEngine({
				store: createFileJournalStore({ path }),
				now: () => 1_000 + ++tick,
			});
		},
		dispose: () => rm(dir, { recursive: true, force: true }),
	};
}
