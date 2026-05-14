/* tslint:disable */
/* eslint-disable */

/**
 * Borsh-serialize a RequestMessage and return the bytes as hex string.
 */
export function borsh_serialize_request(chain_id: string, signer_id: string, nonce: number, created_at: number, timeout: number): string;

/**
 * Compute the SHA-256 hash of borsh-serialized RequestMessage.
 */
export function hash_request(chain_id: string, signer_id: string, nonce: number, created_at: number, timeout: number): string;

/**
 * Verify an ed25519 signature against a message hash.
 */
export function verify_signature(pk_b58: string, sig_b58: string, msg_hash_hex: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly borsh_serialize_request: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly hash_request: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly verify_signature: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
