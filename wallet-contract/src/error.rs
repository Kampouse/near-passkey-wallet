use near_sdk::{AccountId, FunctionError};
use thiserror::Error as ThisError;

use crate::WalletOp;

pub type Result<T, E = Error> = ::core::result::Result<T, E>;

#[derive(Debug, ThisError, FunctionError)]
pub enum Error {
    #[error("already executed")]
    AlreadyExecuted,

    #[error("extension '{0}' is already enabled")]
    ExtensionEnabled(AccountId),

    #[error("extension '{0}' is not enabled")]
    ExtensionNotEnabled(AccountId),

    #[error("invalid chain-id")]
    InvalidChainId,

    #[error("expired or from the future")]
    ExpiredOrFuture,

    #[error("invalid signature")]
    InvalidSignature,

    #[error("invalid signer_id: {0}")]
    InvalidSignerId(AccountId),

    #[error("insufficient attached deposit")]
    InsufficientDeposit,

    #[error("lockout: signature is disabled and extensions are empty")]
    Lockout,

    #[error("signature is disabled")]
    SignatureDisabled,

    #[error("this signature mode is already set")]
    ThisSignatureModeAlreadySet,

    #[error("session key not found: {0}")]
    SessionKeyNotFound(String),

    #[error("session key expired: {0}")]
    SessionKeyExpired(String),

    #[error("invalid session key: {0}")]
    InvalidSessionKey(String),

    #[error("session op not allowed: {0:?}")]
    SessionOpNotAllowed(WalletOp),

    #[error("session key already exists: {0}")]
    SessionKeyAlreadyExists(String),
}
