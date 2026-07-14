import { expect, test } from 'bun:test';
import { banner } from './index';

test('cli banner names the control package', () => {
	expect(banner()).toContain('@ceralive/modem-control');
});
