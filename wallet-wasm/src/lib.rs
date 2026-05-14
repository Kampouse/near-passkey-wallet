//! Shared WASM code for wallet - borsh serialization and signature verification
//!
//! This crate compiles to WASM and runs in both the browser (via wasm-bindgen)
//! and natively in the NEAR contract. It ensures byte-identical serialization.

use borsh::{to_vec, BorshDeserialize, BorshSerialize};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest as _, Sha256};
use wasm_bindgen::prelude::*;

// ─── Core Types ─────────────────────────────────────────────────────

/// Request message structure matching the contract exactly.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct RequestMessage {
    pub chain_id: String,
    pub signer_id: String, // AccountId as string - borsh encodes the same way
    pub nonce: u32,
    pub created_at: u32, // TimestampSeconds<u32> - seconds since epoch
    pub timeout: u32,    // DurationSeconds<u32> - timeout in seconds
    pub request: Request,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default)]
pub struct Request {
    pub ops: Vec<WalletOp>,
    pub out: PromiseDAG,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum WalletOp {
    SetSignatureMode {
        enable: bool,
    } = 0,
    AddExtension {
        account_id: String,
    } = 1,
    RemoveExtension {
        account_id: String,
    } = 2,
    CreateSession {
        session_key_id: String,
        public_key: String,
        ttl_secs: u32,
    } = 3,
    RevokeSession {
        session_key_id: String,
    } = 4,
    Custom {
        args: Vec<u8>,
    } = 254, // u8::MAX - 1 matching contract
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default)]
pub struct PromiseDAG {
    pub after: Vec<PromiseDAG>,
    pub then: Vec<PromiseSingle>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct PromiseSingle {
    pub receiver_id: String,
    pub actions: Vec<Action>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub enum Action {
    FunctionCall {
        function_name: String,
        args: Vec<u8>,
        deposit: u128,
        gas: u64,
    },
}

// ─── WASM Exports for Browser ───────────────────────────────────────

/// Borsh-serialize a RequestMessage and return the bytes as hex string.
#[wasm_bindgen]
pub fn borsh_serialize_request(
    chain_id: String,
    signer_id: String,
    nonce: u32,
    created_at: u32,
    timeout: u32,
) -> String {
    let msg = RequestMessage {
        chain_id,
        signer_id,
        nonce,
        created_at,
        timeout,
        request: Request::default(),
    };

    match to_vec(&msg) {
        Ok(bytes) => hex_encode(&bytes),
        Err(_) => String::new(),
    }
}

/// Compute the SHA-256 hash of borsh-serialized RequestMessage.
#[wasm_bindgen]
pub fn hash_request(
    chain_id: String,
    signer_id: String,
    nonce: u32,
    created_at: u32,
    timeout: u32,
) -> String {
    let msg = RequestMessage {
        chain_id,
        signer_id,
        nonce,
        created_at,
        timeout,
        request: Request::default(),
    };

    match to_vec(&msg) {
        Ok(bytes) => {
            let hash = sha256(&bytes);
            hex_encode(&hash)
        }
        Err(_) => String::new(),
    }
}

/// Verify an ed25519 signature against a message hash.
#[wasm_bindgen]
pub fn verify_signature(pk_b58: String, sig_b58: String, msg_hash_hex: String) -> bool {
    let pk_bytes = match bs58::decode(&pk_b58).into_vec() {
        Ok(v) => v,
        Err(_) => return false,
    };
    if pk_bytes.len() != 32 {
        return false;
    }
    let mut pk_arr = [0u8; 32];
    pk_arr.copy_from_slice(&pk_bytes);

    let sig_bytes = match bs58::decode(&sig_b58).into_vec() {
        Ok(v) => v,
        Err(_) => return false,
    };
    if sig_bytes.len() != 64 {
        return false;
    }
    let mut sig_arr = [0u8; 64];
    sig_arr.copy_from_slice(&sig_bytes);

    let msg_hash = match hex_decode(&msg_hash_hex) {
        Some(h) if h.len() == 32 => {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&h);
            arr
        }
        _ => return false,
    };

    ed25519_verify(&sig_arr, &pk_arr, &msg_hash)
}

// ─── Cryptography ───────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&result);
    arr
}

fn ed25519_verify(sig: &[u8; 64], pk: &[u8; 32], msg: &[u8; 32]) -> bool {
    let Ok(public_key) = VerifyingKey::from_bytes(pk) else {
        return false;
    };
    let signature = Signature::from_bytes(sig);
    public_key.verify_strict(msg, &signature).is_ok()
}

// ─── Helpers ─────────────────────────────────────────────────────────

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_borsh_roundtrip() {
        let msg = RequestMessage {
            chain_id: "mainnet".to_string(),
            signer_id: "test.near".to_string(),
            nonce: 12345,
            created_at: 1700000000,
            timeout: 300,
            request: Request::default(),
        };

        let bytes = to_vec(&msg).unwrap();
        let msg2: RequestMessage = RequestMessage::try_from_slice(&bytes).unwrap();

        assert_eq!(msg.chain_id, msg2.chain_id);
        assert_eq!(msg.signer_id, msg2.signer_id);
        assert_eq!(msg.nonce, msg2.nonce);
        assert_eq!(msg.created_at, msg2.created_at);
        assert_eq!(msg.timeout, msg2.timeout);
    }

    #[test]
    fn test_empty_request_encoding() {
        let msg = RequestMessage {
            chain_id: "mainnet".to_string(),
            signer_id: "test.near".to_string(),
            nonce: 0,
            created_at: 0,
            timeout: 0,
            request: Request::default(),
        };

        let bytes = to_vec(&msg).unwrap();
        println!("Encoded bytes: {}", hex_encode(&bytes));
        println!("Length: {}", bytes.len());
    }
}