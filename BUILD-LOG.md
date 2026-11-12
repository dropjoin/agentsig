# AgentSig — Build Log (Phase 1)

**Date:** 2026-11-03 · **Scope:** TESTNET ONLY (NEAR testnet + BSC testnet chainId 97). Throwaway dev accounts only; no mainnet, no user wallets. Keys live only in `.env` files (never printed here).

## 1. Policy contract (NEAR testnet)

| Item | Value |
|---|---|
| Contract account | `policy.agentsigspike1103.testnet` (new subaccount of the spike account `agentsigspike1103.testnet`) |
| Language / SDK | Rust, near-sdk 5 (rustup stable minimal + `wasm32-unknown-unknown` target, installed for this build; plain `cargo build`, no cargo-near) |
| Source | `contract/src/lib.rs`, `contract/Cargo.toml` |
| Wasm | `contract/target/wasm32-unknown-unknown/release/agentsig_policy.wasm` (123,394 bytes) |
| Deploy tx (create account + fund 3 NEAR + add key + deploy + `init`, one tx) | `4prGuK6yd7LJxx4dMA3JHRxrcQkbpTrUU2mEbUkWzgun` |
| `set_policy` tx | `GBnu6o6o1usdsSxR1NmuG2JdPsj2uCFPJuzvjKUt3Erf` |
| Contract balance after deploy | 3 NEAR |

Demo policy stored on-chain (proven by `get_policy` view):

```json
{"agent_path":"bsc,1","per_tx_cap_wei":"10000000000000000","daily_cap_wei":"25000000000000000","allowed_targets":["0xaE39D8017CD26d188593bDD55a706cC6ab412D9e"],"active":true}
```

i.e. per-tx cap 0.01 BNB, daily cap 0.025 BNB, sole allowed target = the agent's own derived EVM address. `get_actions` initially returned `[]`.

Contract API: `init(owner)`, `set_policy(...)` owner-only, `get_policy`, `record_action(...)` (owner/contract account only), `get_actions(limit)`.

Deploy tooling: `contract/deploy.ts` (uses the shared client in `agent/near.ts`; `contract/node_modules` is a symlink to `agent/node_modules`).

## 2. Agent runtime v1 (`agent/`)

`agent/agent.ts` (shared NEAR/Chain-Signatures plumbing in `agent/near.ts`, adapted from `spike/spike.ts`). Run output is saved in `agent/run-output.log`. What the run proved, in order:

1. **Policy read from chain** — runtime fetched the exact policy above from `policy.agentsigspike1103.testnet`.
2. **Derived address** — `0xaE39D8017CD26d188593bDD55a706cC6ab412D9e` for path `bsc,1`, matching the spike exactly; balance 0 wei.
3. **POLICY PASS** — task "demo payment within policy": 0.001 tBNB (1,000,000,000,000,000 wei) to the allowlisted target passed per-tx cap, daily cap and allowlist checks.
4. **POLICY REJECT** — task "over-cap payment": 0.02 tBNB rejected locally with reason `amount 20000000000000000 wei exceeds per-tx cap 10000000000000000 wei`. No MPC signature was requested for it.
5. **MPC signature for the passing task** — NEAR sign-request tx `CKAo2Li2jMyKeKF28zku2E7M3x9FeB4QxDmDYQdafLpg` to `v1.signer-prod.testnet`; signature returned in ~26 s.
   - Note: chainsig.js's `prepareTransactionForSigning` runs a total-cost simulation that rejects value transfers from the 0-balance account, so the runtime fell back to a manual EIP-1559 build (nonce + fee data via viem, hash = keccak256 of the unsigned serialization — the same hash the adapter computes). The fallback is part of `agent.ts`.
6. **Signed BSC tx** — hash `0x64d556d88b41d503bc0a01ad581a8a0e519781ab927aeb3589945d7c73d71dd4`; offline sender recovery (`agent/verify.ts`) → recovered address == derived address, **MATCH: true**.
7. **Broadcast: PENDING (only open item)** — derived address holds 0 tBNB; the tx needs ~0.0010021 tBNB (0.001 value + ~0.0000021 gas). Signed raw tx saved in `agent/signed-tx.json`; it stays valid while the address nonce is 0. Fund `0xaE39D8017CD26d188593bDD55a706cC6ab412D9e` with ~0.001 tBNB (BSC testnet faucets are human-gated — same blocker as the spike) and either broadcast the saved raw tx via `eth_sendRawTransaction` or rerun the agent.
8. **Action recorded on NEAR** — `record_action` tx `DqY1T7irizp6Tvgbg2NFtVBYNqD6adLtyKarZrXZvfn9`; `get_actions` afterwards returned the record `{agent_path: "bsc,1", target: 0xaE39…12D9e, amount_wei: "1000000000000000", tx_hash: 0x64d5…71dd4, timestamp_ms: 1793720760368}`.

