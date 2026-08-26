import { z } from 'zod';

type JsonSchema<T> = z.ZodType<T>;

export function parseJsonWith<T>(schema: JsonSchema<T>, body: string): T | undefined {
	const parsed = z
		.string()
		.transform((value, context) => {
			try {
				return JSON.parse(value);
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				context.addIssue({ code: 'custom', message: 'invalid JSON' });
				return z.NEVER;
			}
		})
		.pipe(schema)
		.safeParse(body);
	return parsed.success ? parsed.data : undefined;
}
