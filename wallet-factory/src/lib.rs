use near_sdk::{AccountId, Gas, NearToken, Promise, env, near, require};

/// Wallet factory contract.
///
/// Stores the approved wallet WASM on-chain. Anyone can create a wallet
/// subaccount — no need to pass WASM bytes, factory deploys from storage.
#[near(contract_state)]
#[derive(Debug)]
pub struct Contract {
    pub owner_id: AccountId,
    /// SHA-256 hash of the approved wallet WASM (hex string).
    pub code_hash: String,
    /// The wallet contract WASM, stored on-chain. None until set_wallet_code is called.
    pub wallet_code: Option<Vec<u8>>,
}

impl Default for Contract {
    fn default() -> Self {
        Self {
            owner_id: env::predecessor_account_id(),
            code_hash: "0".repeat(64),
            wallet_code: None,
        }
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            owner_id: env::predecessor_account_id(),
            code_hash: "0".repeat(64),
            wallet_code: None,
        }
    }

    /// Re-initialize, ignoring existing state (for migration).
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        Self {
            owner_id: env::predecessor_account_id(),
            code_hash: "0".repeat(64),
            wallet_code: None,
        }
    }

    /// Store the approved wallet WASM. Owner only. Pay ~3.8 NEAR for storage.
    /// Accepts base64-encoded WASM to reduce argument size.
    #[payable]
    pub fn set_wallet_code(&mut self, wasm_base64: String) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only owner"
        );
        // Decode base64
        let wasm = near_sdk::base64::Engine::decode(
            &near_sdk::base64::engine::general_purpose::STANDARD,
            &wasm_base64,
        ).expect("Invalid base64");
        let hash = env::sha256(&wasm);
        let hash_hex: String = hash.iter().map(|b| format!("{:02x}", b)).collect();
        self.code_hash = hash_hex;
        self.wallet_code = Some(wasm);
    }

    /// Get the current approved code hash.
    pub fn get_code_hash(&self) -> String {
        self.code_hash.clone()
    }

    /// Get the stored WASM size.
    pub fn get_wallet_code_size(&self) -> u64 {
        self.wallet_code.as_ref().map_or(0, |c| c.len() as u64)
    }

    /// Create a new wallet subaccount under this factory.
    /// For root .testnet accounts, use the relay's /create-root + /deploy-wallet endpoints.
    ///
    /// - `name`: subaccount name (e.g. "alice" → "alice.pwallet-v2.kampy.testnet")
    /// - `public_key`: passkey public key string for w_init
    ///
    /// Deploys the stored WASM and calls w_init.
    #[payable]
    pub fn create_wallet(
        &mut self,
        name: String,
        public_key: String,
    ) -> Promise {
        // Verify WASM is stored
        let code = self.wallet_code.as_ref().expect("No wallet code stored");

        // Validate name
        require!(!name.is_empty(), "Empty name");
        require!(name.len() <= 64, "Name too long");
        require!(!name.contains('.'), "No dots in name");

        // Build subaccount ID
        let subaccount: AccountId = format!("{}.{}", name, env::current_account_id())
            .parse()
            .expect("Invalid subaccount ID");

        // Minimum deposit
        let min_deposit = NearToken::from_near(1);
        require!(
            env::attached_deposit() >= min_deposit,
            "Need at least 1 NEAR"
        );

        // Build init args JSON
        let init_args = format!(r#"{{"public_key":"{}"}}"#, public_key).into_bytes();

        // Create subaccount → deploy from stored code → init
        Promise::new(subaccount)
            .create_account()
            .transfer(env::attached_deposit())
            .deploy_contract(code.clone())
            .function_call(
                "w_init".parse::<near_sdk::AccountId>().unwrap(),
                init_args,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(50),
            )
    }
}