## 3. Reproduce

```bash
# Contract (already deployed; only needed for a fresh deploy)
export PATH="$HOME/.cargo/bin:$PATH"
cd ~/workspace/agentsig/contract
cargo build --target wasm32-unknown-unknown --release
npx tsx deploy.ts        # creates policy.<account>, deploys, inits, sets demo policy, prints views

# Agent runtime
cd ~/workspace/agentsig/agent
npm install
npx tsx agent.ts         # policy read -> PASS/REJECT demo -> MPC sign -> record_action
npx tsx verify.ts        # offline sender-recovery check on agent/signed-tx.json
```

Credentials: `agent/.env` holds the spike account (`NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY`) plus `POLICY_CONTRACT_ID=policy.agentsigspike1103.testnet` (appended by the deploy script). `contract/node_modules` symlinks to `agent/node_modules`.

## 4. Blockers / notes

- **Only blocker: ~0.001 tBNB for the derived address.** Everything else is proven on-chain or by cryptographic recovery. Once funded, broadcasting is a one-step rerun/send of the saved signed tx.
- NEAR testnet RPC from this VM stays flaky (`fetch failed` drops); the shared client's retry-with-backoff absorbed every failure in both the deploy and the agent run.
- The subaccount was given the parent account's key (full access) as a throwaway-dev convenience, so the spike keypair operates both accounts.

## 5. v2 security fix — policy enforcement moved on chain (2026-11-12)

### The hole (found in review, 12 Nov 2026)

v1 enforced the policy **only in the off-chain runtime**. `agent.ts` read the policy, checked caps/allowlist locally, and then called `v1.signer-prod.testnet` directly via chainsig.js. The contract's `record_action` ran AFTER execution: an audit log, not a gate. Anyone holding the agent's NEAR key (a compromised runtime, a leaked `.env`) could call the signer directly with any payload and skip the policy entirely. The agent also ran with a **full-access key** (see §4), so a compromise could change the policy, add keys, or drain the NEAR account too. The README's roadmap already flagged the first half ("daily-cap accounting inside the contract, currently read + enforced by the runtime"); review showed the whole check, not just the daily cap, was client-side.

### The fix (code complete, tested, awaiting redeploy)

- **Contract is now the signing gateway** (`contract/src/lib.rs` v0.2.0): new `request_signature(target, amount_wei, payload_hex)` enforces the full policy on chain (active flag, per-tx cap, daily cap computed from the on-chain log, case-insensitive allowlist), records the approved request BEFORE the async call (so concurrent requests cannot race the daily cap, and a failed MPC call leaves a conservative record), then calls the signer with the `payload_v2`/`Ecdsa`/`domain_id: 0` shape chainsig.js 1.1.16 uses. The `on_signature_ready` callback validates the `SignResult` shape and returns it as the tx's final result. `request_signature` is owner-only, and the public `record_action` is gone (the callback path records; audit records can no longer be forged by direct calls). New view: `get_spent_today`.
- **Derived address now belongs to the contract account + path** (the contract is the signer caller), so no signature for it exists outside the gateway path. The v1 address `0xaE39…12D9e` is superseded after the redeploy.
- **Gas budget verified against the real schedule**: the near-sdk mock charges ~5 TGas per function-call action beyond attached gas, which the first gateway draft did not reserve (its test failed with GasExceeded — a genuine on-chain bug caught by the test). The contract now forwards at most 250 TGas to the signer, reserves 20 TGas for the callback + 15 TGas overhead, and refuses the request if under 100 TGas would reach the signer. The agent attaches the maximum 300 TGas.
- **Agent runtime v2** (`agent/agent.ts`): never calls the signer directly; derives the address from the contract account; requests the signature through `request_signature` and converts the returned `SignResult` to r/s/v with the exact chainsig.js `toRSV` semantics (both object and flat forms); reads the log back instead of recording it.
- **Fail-closed key check** (`agent/near.ts` `assertScopedKey`): the runtime refuses to start unless its key is a function-call key scoped to the policy contract (`request_signature` only). Full-access keys are rejected with the fix command. The runtime prefers `agent/.env.agent` (scoped key) over `agent/.env` (full-access, deployer only).
- **Operator scripts** (`contract/`, working tree): `redeploy.ts` deploys the v2 wasm over the v1 contract in place (state layout is byte-identical, so policy + log survive; no `init`), derives the new address, and re-points the policy at it. `add-scoped-key.ts` generates a fresh keypair, adds it as a scoped function-call key (1 NEAR allowance), and writes `agent/.env.agent` (mode 600) without ever printing the private key.

