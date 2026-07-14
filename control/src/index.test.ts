import { expect, test } from 'bun:test';
import { PACKAGE_NAME } from './index';

test('control package exposes its name', () => {
	expect(PACKAGE_NAME).toBe('@ceralive/modem-control');
});
