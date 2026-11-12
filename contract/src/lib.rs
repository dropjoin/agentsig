//! AgentSig policy contract v2 (NEAR testnet).
//!
//! The contract is the ONLY path to a signature. The agent never calls the
//! MPC signer directly: it asks THIS contract, the contract enforces the
//! spending policy ON CHAIN (active flag, per-tx cap, daily cap, allowlist),
//! records the action, and only then requests the signature from the NEAR
//! Chain Signatures signer (`v1.signer-prod.testnet`). The derived EVM
//! address belongs to (this contract account, derivation path), so a
//! signature for it cannot be produced by bypassing the contract.
//!
//! v1 stored the policy and an audit log but enforced the rules only in the
//! off-chain runtime, which meant anyone holding the agent's NEAR key could
//! call the signer directly and skip the policy entirely. v2 closes that
//! hole: the check happens here, in `request_signature`, before any MPC call.
//!
//! State layout is intentionally identical to v1 (same structs, same field
//! order), so the v2 wasm can be deployed over the v1 contract in place and
//! the stored policy + action log keep deserializing.

use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

/// NEAR Chain Signatures signer on testnet (mainnet would be `v1.signer`).
const MPC_SIGNER: &str = "v1.signer-prod.testnet";
/// Gas reserved for the `on_signature_ready` callback receipt. The callback
/// only reads the promise result, validates the shape, and returns it.
const GAS_FOR_CALLBACK_TGAS: u64 = 20;
/// Gas reserved for promise creation and host-function costs incurred after
/// the gas snapshot below is taken. Measured in the near-sdk mock (which
/// uses the real protocol gas schedule): one function-call action costs
/// ~5 TGas beyond its attached gas, and this call builds two actions plus
/// a join, so the margin must cover ~15 TGas, not ~1. Without it the
/// attached gas plus the creation costs exceed the prepaid 300 TGas.
const GAS_OVERHEAD_TGAS: u64 = 15;
/// Minimum gas forwarded to the signer call; below this the request is refused
/// rather than started and left to die mid-flight.
const MIN_GAS_FOR_SIGN_TGAS: u64 = 100;
/// The signer charges 1 yoctoNEAR per `sign` call (see chainsig.js).
const SIGN_DEPOSIT_YOCTO: u128 = 1;
/// Upper bound on gas forwarded to the signer call. The signer method is
/// cheap (it only registers the request; the MPC nodes pay for their own
/// respond transactions), and clamping keeps the total inside the prepaid
/// budget however much gas the caller attached.
const MAX_GAS_FOR_SIGN_TGAS: u64 = 250;
/// The MPC `SignResult` JSON is ~200 bytes; bound the callback read well
/// above that so a huge result fails cleanly instead of burning gas.
const MAX_SIGNATURE_RESULT_BYTES: usize = 1024;
/// ECDSA/secp256k1 domain id in the signer's `payload_v2` API.
const DOMAIN_ID_ECDSA: u8 = 0;

