// COMPILE-TIME negative tests for port-tagged op disjointness.
//
// This file is type-checked by `tsc --noEmit` (it is inside the workspace
// `include`) but is NOT a runtime test — it is never imported and every binding is
// a type assertion. Each `@ts-expect-error` asserts the type system REJECTS a
// mis-tagged op; if disjointness ever regresses (e.g. an `NmOp` gains a radio
// `kind`), the directive becomes UNUSED and `tsc` fails the build. That failure IS
// the ownership matrix enforced at the type level.

import { connectionId, deviceIfname } from './network-manager';
import type { MmOp, NmOp, PortTaggedOp } from './ops';

const radioOp: MmOp = { kind: 'setRadioModes', preference: { preferenceOrdered: ['5gnr'] } };
const slotOp: MmOp = { kind: 'setPrimarySimSlot', slotIndex: 2 };
const activateOp: NmOp = {
	kind: 'activate',
	connectionId: connectionId('11111111-1111-1111-1111-111111111111'),
	deviceIfname: deviceIfname('wwan0'),
};

// Positive controls — correctly-tagged ops MUST type-check.
const goodMm: PortTaggedOp = { port: 'mm', op: radioOp };
const goodNm: PortTaggedOp = { port: 'nm', op: activateOp };

// @ts-expect-error a radio op tagged for the NM port must NOT compile.
const badRadioOnNm: PortTaggedOp = { port: 'nm', op: radioOp };
// @ts-expect-error a SIM op tagged for the NM port must NOT compile.
const badSlotOnNm: PortTaggedOp = { port: 'nm', op: slotOp };
// @ts-expect-error an activate op tagged for the MM port must NOT compile.
const badActivateOnMm: PortTaggedOp = { port: 'mm', op: activateOp };

// Exported so the bindings are "used" and lint stays quiet; never imported at runtime.
export const PORT_TAGGED_OP_TYPE_CASES: readonly PortTaggedOp[] = [
	goodMm,
	goodNm,
	badRadioOnNm,
	badSlotOnNm,
	badActivateOnMm,
];
