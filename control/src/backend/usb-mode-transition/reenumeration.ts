import type { UsbDeviceSnapshot } from '../device-classifier';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ReenumerationWaiter {
	readonly #enumerate: () => Promise<readonly UsbDeviceSnapshot[]>;
	readonly #timeoutMs: number;
	readonly #pollMs: number;

	constructor(
		enumerate: () => Promise<readonly UsbDeviceSnapshot[]>,
		timeoutMs: number,
		pollMs: number,
	) {
		this.#enumerate = enumerate;
		this.#timeoutMs = timeoutMs;
		this.#pollMs = pollMs;
	}

	async awaitPortDrop(uid: string): Promise<void> {
		const deadline = Date.now() + this.#timeoutMs;
		while (Date.now() < deadline) {
			const devices = await this.#enumerate();
			if (!devices.some((device) => device.physicalUid === uid)) {
				return;
			}
			await sleep(this.#pollMs);
		}
		throw new Error(`control port did not drop within ${this.#timeoutMs}ms (uid ${uid})`);
	}

	async awaitDevice(uid: string): Promise<UsbDeviceSnapshot> {
		const deadline = Date.now() + this.#timeoutMs;
		while (Date.now() < deadline) {
			const devices = await this.#enumerate();
			const device = devices.find((candidate) => candidate.physicalUid === uid);
			if (device !== undefined) {
				return device;
			}
			await sleep(this.#pollMs);
		}
		throw new Error(`device did not re-enumerate within ${this.#timeoutMs}ms (uid ${uid})`);
	}

	async reprobe(): Promise<void> {
		await this.#enumerate().then(
			() => undefined,
			() => undefined,
		);
	}
}
