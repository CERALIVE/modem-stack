export type ZteHttpRequest = {
	readonly method: 'GET' | 'POST';
	readonly url: string;
	readonly body?: string;
	readonly headers: readonly string[];
	readonly interfaceName: string;
	readonly redirect: 'error';
};

export type ZteHttpResponse = {
	readonly status: number;
	readonly body: string;
	readonly headers?: Readonly<Record<string, string>>;
};

export interface ZteTransport {
	request(request: ZteHttpRequest): Promise<ZteHttpResponse>;
}