const TGAS: u64 = 1_000_000_000_000;
const DAY_MS: u64 = 86_400_000;

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
    /// Master switch: when false, the contract refuses every signature request.
    pub active: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ActionRecord {
    pub agent_path: String,
    pub target: String,
    pub amount_wei: String,
    /// v2: the 32-byte signing payload hash (hex) that was approved and sent
    /// to the MPC signer. The broadcast target-chain tx hash is keccak256 of
    /// the signed serialization and is logged by the agent runtime.
    /// (v1 records stored the signed tx hash instead.)
    pub tx_hash: String,
    /// NEAR block timestamp (ms) when the request passed the policy check.
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

    /// Set or replace the agent policy. Owner only. Note the agent runtime
    /// runs with a function-call key scoped to `request_signature`, so it
    /// cannot call this: policy changes need the owner's full-access key,
    /// which stays offline.
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

    /// Most recent action records (oldest first), capped at `limit` (default 20).
    pub fn get_actions(&self, limit: Option<u32>) -> Vec<&ActionRecord> {
        let limit = limit.unwrap_or(20) as usize;
        let start = self.actions.len().saturating_sub(limit);
        self.actions[start..].iter().collect()
    }

    /// Wei spent under the current policy in the current UTC day, as a
    /// decimal string. Counts every policy-approved request, including one
    /// whose MPC call later failed (fail-safe: a failed request still
    /// consumes cap, it never grants extra spend).
    pub fn get_spent_today(&self) -> String {
        match &self.policy {
            Some(p) => {
                spent_today(&self.actions, &p.agent_path, env::block_timestamp_ms()).to_string()
            }
            None => "0".to_string(),
        }
    }

    /// Request an MPC signature for a target-chain transaction hash.
    ///
    /// Enforces the policy on chain, records the approved request, then
    /// calls the Chain Signatures signer. The signature comes back through
    /// `on_signature_ready`, whose return value is the final result of the
    /// caller's transaction.
    ///
    /// `payload_hex` is the 32-byte hash to sign, as 64 hex characters
    /// (for an EIP-1559 tx: keccak256 of the unsigned serialization).
    /// Owner only: the agent account IS the owner account, and it calls
    /// this with a function-call key scoped to this method.
    pub fn request_signature(
        &mut self,
        target: String,
        amount_wei: String,
        payload_hex: String,
    ) -> Promise {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "request_signature is owner-only"
        );
        let policy = self.policy.as_ref().expect("no policy set").clone();
        let now_ms = env::block_timestamp_ms();
        check_policy(&policy, &self.actions, now_ms, &target, &amount_wei, &payload_hex);

        // Record BEFORE the async call: concurrent requests then see each
        // other's spend, so the daily cap cannot be raced, and a failed MPC
        // call leaves a conservative record instead of a free retry.
        self.actions.push(ActionRecord {
            agent_path: policy.agent_path.clone(),
            target: target.clone(),
            amount_wei: amount_wei.clone(),
            tx_hash: payload_hex.clone(),
            timestamp_ms: now_ms,
        });

        let args = json!({
            "request": {
                "payload_v2": { "Ecdsa": payload_hex },
                "path": policy.agent_path,
                "domain_id": DOMAIN_ID_ECDSA,
            }
        });
        let available = env::prepaid_gas()
            .as_gas()
            .saturating_sub(env::used_gas().as_gas());
        let reserve = (GAS_FOR_CALLBACK_TGAS + GAS_OVERHEAD_TGAS) * TGAS;
        let sign_gas = available
            .saturating_sub(reserve)
            .min(MAX_GAS_FOR_SIGN_TGAS * TGAS);
        assert!(
            sign_gas >= MIN_GAS_FOR_SIGN_TGAS * TGAS,
            "not enough gas attached: attach 300 TGas to request_signature"
        );
        let callback = Promise::new(env::current_account_id()).function_call(
            "on_signature_ready".to_string(),
            serde_json::to_vec(&json!({})).expect("empty args"),
            NearToken::from_yoctonear(0),
            Gas::from_gas(GAS_FOR_CALLBACK_TGAS * TGAS),
        );
        Promise::new(MPC_SIGNER.parse().expect("valid signer account"))
            .function_call(
                "sign".to_string(),
                serde_json::to_vec(&args).expect("signer args"),
                NearToken::from_yoctonear(SIGN_DEPOSIT_YOCTO),
                Gas::from_gas(sign_gas),
            )
            .then(callback)
    }

    /// Callback for the signer promise. Returns the MPC signature (the
    /// `SignResult` JSON: `big_r.affine_point`, `s.scalar`, `recovery_id`)
    /// unchanged, so the caller can turn it into r/s/v exactly like
    /// chainsig.js `toRSV` does. Private: only this contract can call it.
    #[private]
    pub fn on_signature_ready(&self) -> Value {
        let bytes = match env::promise_result_checked(0, MAX_SIGNATURE_RESULT_BYTES) {
            Ok(bytes) => bytes,
            Err(_) => {
                env::panic_str("MPC signature request failed or returned an oversized result")
            }
        };
        let value: Value =
            serde_json::from_slice(&bytes).expect("MPC signer returned non-JSON");
        assert!(
            valid_signature_shape(&value),
            "unexpected MPC signature shape"
        );
        value
    }
}

/// Wei approved today (UTC day) for `agent_path`.
fn spent_today(actions: &[ActionRecord], agent_path: &str, now_ms: u64) -> u128 {
    let day_start = now_ms - now_ms % DAY_MS;
    actions
        .iter()
        .filter(|a| a.agent_path == agent_path && a.timestamp_ms >= day_start)
        .map(|a| a.amount_wei.parse::<u128>().unwrap_or(0))
        .fold(0u128, |acc, x| acc.saturating_add(x))
}

