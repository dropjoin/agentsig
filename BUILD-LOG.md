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
