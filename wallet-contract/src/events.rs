use std::borrow::Cow;

use defuse_serde_utils::base58::Base58;
use near_sdk::{AccountIdRef, CryptoHash, near, serde::Deserialize, serde_with::serde_as};

#[serde_as(crate = "::near_sdk::serde_with")]
#[near(event_json(standard = "wallet"))]
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub enum WalletEvent<'a> {
    /// An extension has been added.
    #[event_version("1.0.0")]
    ExtensionAdded {
        /// Account id of the extension
        account_id: Cow<'a, AccountIdRef>,
        /// Actor of the corresponding request
        by: Actor<'a>,
    },

    /// An extension has been removed.
    #[event_version("1.0.0")]
    ExtensionRemoved {
        /// Account id of the extension
        account_id: Cow<'a, AccountIdRef>,
        /// Actor of the corresponding request
        by: Actor<'a>,
    },

    /// Signature mode mode has been set.
    #[event_version("1.0.0")]
    SignatureModeSet {
        /// Whether the signature has been enabled or disabled.
        enabled: bool,
        /// Actor of the corresponding request
        by: Actor<'a>,
    },

    #[event_version("1.0.0")]
    SignedRequest {
        /// Request hash
        #[serde_as(as = "Base58")]
        hash: CryptoHash,
    },

    /// A session key has been created.
    #[event_version("1.0.0")]
    SessionCreated {
        /// Session key ID
        session_key_id: String,
        /// Public key of the session key
        public_key: String,
        /// Time-to-live in seconds
        ttl_secs: u32,
        /// Actor of the corresponding request
        by: Actor<'a>,
    },

    /// A session key has been revoked.
    #[event_version("1.0.0")]
    SessionRevoked {
        /// Session key ID
        session_key_id: String,
        /// Actor of the corresponding request
        by: Actor<'a>,
    },
}

/// Actor of the request
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor<'a> {
    /// Executed by signed request with given hash via `w_execute_signed()`.
    SignedRequest(#[serde_as(as = "Base58")] CryptoHash),

    /// Extension with given `account_id`
    Extension(Cow<'a, AccountIdRef>),

    /// Executed by session key with given ID via `w_execute_session()`.
    Session(String),
}

impl Actor<'_> {
    pub fn as_ref(&self) -> Actor<'_> {
        match self {
            Self::SignedRequest(hash) => Actor::SignedRequest(*hash),
            Self::Extension(account_id) => Actor::Extension(account_id.as_ref().into()),
            Self::Session(id) => Actor::Session(id.clone()),
        }
    }
}
