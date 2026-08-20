export type HilinkHttpRequest = {
	readonly method: 'GET' | 'POST';
	readonly url: string;
	readonly body?: string;
	readonly headers: readonly string[];
	readonly interfaceName: string;
	readonly redirect: 'error';
};
export type HilinkHttpResponse = {
	readonly status: number;
	readonly body: string;
	readonly headers?: Readonly<Record<string, string>>;
};
export interface HilinkTransport {
	request(request: HilinkHttpRequest): Promise<HilinkHttpResponse>;
}
export type HilinkReplayExchange = HilinkHttpRequest & { readonly response: HilinkHttpResponse };
