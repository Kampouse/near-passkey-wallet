mod impl_;
mod utils;

pub use self::impl_::*;

use std::collections::{BTreeMap, BTreeSet};

use defuse_deadline::Deadline;
use near_sdk::{AccountId, AccountIdRef, FunctionError, env, near};

use crate::{
    Actor, Error, Request, RequestMessage, Result, SessionKey, Wallet, WalletEvent, WalletOp,
    signature::SigningStandard,
};

#[near]
impl Wallet for Contract {
    #[payable]
    fn w_execute_signed(&mut self, msg: RequestMessage, proof: String) {
        self.execute_signed(msg, &proof)
            .unwrap_or_else(|err| err.panic());
    }

    #[payable]
    fn w_execute_extension(&mut self, request: Request) {
        self.execute_extension(request)
            .unwrap_or_else(|err| err.panic());
    }

    fn w_subwallet_id(&self) -> u32 {
        self.wallet_id
    }

    fn w_is_signature_allowed(&self) -> bool {
        self.is_signature_allowed()
    }

    fn w_public_key(&self) -> String {
        self.public_key.to_string()
    }

    fn w_is_extension_enabled(&self, account_id: AccountId) -> bool {
        self.has_extension(account_id)
    }

    fn w_extensions(&self) -> BTreeSet<AccountId> {
        self.extensions.clone()
    }

    fn w_timeout_secs(&self) -> u32 {
        self.nonces
            .timeout()
            .as_secs()
            .try_into() // it's serialized as u32 in state
            .unwrap_or_else(|_| unreachable!())
    }

    fn w_last_cleaned_at(&self) -> Deadline {
        self.nonces.last_cleaned_at()
    }

    #[payable]
    fn w_execute_session(&mut self, msg: RequestMessage, session_key_id: String, signature: String) {
        self.execute_session(msg, &session_key_id, &signature)
            .unwrap_or_else(|err| err.panic());
    }

    fn w_session_keys(&self) -> BTreeMap<String, SessionKey> {
        self.session_keys.clone()
    }

    fn w_session_key(&self, session_key_id: String) -> Option<SessionKey> {
        self.session_keys.get(&session_key_id).cloned()
    }
}

/// Initialize the contract with a public key (alternative to StateInit).
#[near]
impl Contract {
    #[init]
    pub fn w_init(public_key: String) -> Self {
        let pk: PublicKey = public_key
            .parse()
            .unwrap_or_else(|_| env::panic_str("Failed to parse public key"));
        Self(State::new(pk))
    }
}

impl Contract {
    fn execute_signed(&mut self, msg: RequestMessage, proof: &str) -> Result<()> {
        if !self.is_signature_allowed() {
            return Err(Error::SignatureDisabled);
        }

        // check chain_id
        if msg.chain_id != utils::chain_id() {
            return Err(Error::InvalidChainId);
        }

        // check signer_id
        if msg.signer_id != env::current_account_id() {
            return Err(Error::InvalidSignerId(msg.signer_id));
        }

        // commit the nonce
        self.nonces.commit(msg.nonce, msg.created_at, msg.timeout)?;

        // verify signature
        if !<Self as ContractImpl>::SigningStandard::verify(&msg, &self.public_key, proof) {
            return Err(Error::InvalidSignature);
        }

        let hash = msg.hash();
        WalletEvent::SignedRequest { hash }.emit();

        self.execute_request(msg.request, &Actor::SignedRequest(hash))
    }

    fn execute_extension(&mut self, request: Request) -> Result<()> {
        if env::attached_deposit().is_zero() {
            return Err(Error::InsufficientDeposit);
        }

        // check whether extension is enabled
        let extension_id = env::predecessor_account_id();
        self.check_extension_enabled(&extension_id)?;

        // maybe cleanup nonces from the storage as best-effort to make it
        // available for further applying wallet-ops below
        self.nonces.check_cleanup();

        self.execute_request(request, &Actor::Extension(extension_id.into()))
    }

