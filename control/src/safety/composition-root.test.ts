import { describe, expect, test } from 'bun:test';
import { physicalModemId } from '../domain';
import type { MutationAdmissionPort, ResourceOwnershipPort } from '../ports';
import {
	CompositionRootAlreadyExistsError,
	createModemControlCompositionRoot,
	MissingResourceOwnershipPortError,
} from './composition-root';

const admission: MutationAdmissionPort = {
	acquire: () => Promise.resolve({ status: 'refused', reason: 'admission-refused' }),
};
const ownership: ResourceOwnershipPort = {
	acquire: () => Promise.resolve({ status: 'refused', reason: 'already-owned' }),
};

describe('modem control composition root', () => {
	test('Given no ownership port, When a root is constructed, Then construction fails hard', () => {
		expect(() => createModemControlCompositionRoot({ admission, ownership: undefined })).toThrow(
			MissingResourceOwnershipPortError,
		);
	});

	test('Given one live root, When a second root is constructed, Then construction throws', async () => {
		const first = createModemControlCompositionRoot({ admission, ownership });
		try {
			expect(() => createModemControlCompositionRoot({ admission, ownership })).toThrow(
				CompositionRootAlreadyExistsError,
			);
		} finally {
			await first.dispose();
		}
	});

	test('Given callers ask for the same physical modem, When they obtain an actor, Then the root shares one actor', async () => {
		const root = createModemControlCompositionRoot({ admission, ownership });
		try {
			const modem = physicalModemId('serial:shared-actor');
			expect(root.actorFor(modem)).toBe(root.actorFor(modem));
		} finally {
			await root.dispose();
		}
	});
});
