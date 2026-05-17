
// Debug endpoint that returns the borsh hex without sending to RPC
export function debugBuildTx(signerId, seed, argsBytes, nonce, blockHash) {
  const pubKey = getPublicKey(seed);
  // ... same borsh construction but returns hex for debugging
}
