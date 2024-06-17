const SemVer = require('@typescript-eslint/typescript-estree/node_modules/semver/classes/semver');  // Corrected import format
const patchSemVer = (a, loose) => new SemVer(a, loose).patch;
module.exports = patchSemVer;

import { EVMNonceManager } from '../../dist/src/chains/ethereum/evm.nonce';  // Corrected path

const nonceManager = new EVMNonceManager();

function patch(target: any, methodName: string, patchFn: (...args: any[]) => any) {
  const originalMethod = target[methodName];
  target[methodName] = function (...args: any[]) {
    return patchFn.apply(this, args);
  };
}

patch(nonceManager, 'init', () => {
  return;
});

patch(nonceManager, 'mergeNonceFromEVMNode', () => {
  return;
});

patch(nonceManager, 'getNonceFromNode', (_ethAddress: string) => {
  return Promise.resolve(12);
});

patch(nonceManager, 'getNextNonce', (_ethAddress: string) => {
  return Promise.resolve(13);
});

patch(nonceManager, 'setNonce', async (_: string, __: number): Promise<void> => {
  return;
});

patch(nonceManager, 'commitNonce', async (_: string, __: number): Promise<void> => {
  return;
});