    fn execute_session(
        &mut self,
        msg: RequestMessage,
        session_key_id: &str,
        signature: &str,
    ) -> Result<()> {
        // 1. Look up session key
        let session_key = self
            .session_keys
            .get(session_key_id)
            .cloned()
            .ok_or_else(|| Error::SessionKeyNotFound(session_key_id.to_string()))?;

        // 2. Check not expired
        let now = env::block_timestamp();
        if now >= session_key.expires_at {
            return Err(Error::SessionKeyExpired(session_key_id.to_string()));
        }

        // check chain_id
        if msg.chain_id != utils::chain_id() {
            return Err(Error::InvalidChainId);
        }

        // check signer_id
        if msg.signer_id != env::current_account_id() {
            return Err(Error::InvalidSignerId(msg.signer_id));
        }

        // 3. Commit nonce (reuse existing replay protection)
        self.nonces.commit(msg.nonce, msg.created_at, msg.timeout)?;

        // 4. Verify ed25519 signature
        let msg_hash = msg.hash();

        // Decode the public key from "ed25519:base58..." format
        let pk_bytes = decode_near_ed25519_public_key(&session_key.public_key)
            .ok_or_else(|| Error::InvalidSessionKey(session_key.public_key.clone()))?;

        // Decode the base58 signature
        let sig_vec = decode_base58(signature)
            .ok_or_else(|| Error::InvalidSignature)?;

        if sig_vec.len() != 64 {
            return Err(Error::InvalidSignature);
        }

        let mut sig_bytes = [0u8; 64];
        sig_bytes.copy_from_slice(&sig_vec);

        if !env::ed25519_verify(&sig_bytes, &msg_hash, &pk_bytes) {
            return Err(Error::InvalidSignature);
        }

        WalletEvent::SignedRequest { hash: msg_hash }.emit();

        // 5. Validate ops are safe for session execution
        for op in &msg.request.ops {
            match op {
                WalletOp::AddExtension { .. }
                | WalletOp::RemoveExtension { .. }
                | WalletOp::Custom { .. } => {}
                WalletOp::CreateSession { .. }
                | WalletOp::RevokeSession { .. }
                | WalletOp::RevokeAllSessions
                | WalletOp::SetSignatureMode { .. } => {
                    return Err(Error::SessionOpNotAllowed(op.clone()));
                }
            }
        }

        // Execute with session actor
        self.execute_request(msg.request, &Actor::Session(session_key_id.to_string()))
    }

    fn execute_request(&mut self, request: Request, actor: &Actor<'_>) -> Result<()> {
        for op in request.ops {
            self.execute_op(op, actor.as_ref())?;
        }

        if let Some(promise) = request.out.build() {
            promise.detach();
        }

        Ok(())
    }

    fn execute_op(&mut self, op: WalletOp, actor: Actor<'_>) -> Result<()> {
        match op {
            WalletOp::SetSignatureMode { enable } => {
                // Only SignedRequest can set signature mode
                match &actor {
                    Actor::SignedRequest(_) => {}
                    _ => return Err(Error::SessionOpNotAllowed(op)),
                }
                self.set_signature_mode(enable, actor)
            }
            WalletOp::AddExtension { account_id } => self.add_extension(account_id, actor),
            WalletOp::RemoveExtension { account_id } => self.remove_extension(account_id, actor),

            WalletOp::CreateSession {
                session_key_id,
                public_key,
                ttl_secs,
            } => {
                // Only SignedRequest can create sessions
                match &actor {
                    Actor::SignedRequest(_) => {}
                    _ => return Err(Error::SessionOpNotAllowed(WalletOp::CreateSession {
                        session_key_id: session_key_id.clone(),
                        public_key: public_key.clone(),
                        ttl_secs,
                    })),
                }
                self.create_session(session_key_id, public_key, ttl_secs, actor)
            }
            WalletOp::RevokeSession { session_key_id } => {
                // Only SignedRequest can revoke sessions
                match &actor {
                    Actor::SignedRequest(_) => {}
                    _ => return Err(Error::SessionOpNotAllowed(WalletOp::RevokeSession {
                        session_key_id: session_key_id.clone(),
                    })),
                }
                self.revoke_session(session_key_id, actor)
            }
            WalletOp::RevokeAllSessions => {
                // Only SignedRequest can revoke all sessions
                match &actor {
                    Actor::SignedRequest(_) => {}
                    _ => return Err(Error::SessionOpNotAllowed(WalletOp::RevokeAllSessions)),
                }
                self.revoke_all_sessions(actor)
            }

            WalletOp::Custom { .. } => env::panic_str("custom ops are not supported"),
        }
    }

