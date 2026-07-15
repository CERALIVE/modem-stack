#!/usr/bin/env bun
// modem-control — bench CLI entry point.
//
// The command surface (probe / watch / apply / set-usb-mode / usage / unlock-pin /
// unlock-puk) lives under `./commands`, dispatched by `runCli` in `./cli`. This entry
// point wires the production stdio and runs the requested command, exiting with its code.

import { PACKAGE_NAME } from '@ceralive/modem-control';
import { runCli } from './cli';
import { stdioIo } from './io';

export function banner(): string {
	return `modem-control (bench CLI) — backed by ${PACKAGE_NAME}`;
}

if (import.meta.main) {
	const code = await runCli(process.argv.slice(2), stdioIo());
	process.exit(code);
}