### Verification (done, no keys used)

- `cargo test`: **13/13 pass** (policy checks incl. daily-cap window + case-insensitive allowlist, bad payload/amount, signature-shape validation, non-owner rejection, record-before-signing). `cargo build --target wasm32-unknown-unknown --release`: wasm 175,322 bytes. `cargo clippy`: clean.
- `tsc --noEmit` on `agent.ts`, `near.ts`, `verify.ts`: clean (one pre-existing `verify.ts` cast fixed along the way).
- NOT verified: the on-chain gateway run (needs the deployer's key + a redeploy + a scoped key + tBNB funding). That is the operator's run below; nothing here claims it happened.

### Operator run (needs the deployer's full-access key — run by hand)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd ~/workspace/agentsig/contract
cargo build --target wasm32-unknown-unknown --release
npx tsx redeploy.ts        # deploys v2 in place, derives the NEW address, re-points policy
npx tsx add-scoped-key.ts  # writes agent/.env.agent (scoped key), never prints the key
cd ../agent
npx tsx agent.ts           # key check -> policy -> gateway signature -> broadcast/park
npx tsx verify.ts          # offline sender-recovery check on agent/signed-tx.json
```

After the run: record the redeploy tx, the new derived address, and the `request_signature` tx here; update the README table and the dashboard's hardcoded address; fund the new derived address with ~0.001 tBNB (human-gated faucet) to broadcast.

### Operator run — EXECUTED 12 Nov 2026 ~21:22 WIB (throwaway testnet account only)

- First redeploy attempt FAILED, tx `C2kUfmab1rAbsVC9sRHDQz3znYKrX1BoY5jBZh9hygmb`: `ActorNoPermission` — `deployContract` must be signed BY the contract account, not the parent. Fixed in `redeploy.ts`: the deploy is signed as the subaccount with the same keypair (the subaccount holds it as full-access since v1), while `set_policy` still goes through the parent client (predecessor must equal the owner). No state changed on the failed tx.
- Redeploy SUCCEEDED, tx `FdrDEpKiW3daTnD5RMZuL4HkpczDge6uiM81BF45hLqF` (wasm 175,365 bytes). State compatibility proven: `get_actions` still returned the v1 record after the deploy.
- New derived address (contract account + `bsc,1`): `0x47dDd9816DB0A5B80CD6a6CE0Fa714f098eC631A`. `set_policy` tx `CbB7Q5mpdhdZ1Asx6tqhRYqKwkL5uZoFJa8xUswbEFv1` re-pointed the allowlist at it. Note: the `get_policy` view immediately after the tx still showed the old target (finality lag: the tx was only optimistically executed); a re-read a minute later showed the new target. Views right after a write need a finality pause.
- Scoped key created, tx `4EBKp8WEFpUPb4t9Bzauv74q27vcWUhHYNLi8MZ27fKK`, public key `ed25519:7H6xSvqyLk818cWuQDzw6W8p4Vmeq1ngyLY2jwHNbdyv`, written to `agent/.env.agent` (mode 600, never printed).
- Agent v2 run SUCCEEDED: key check OK (scoped, `request_signature` only), policy PASS/REJECT as designed, `request_signature` tx `A8yaNThCjRPdgxY8NzLjRpJH3x4F6tb49yWYL828f6a2` returned the MPC signature in 7.8 s, signed BSC tx `0xd02ff2c9ead0e72a54d20976f291594dda5e54aa40dfc95aab6902b08f6cf0a0`, contract log gained the v2 record (payload hash `92d87227…1742`), `get_spent_today` = 1,000,000,000,000,000 wei. `verify.ts`: recovered == derived address, MATCH: true.
- Still open: broadcast needs ~0.001 tBNB in the new derived address (human-gated faucet, same blocker as v1). The signed tx in `agent/signed-tx.json` stays valid while the address nonce is 0.
- BROADCAST CONFIRMED 12 Nov 2026 ~21:33 WIB: the user claimed 0.1 tBNB from the faucet to the new derived address; the saved signed tx was broadcast via `eth_sendRawTransaction` and confirmed on BSC testnet, tx `0xd02ff2c9ead0e72a54d20976f291594dda5e54aa40dfc95aab6902b08f6cf0a0`, block 142317042, status 1, gasUsed 21,000. The full v2 loop is now proven end to end: on-chain policy → MPC signature through the gateway → broadcast → confirmed.