    fn create_session(
        &mut self,
        session_key_id: String,
        public_key: String,
        ttl_secs: u32,
        actor: Actor<'_>,
    ) -> Result<()> {
        // SECURITY: Cap TTL to 24 hours to limit exposure if session key is compromised
        const MAX_SESSION_TTL_SECS: u32 = 24 * 60 * 60; // 24 hours
        if ttl_secs > MAX_SESSION_TTL_SECS {
            return Err(Error::SessionTtlTooLong {
                requested: ttl_secs,
                max: MAX_SESSION_TTL_SECS,
            });
        }

        // Emit event first to help with debugging
        WalletEvent::SessionCreated {
            session_key_id: session_key_id.clone(),
            public_key: public_key.clone(),
            ttl_secs,
            by: actor,
        }
        .emit();

        // Validate public key format
        if decode_near_ed25519_public_key(&public_key).is_none() {
            return Err(Error::InvalidSessionKey(public_key));
        }

        // Check session key doesn't already exist
        if self.session_keys.contains_key(&session_key_id) {
            return Err(Error::SessionKeyAlreadyExists(session_key_id));
        }

        let now = env::block_timestamp();
        let expires_at = now.saturating_add(ttl_secs as u64 * 1_000_000_000);

        self.session_keys.insert(
            session_key_id,
            SessionKey {
                public_key,
                created_at: now,
                expires_at,
            },
        );

        Ok(())
    }

    fn revoke_session(&mut self, session_key_id: String, actor: Actor<'_>) -> Result<()> {
        // Emit event first to help with debugging
        WalletEvent::SessionRevoked {
            session_key_id: session_key_id.clone(),
            by: actor,
        }
        .emit();

        if self.session_keys.remove(&session_key_id).is_none() {
            return Err(Error::SessionKeyNotFound(session_key_id));
        }

        Ok(())
    }

    fn revoke_all_sessions(&mut self, actor: Actor<'_>) -> Result<()> {
        let count = self.session_keys.len();

        // Emit event for auditing
        WalletEvent::AllSessionsRevoked {
            count,
            by: actor,
        }
        .emit();

        self.session_keys.clear();

        Ok(())
    }

    fn set_signature_mode(&mut self, enable: bool, actor: Actor<'_>) -> Result<()> {
        // emit first to help for debugging
        WalletEvent::SignatureModeSet {
            enabled: enable,
            by: actor,
        }
        .emit();

        if self.signature_enabled == enable {
            return Err(Error::ThisSignatureModeAlreadySet);
        }
        self.signature_enabled = enable;

        self.check_lockout()
    }

    fn add_extension(&mut self, account_id: AccountId, actor: Actor<'_>) -> Result<()> {
        // emit first to help for debugging
        WalletEvent::ExtensionAdded {
            account_id: (&account_id).into(),
            by: actor,
        }
        .emit();

        if !self.extensions.insert(account_id.clone()) {
            return Err(Error::ExtensionEnabled(account_id));
        }

        Ok(())
    }

    fn remove_extension(&mut self, account_id: AccountId, actor: Actor<'_>) -> Result<()> {
        // emit first to help for debugging
        WalletEvent::ExtensionRemoved {
            account_id: (&account_id).into(),
            by: actor,
        }
        .emit();

        if !self.extensions.remove(&account_id) {
            return Err(Error::ExtensionNotEnabled(account_id));
        }

        self.check_lockout()
    }

    fn check_extension_enabled(&self, account_id: &AccountIdRef) -> Result<()> {
        if !self.has_extension(account_id) {
            return Err(Error::ExtensionNotEnabled(account_id.to_owned()));
        }
        Ok(())
    }

    fn check_lockout(&self) -> Result<()> {
        if !self.signature_enabled && self.extensions.is_empty() {
            return Err(Error::Lockout);
        }
        Ok(())
    }
}

/// Decode an ed25519 public key from NEAR format "ed25519:base58..." into 32 bytes.
fn decode_near_ed25519_public_key(key: &str) -> Option<[u8; 32]> {
    let parts: Vec<&str> = key.splitn(2, ':').collect();
    if parts.len() != 2 || parts[0] != "ed25519" {
        return None;
    }
    let bytes = bs58::decode(parts[1]).into_vec().ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Some(arr)
}

/// Decode a base58-encoded string into bytes.
fn decode_base58(s: &str) -> Option<Vec<u8>> {
    bs58::decode(s).into_vec().ok()
}
