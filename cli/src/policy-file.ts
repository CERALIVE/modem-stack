// Parse + validate an `apply --policy <file>` desired-state file (JSON or YAML).
//
// The file carries the operator's INTENT — the connection / roaming / radio / simSlot
// / recovery / usage desires the reconcile planner consumes. It does NOT carry the
// identity binding key: `apply` derives `boundTo` from the selected modem's live
// identity (refusing an ambiguous one), so a hand-written file never has to encode a
// branded equipment id. Validation is schema-based (zod) so malformed input fails
// visibly with a named path, never silently.

import type {
	DesiredCellularPolicy,
	PolicyBindingKey,
	RadioAccessTechnology,
} from '@ceralive/modem-control';
import { z } from 'zod';

const RAT_VALUES = ['gsm', 'umts', 'lte', '5gnr'] as const;

const authSchema = z
	.object({
		username: z.string().optional(),
		password: z.string().optional(),
	})
	.strict();

const connectionSchema = z
	.object({
		apn: z.string().min(1),
		ipFamily: z.enum(['ipv4', 'ipv6', 'ipv4v6']),
		auth: authSchema.optional(),
		networkId: z.string().optional(),
	})
	.strict();

const radioSchema = z
	.object({
		preferenceOrdered: z.array(z.enum(RAT_VALUES)).min(1),
		allowedSet: z.array(z.enum(RAT_VALUES)).optional(),
	})
	.strict();

/** The validated shape of a policy file. */
export const policyFileSchema = z
	.object({
		/** Optional slot selector (`logicalSlotId` or modem index) — which modem to bind. */
		slot: z.string().optional(),
		enabled: z.boolean(),
		connection: connectionSchema,
		roaming: z.boolean(),
		radio: radioSchema,
		simSlot: z.number().int().positive().optional(),
		recovery: z.object({ enabled: z.boolean() }).strict().optional(),
		usage: z
			.object({
				cycleDay: z.number().int().min(1).max(31).optional(),
				thresholdBytes: z.number().int().nonnegative().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

/** A parsed, validated policy file. */
export type PolicyFileSpec = z.infer<typeof policyFileSchema>;

/** Parse raw policy-file text (JSON or YAML) into a validated spec. */
export function parsePolicyText(text: string, path: string): PolicyFileSpec {
	const raw =
		path.endsWith('.yaml') || path.endsWith('.yml') ? Bun.YAML.parse(text) : JSON.parse(text);
	const result = policyFileSchema.safeParse(raw);
	if (!result.success) {
		const issue = result.error.issues[0];
		const where = issue?.path.join('.') || '(root)';
		throw new Error(
			`invalid policy file ${path}: ${where}: ${issue?.message ?? 'schema mismatch'}`,
		);
	}
	return result.data;
}

/** Read + parse a policy file from disk. */
export async function readPolicyFile(path: string): Promise<PolicyFileSpec> {
	const text = await Bun.file(path).text();
	return parsePolicyText(text, path);
}

/** Rebuild auth omitting absent optional fields (exactOptionalPropertyTypes-safe). */
function toAuth(auth: NonNullable<PolicyFileSpec['connection']['auth']>): {
	username?: string;
	password?: string;
} {
	return {
		...(auth.username !== undefined ? { username: auth.username } : {}),
		...(auth.password !== undefined ? { password: auth.password } : {}),
	};
}

/** Build the full `DesiredCellularPolicy` from a file spec bound to one modem. */
export function toDesiredPolicy(
	spec: PolicyFileSpec,
	boundTo: PolicyBindingKey,
): DesiredCellularPolicy {
	const allowed = spec.radio.allowedSet;
	return {
		boundTo,
		enabled: spec.enabled,
		connection: {
			apn: spec.connection.apn,
			ipFamily: spec.connection.ipFamily,
			...(spec.connection.auth !== undefined ? { auth: toAuth(spec.connection.auth) } : {}),
			...(spec.connection.networkId !== undefined ? { networkId: spec.connection.networkId } : {}),
		},
		roaming: spec.roaming,
		radio: {
			preferenceOrdered: spec.radio.preferenceOrdered as readonly RadioAccessTechnology[],
			...(allowed !== undefined
				? { allowedSet: new Set<RadioAccessTechnology>(allowed as RadioAccessTechnology[]) }
				: {}),
		},
		...(spec.simSlot !== undefined ? { simSlot: spec.simSlot } : {}),
		recovery: { enabled: spec.recovery?.enabled ?? false },
		usage: {
			...(spec.usage?.cycleDay !== undefined ? { cycleDay: spec.usage.cycleDay } : {}),
			...(spec.usage?.thresholdBytes !== undefined
				? { thresholdBytes: spec.usage.thresholdBytes }
				: {}),
		},
	};
}
