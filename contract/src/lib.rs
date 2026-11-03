//! AgentSig policy contract (NEAR testnet).
//!
//! Stores a spending policy for a Chain-Signatures agent (identified by its
//! derivation path, e.g. "bsc,1") and an on-chain log of the actions the
//! agent executed under that policy. The agent runtime reads the policy
//! before requesting any MPC signature and records each executed action.

use near_sdk::{env, near, AccountId, PanicOnDefault};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Policy {
    /// Chain-Signatures derivation path identifying the agent, e.g. "bsc,1".
    pub agent_path: String,
    /// Per-transaction cap, in wei of the target chain's native asset (string to keep full u256 precision in JSON).
    pub per_tx_cap_wei: String,
    /// Daily cap, in wei (string, same reason).
    pub daily_cap_wei: String,
    /// EVM addresses the agent is allowed to send to.
    pub allowed_targets: Vec<String>,
    /// Master switch: when false, the agent must refuse every task.
    pub active: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ActionRecord {
    pub agent_path: String,
    pub target: String,
    pub amount_wei: String,
    /// Hash of the signed (and, when funded, broadcast) target-chain transaction.
    pub tx_hash: String,
    /// NEAR block timestamp (ms) when the action was recorded.
    pub timestamp_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner: AccountId,
    pub policy: Option<Policy>,
    pub actions: Vec<ActionRecord>,
}

#[near]
impl Contract {
    #[init]
    pub fn init(owner: AccountId) -> Self {
        Self {
            owner,
            policy: None,
            actions: Vec::new(),
        }
    }

    /// Set or replace the agent policy. Owner only.
    pub fn set_policy(
        &mut self,
        agent_path: String,
        per_tx_cap_wei: String,
        daily_cap_wei: String,
        allowed_targets: Vec<String>,
        active: bool,
    ) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "set_policy is owner-only"
        );
        self.policy = Some(Policy {
            agent_path,
            per_tx_cap_wei,
            daily_cap_wei,
            allowed_targets,
            active,
        });
    }

    /// Current policy, or null if none was set.
    pub fn get_policy(&self) -> Option<&Policy> {
        self.policy.as_ref()
    }

    /// Record an action the agent executed. Callable by the owner account
    /// (the account that operates the agent) or the contract account itself.
    pub fn record_action(
        &mut self,
        agent_path: String,
        target: String,
        amount_wei: String,
        tx_hash: String,
    ) {
        let caller = env::predecessor_account_id();
        assert!(
            caller == self.owner || caller == env::current_account_id(),
            "record_action is not authorized for this account"
        );
        self.actions.push(ActionRecord {
            agent_path,
            target,
            amount_wei,
            tx_hash,
            timestamp_ms: env::block_timestamp_ms(),
        });
    }

    /// Most recent action records (oldest first), capped at `limit` (default 20).
    pub fn get_actions(&self, limit: Option<u32>) -> Vec<&ActionRecord> {
        let limit = limit.unwrap_or(20) as usize;
        let start = self.actions.len().saturating_sub(limit);
        self.actions[start..].iter().collect()
    }
}
