// Reading the kernel boot id — the usage sampler's session identity.
//
// `/proc/sys/kernel/random/boot_id` is a per-boot random UUID string. It changes on
// every reboot, which is exactly when interface byte counters reset to zero, so the
// sampler keys its baselines on it and re-baselines when it changes.

/**
 * Read the current kernel boot id (a UUID string). The path is injectable for tests;
 * the default is the live `/proc` file. A read failure yields an empty string so the
 * sampler still starts (baselines then simply never match a persisted session).
 */
export async function readBootId(path = '/proc/sys/kernel/random/boot_id'): Promise<string> {
	try {
		return (await Bun.file(path).text()).trim();
	} catch {
		return '';
	}
}
