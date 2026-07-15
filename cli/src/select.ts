// Shared modem selection — pick one observed modem by slot label or path suffix.
//
// Commands that act on a single modem (`apply`, `set-usb-mode`, `unlock-*`) accept an
// optional slot; absent one, they default to the first observed modem. Matching is by
// the stable `logicalSlotId` label or the trailing path segment (`/Modem/<n>`).

import type { CellularSnapshot } from '@ceralive/modem-control';

/** Pick the modem a command targets, or `undefined` when the slot matches nothing. */
export function selectModem(
	rows: readonly CellularSnapshot[],
	slot: string | undefined,
): CellularSnapshot | undefined {
	if (slot === undefined) {
		return rows[0];
	}
	return rows.find(
		(row) =>
			String(row.identity.logicalSlotId) === slot ||
			String(row.identity.runtimePath).endsWith(`/${slot}`),
	);
}