/// The policy check. Panics with a specific reason on the first violation;
/// the panic message is what the caller sees in the failed receipt.
fn check_policy(
    policy: &Policy,
    actions: &[ActionRecord],
    now_ms: u64,
    target: &str,
    amount_wei: &str,
    payload_hex: &str,
) {
    assert!(policy.active, "policy is not active");
    assert!(
        valid_payload_hex(payload_hex),
        "payload_hex must be 64 hex characters (32-byte hash)"
    );
    let amount: u128 = amount_wei
        .parse()
        .expect("amount_wei must be a decimal integer string");
    let per_tx: u128 = policy
        .per_tx_cap_wei
        .parse()
        .expect("stored per_tx_cap_wei is not a decimal integer");
    let daily: u128 = policy
        .daily_cap_wei
        .parse()
        .expect("stored daily_cap_wei is not a decimal integer");
    assert!(amount <= per_tx, "amount exceeds per-tx cap");
    let spent = spent_today(actions, &policy.agent_path, now_ms);
    assert!(
        spent.saturating_add(amount) <= daily,
        "amount would exceed daily cap"
    );
    let target_lc = target.to_lowercase();
    assert!(
        policy
            .allowed_targets
            .iter()
            .any(|t| t.to_lowercase() == target_lc),
        "target is not in allowed_targets"
    );
}

