// A dedicated private `dbus-daemon` at a FIXED socket path, for the reconnect test.
//
// The outer `dbus-run-session` bus is shared by the whole `bun test` run, so the
// destructive kill/restart cannot happen there. This helper owns a throwaway daemon we
// can kill and respawn at the same socket path, so the transport reconnects to "the same
// bus" exactly as it would after a real bus restart on a device.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PrivateBus {
	readonly socket: string;
	readonly address: string;
	readonly #dir: string;
	#proc: ReturnType<typeof Bun.spawn> | null = null;

	constructor() {
		this.#dir = mkdtempSync(join(tmpdir(), 'ceralive-dbus-'));
		this.socket = join(this.#dir, 'bus');
		this.address = `unix:path=${this.socket}`;
	}

	async start(): Promise<void> {
		// A SIGKILL leaves the socket file behind; dbus-daemon refuses to bind over it.
		if (existsSync(this.socket)) {
			rmSync(this.socket, { force: true });
		}
		this.#proc = Bun.spawn(
			['dbus-daemon', '--session', `--address=${this.address}`, '--nofork', '--nopidfile'],
			{ stdout: 'ignore', stderr: 'ignore' },
		);
		await this.#waitForSocket();
	}

	kill(): void {
		this.#proc?.kill('SIGKILL');
		this.#proc = null;
	}

	async restart(): Promise<void> {
		this.kill();
		await sleep(50);
		await this.start();
	}

	async stop(): Promise<void> {
		this.kill();
		await sleep(20);
		rmSync(this.#dir, { recursive: true, force: true });
	}

	async #waitForSocket(): Promise<void> {
		for (let attempt = 0; attempt < 300; attempt += 1) {
			if (existsSync(this.socket)) {
				// Socket exists → daemon is listening; a short grace covers the accept race.
				await sleep(30);
				return;
			}
			await sleep(10);
		}
		throw new Error(`private dbus-daemon socket ${this.socket} never appeared`);
	}
}
