export const DEFAULT_MODEM_CONTROL_LOCK_PATH = '/run/ceralive/modem-control.lock';

export type ExclusiveResource = 'file-store' | 'router-session' | 'usb-hub';

export type ResourceOwnershipRequest = {
	readonly resource: ExclusiveResource;
};

export type ResourceOwnershipHolder = {
	readonly pid: number;
	readonly startedAtEpochMs: number;
};

export type ResourceOwnershipLoss = {
	readonly reason: 'holder-exited';
};

export interface ResourceOwnershipLease {
	readonly holder: ResourceOwnershipHolder;
	readonly lost: Promise<ResourceOwnershipLoss>;
	release(): Promise<void>;
}

export type ResourceOwnershipResult =
	| { readonly status: 'acquired'; readonly lease: ResourceOwnershipLease }
	| {
			readonly status: 'refused';
			readonly reason: 'already-owned';
			readonly holder?: ResourceOwnershipHolder;
	  };

/** Acquire-or-refuse ownership; implementations must never queue a contender. */
export interface ResourceOwnershipPort {
	acquire(request: ResourceOwnershipRequest): Promise<ResourceOwnershipResult>;
}
