// D-Bus signature parsing and support checks.
//
// We keep our own tiny recursive-descent parser rather than reaching into the
// underlying library's internal `lib/signature.js`: the parsed tree drives our
// signature-aware encode/decode (below) and the tree shape is part of this seam's
// contract, not the library's. The node shape intentionally mirrors the library's
// (`{ type, child }`) so a tree the library hands us inside a decoded variant can be
// re-serialised with `signatureFromNode` without a translation step.

import { UnsupportedSignatureError } from './errors';

export interface SignatureNode {
	readonly type: string;
	readonly child: readonly SignatureNode[];
}

const CONTAINER_CLOSE: Record<string, string> = {
	'{': '}',
	'(': ')',
};

// Every basic and container type char D-Bus defines. `h` (UNIX_FD) is deliberately
// listed as *known* so the parser accepts it structurally — we reject it explicitly in
// `assertSupportedSignature` with a typed error rather than as a vague parse failure.
const KNOWN_TYPES = new Set('ybnqiuxtdsogarvhe{}()'.split(''));

// UNIX_FD: file-descriptor passing. Unsupported everywhere in this transport.
const UNSUPPORTED_TYPE = 'h';

// Throws UnsupportedSignatureError if the signature contains `h` anywhere (including
// nested inside arrays, structs, dict entries, or variants). Signatures are pure type
// strings, so a plain character scan is exact.
export function assertSupportedSignature(signature: string): void {
	const index = signature.indexOf(UNSUPPORTED_TYPE);
	if (index !== -1) {
		throw new UnsupportedSignatureError(signature, UNSUPPORTED_TYPE);
	}
}

// Parse a full signature (which may contain several top-level complete types) into a
// flat list of nodes.
export function parseSignature(signature: string): SignatureNode[] {
	let index = 0;

	function next(): string | null {
		if (index < signature.length) {
			const char = signature[index] as string;
			index += 1;
			return char;
		}
		return null;
	}

	function parseOne(char: string): SignatureNode {
		if (!KNOWN_TYPES.has(char)) {
			throw new Error(`Unknown D-Bus type "${char}" in signature "${signature}"`);
		}

		const children: SignatureNode[] = [];
		switch (char) {
			case 'a': {
				const element = next();
				if (element === null) {
					throw new Error(`Bad signature "${signature}": array with no element type`);
				}
				children.push(parseOne(element));
				return { type: 'a', child: children };
			}
			case '{':
			case '(': {
				const close = CONTAINER_CLOSE[char];
				let element = next();
				while (element !== null && element !== close) {
					children.push(parseOne(element));
					element = next();
				}
				if (element === null) {
					throw new Error(`Bad signature "${signature}": unterminated "${char}"`);
				}
				return { type: char, child: children };
			}
			default:
				return { type: char, child: children };
		}
	}

	const nodes: SignatureNode[] = [];
	let char = next();
	while (char !== null) {
		nodes.push(parseOne(char));
		char = next();
	}
	return nodes;
}

// Re-serialise a single parsed node back to its signature string. Used to recover the
// inner signature of a decoded variant, whose contained type the library hands us as a
// parse tree rather than a string.
export function signatureFromNode(node: SignatureNode): string {
	switch (node.type) {
		case 'a':
			return `a${signatureFromNode(node.child[0] as SignatureNode)}`;
		case '(':
			return `(${node.child.map(signatureFromNode).join('')})`;
		case '{':
			return `{${node.child.map(signatureFromNode).join('')}}`;
		default:
			return node.type;
	}
}
