// Public surface of the fake NetworkManager harness: a stateful nmcli-runner stub and
// a `NetworkManagerPort` implemented over it. A4.1 injects the runner to assert its GSM
// write argv + readback; reconcile/observer tests use the port as an NM double.

export { FakeNetworkManagerPort } from './fake-network-manager';
export { type NmcliResult, StatefulNmcliRunner } from './nmcli-runner';