fn valid_payload_hex(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Accepts both signature shapes chainsig.js `toRSV` accepts: the object
/// form (`big_r.affine_point`, `s.scalar`) and the flat string form.
fn valid_signature_shape(v: &Value) -> bool {
    let object_form = v
        .get("big_r")
        .and_then(|b| b.get("affine_point"))
        .and_then(|a| a.as_str())
        .is_some()
        && v.get("s")
            .and_then(|s| s.get("scalar"))
            .and_then(|x| x.as_str())
            .is_some();
    let flat_form = v.get("big_r").and_then(|b| b.as_str()).is_some()
        && v.get("s").and_then(|s| s.as_str()).is_some();
    (object_form || flat_form) && v.get("recovery_id").and_then(|r| r.as_u64()).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, VMContext};

    const DAY_1_START: u64 = 1_793_721_600_000; // 2026-11-03 00:00:00 UTC in ms
    const NOON_DAY_1: u64 = DAY_1_START + 43_200_000;

    fn policy() -> Policy {
        Policy {
            agent_path: "bsc,1".to_string(),
            per_tx_cap_wei: "10000000000000000".to_string(),
            daily_cap_wei: "25000000000000000".to_string(),
            allowed_targets: vec!["0xaE39D8017CD26d188593bDD55a706cC6ab412D9e".to_string()],
            active: true,
        }
    }

    fn action(amount: &str, ts: u64) -> ActionRecord {
        ActionRecord {
            agent_path: "bsc,1".to_string(),
            target: "0xaE39D8017CD26d188593bDD55a706cC6ab412D9e".to_string(),
            amount_wei: amount.to_string(),
            tx_hash: "00".repeat(32),
            timestamp_ms: ts,
        }
    }

    fn context(predecessor: AccountId) -> VMContext {
        VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(predecessor)
            .block_timestamp(NOON_DAY_1 * 1_000_000)
            // The mock charges gas for promise actions when the returned
            // Promise is dropped, so the test context prepays a realistic
            // 300 TGas like a real transaction.
            .prepaid_gas(Gas::from_tgas(300))
            .build()
    }

    const PAYLOAD: &str = "64d556d88b41d503bc0a01ad581a8a0e519781ab927aeb3589945d7c73d71dd4";
    const TARGET: &str = "0xaE39D8017CD26d188593bDD55a706cC6ab412D9e";

    #[test]
    fn valid_request_passes() {
        check_policy(&policy(), &[], NOON_DAY_1, TARGET, "1000000000000000", PAYLOAD);
    }

    #[test]
    #[should_panic(expected = "policy is not active")]
    fn inactive_policy_rejects() {
        let mut p = policy();
        p.active = false;
        check_policy(&p, &[], NOON_DAY_1, TARGET, "1000000000000000", PAYLOAD);
    }

    #[test]
    #[should_panic(expected = "exceeds per-tx cap")]
    fn over_tx_cap_rejects() {
        check_policy(&policy(), &[], NOON_DAY_1, TARGET, "20000000000000000", PAYLOAD);
    }

    #[test]
    #[should_panic(expected = "would exceed daily cap")]
    fn over_daily_cap_rejects() {
        let prior = vec![action("24000000000000000", NOON_DAY_1)];
        check_policy(&policy(), &prior, NOON_DAY_1, TARGET, "2000000000000000", PAYLOAD);
    }

    #[test]
    fn yesterday_spend_does_not_count() {
        let prior = vec![action("25000000000000000", DAY_1_START - 1)];
        check_policy(&policy(), &prior, NOON_DAY_1, TARGET, "1000000000000000", PAYLOAD);
    }

    #[test]
    #[should_panic(expected = "not in allowed_targets")]
    fn unknown_target_rejects() {
        check_policy(
            &policy(),
            &[],
            NOON_DAY_1,
            "0x1111111111111111111111111111111111111111",
            "1000000000000000",
            PAYLOAD,
        );
    }

    #[test]
    fn allowlist_is_case_insensitive() {
        check_policy(
            &policy(),
            &[],
            NOON_DAY_1,
            "0xae39d8017cd26d188593bdd55a706cc6ab412d9e",
            "1000000000000000",
            PAYLOAD,
        );
    }

    #[test]
    #[should_panic(expected = "64 hex characters")]
    fn bad_payload_rejects() {
        check_policy(&policy(), &[], NOON_DAY_1, TARGET, "1000000000000000", "zz");
    }

    #[test]
    #[should_panic(expected = "decimal integer")]
    fn bad_amount_rejects() {
        check_policy(&policy(), &[], NOON_DAY_1, TARGET, "one tbnb", PAYLOAD);
    }

    #[test]
    fn spent_today_sums_only_today_and_path() {
        let actions = vec![
            action("1000000000000000", NOON_DAY_1),
            action("2000000000000000", NOON_DAY_1),
            action("9000000000000000", DAY_1_START - 1),
            ActionRecord {
                agent_path: "other,1".to_string(),
                ..action("7000000000000000", NOON_DAY_1)
            },
        ];
        assert_eq!(spent_today(&actions, "bsc,1", NOON_DAY_1), 3_000_000_000_000_000);
    }

    #[test]
    fn signature_shape_object_and_flat_forms() {
        let object: Value =
            serde_json::from_str(r#"{"big_r":{"affine_point":"04ab"},"s":{"scalar":"cd"},"recovery_id":0}"#)
                .unwrap();
        assert!(valid_signature_shape(&object));
        let flat: Value =
            serde_json::from_str(r#"{"big_r":"04ab","s":"cd","recovery_id":1}"#).unwrap();
        assert!(valid_signature_shape(&flat));
        let missing: Value = serde_json::from_str(r#"{"big_r":{"affine_point":"04ab"}}"#).unwrap();
        assert!(!valid_signature_shape(&missing));
    }

    #[test]
    #[should_panic(expected = "owner-only")]
    fn request_signature_rejects_non_owner() {
        testing_env!(context(accounts(1)));
        let mut c = Contract::init(accounts(0));
        c.request_signature(TARGET.to_string(), "1000000000000000".to_string(), PAYLOAD.to_string());
    }

    #[test]
    fn request_signature_records_before_signing() {
        testing_env!(context(accounts(0)));
        let mut c = Contract::init(accounts(0));
        c.set_policy(
            "bsc,1".to_string(),
            "10000000000000000".to_string(),
            "25000000000000000".to_string(),
            vec![TARGET.to_string()],
            true,
        );
        // The Promise is constructed (and its gas charged) when dropped,
        // so drop it in its own scope before the view call below, the way
        // the runtime drops the returned promise at the end of the call.
        {
            let _promise = c.request_signature(
                TARGET.to_string(),
                "1000000000000000".to_string(),
                PAYLOAD.to_string(),
            );
        }
        assert_eq!(c.actions.len(), 1);
        assert_eq!(c.actions[0].tx_hash, PAYLOAD);
        assert_eq!(c.get_spent_today(), "1000000000000000");
    }
}
