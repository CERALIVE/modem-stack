import type { AtCommandSender, AtResponse } from '@ceralive/modem-control';
import { CertifyError } from './certify/errors';

export const benchAtSender: AtCommandSender = {
	send(command: string): Promise<AtResponse> {
		return Promise.reject(
			new CertifyError(`no AT serial transport on the bench (hardware-gated): '${command}'`),
		);
	},
};
