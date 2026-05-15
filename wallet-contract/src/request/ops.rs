use near_sdk::{AccountId, near, serde_with::base64::Base64};

#[cfg_attr(any(feature = "arbitrary", test), derive(arbitrary::Arbitrary))]
#[near(serializers = [borsh(use_discriminant = true), json])]
#[serde(tag = "op", rename_all = "snake_case")]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum WalletOp {
    SetSignatureMode {
        enable: bool,
    } = 0,
    AddExtension {
        account_id: AccountId,
    } = 1,
    RemoveExtension {
        account_id: AccountId,
    } = 2,

    CreateSession {
        session_key_id: String,
        public_key: String,
        ttl_secs: u32,
    } = 3,

    RevokeSession {
        session_key_id: String,
    } = 4,

    /// Revoke ALL session keys in one operation.
    /// Requires passkey authentication (SignedRequest actor).
    /// Useful for emergency revocation when a session key may be compromised.
    RevokeAllSessions = 5,

    /// Set a backup passkey (e.g., Ledger FIDO authenticator).
    /// Requires passkey authentication. Only one backup key allowed.
    SetBackupKey {
        public_key: String,
    } = 6,

    /// Remove the backup passkey.
    /// Requires passkey authentication.
    RemoveBackupKey = 7,

    /// Custom op for third-party implementations.
    Custom {
        #[cfg_attr(
            all(feature = "abi", not(target_arch = "wasm32")),
            schemars(with = "String")
        )]
        #[serde_as(as = "Base64")]
        args: Vec<u8>,
    } = u8::MAX - 1,
}
