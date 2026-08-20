import {
	createFlockResourceOwnershipPort,
	createModemControlCompositionRoot,
	type MutationAdmissionPort,
} from '../src';

const lockPath = process.argv[2];
if (lockPath === undefined) throw new Error('lock path is required');

const admission: MutationAdmissionPort = {
	acquire: () => Promise.resolve({ status: 'refused', reason: 'admission-refused' }),
};
const root = createModemControlCompositionRoot({
	admission,
	ownership: createFlockResourceOwnershipPort({ lockPath }),
});
const result = await root.acquireOwnership({ resource: 'file-store' });

if (result.status === 'refused') {
	process.stdout.write(
		`${JSON.stringify({
			type: 'refused',
			reason: result.reason,
			...(result.holder !== undefined ? { holderPid: result.holder.pid } : {}),
		})}\n`,
	);
	await root.dispose();
	process.exit(0);
}

process.stdout.write(
	`${JSON.stringify({ type: 'acquired', holderPid: result.lease.holder.pid })}\n`,
);
void result.lease.lost.then(() => {
	process.stdout.write(`${JSON.stringify({ type: 'expired' })}\n`);
});

process.stdin.setEncoding('utf8');
process.stdin.once('data', async () => {
	await root.dispose();
	process.stdout.write(`${JSON.stringify({ type: 'released' })}\n`);
	process.exit(0);
});
process.stdin.resume();
