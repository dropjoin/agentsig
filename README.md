# AgentSig — give your agent a wallet, not your keys

**Built for the NEAR Hackathon 2026 — Build Beyond Boundaries** (tracks: Agents, Security, Business).

## The problem

An AI agent that can pay, mint, or trade needs a wallet. Handing it a private key means one prompt injection, one leaked log, or one buggy loop can drain everything. Custodial accounts just move the trust to a company.

## The product

AgentSig gives the agent a **keyless wallet governed by an on-chain policy**:

- The agent's EVM address is **derived from NEAR Chain Signatures** (path `bsc,1`). The key is split across the NEAR MPC network — **no private key exists anywhere**, so there is nothing to leak.
- A **policy contract on NEAR** (Rust, near-sdk) stores the hard rules: per-transaction cap, daily cap, an allowlist of target addresses, and an active flag. Only the owner can change them.
- The contract is the **only path to a signature**: the agent asks the contract, the contract enforces the policy **on chain**, records the approved request, and only then calls the MPC signer. The derived address belongs to (contract account, derivation path), so bypassing the contract cannot produce a signature for it. The agent never calls the signer directly.
- The agent runtime runs with a **function-call key scoped to the policy contract** (`request_signature` only). It cannot change the policy, add keys, or touch the NEAR account — and the runtime refuses to start with a full-access key.

Think of it as a spending policy enforced by two chains: NEAR decides what is allowed, the MPC network holds the pen, BSC is where the agent acts.

## Security fix (v2, 12 Nov 2026) — deployed and proven on testnet

v1 stored the policy on chain but enforced it only in the off-chain runtime: the agent called the MPC signer directly, so anyone holding the agent's NEAR key could skip the policy entirely. That hole was found in review, and v2 closes it with the gateway design above, plus the scoped-key requirement. v2 was deployed in place on 12 Nov 2026 (redeploy tx `FdrDEpKiW3daTnD5RMZuL4HkpczDge6uiM81BF45hLqF`, wasm 175,365 bytes) and the gateway run is proven: `request_signature` tx `A8yaNThCjRPdgxY8NzLjRpJH3x4F6tb49yWYL828f6a2`, MPC signature in 7.8 s, signed BSC tx hash `0xd02ff2c9ead0e72a54d20976f291594dda5e54aa40dfc95aab6902b08f6cf0a0`, offline sender recovery MATCHED the new derived address. The redeploy changed the derived EVM address (the predecessor is now the contract account): the current address is `0x47dDd9816DB0A5B80CD6a6CE0Fa714f098eC631A`, and the v1 address `0xaE39D8017CD26d188593bDD55a706cC6ab412D9e` is superseded.

The remaining trust assumption is NEAR's MPC threshold itself: reconstructing a key needs a threshold of MPC nodes colluding (11 of 16 independent operators as of October 2026, all running in Intel TDX enclaves that don't let an operator read its own share). That assumption is shared by every Chain Signatures app; AgentSig removes the key from the agent and puts the policy on chain around it.

## Live on testnet (do this, see that)

| Piece | Where |
|---|---|
| Policy contract | `policy.agentsigspike1103.testnet` — [NearBlocks](https://testnet.nearblocks.io/address/policy.agentsigspike1103.testnet) |
| v1 deploy tx | `4prGuK6yd7LJxx4dMA3JHRxrcQkbpTrUU2mEbUkWzgun` |
| v2 redeploy tx | `FdrDEpKiW3daTnD5RMZuL4HkpczDge6uiM81BF45hLqF` (12 Nov 2026) |
| Agent NEAR account | `agentsigspike1103.testnet` |
| Derived EVM address (BSC, v2) | `0x47dDd9816DB0A5B80CD6a6CE0Fa714f098eC631A` — [BscScan testnet](https://testnet.bscscan.com/address/0x47dDd9816DB0A5B80CD6a6CE0Fa714f098eC631A) |
| Stored policy | per-tx cap 0.01 BNB, daily cap 0.025 BNB, one allowlisted target (the derived address itself), active |
| Dashboard | open `dashboard/index.html` — reads the policy and the action log live from the contract |

Run the demo yourself (v2 code):

1. **Contract:** `cd contract && cargo build --target wasm32-unknown-unknown --release`, then `npx tsx deploy.ts` for a fresh deploy (creates a subaccount, deploys, inits, sets the demo policy) or `npx tsx redeploy.ts` to upgrade the existing contract in place.
2. **Scoped key:** `cd contract && npx tsx add-scoped-key.ts` — writes `agent/.env.agent` with a function-call key scoped to the policy contract. The runtime refuses full-access keys.
3. **Agent:** `cd agent && npm install`, fill in `agent/.env` (full-access key, deployer only), then `npx tsx agent.ts`. You will see, in order: the key check, the policy fetched from chain, a 0.001 tBNB task **PASS**, a 0.02 tBNB task **REJECTED** (`exceeds per-tx cap`) with no signature requested, then a signature requested **through the policy contract** for the passing task.
4. **Verify the signature offline:** `npx tsx verify.ts` — recovers the sender from the signed BSC transaction and checks it equals the derived address.

Full evidence, tx hashes, and reproduction notes: [BUILD-LOG.md](BUILD-LOG.md).

## Status and honest limits

- Proven on testnet (v1 run): policy read from chain, MPC signing, signature recovery, and the on-chain audit record (`record_action` tx `DqY1T7irizp6Tvgbg2NFtVBYNqD6adLtyKarZrXZvfn9`).
- Proven on testnet (v2 run, 12 Nov 2026): the gateway enforces the policy on chain and returns the MPC signature through the contract callback (`request_signature` tx `A8yaNThCjRPdgxY8NzLjRpJH3x4F6tb49yWYL828f6a2`); the scoped-key check passed; the contract recorded the approved request and `get_spent_today` counted it; offline sender recovery MATCHED the new derived address.
- One step is pending a human-gated faucet: the new derived address holds 0 tBNB, so the signed demo transaction (hash `0xd02ff2c9ead0e72a54d20976f291594dda5e54aa40dfc95aab6902b08f6cf0a0`) has not been broadcast yet. Funding it with ~0.001 tBNB makes the saved signed transaction broadcastable as-is.
- Roadmap: more target chains via other derivation paths, a hosted dashboard, and a watcher that flags any spend from the derived address with no matching on-chain approval.

## Layout

- `contract/` — the NEAR policy contract (Rust) + deploy / redeploy / scoped-key scripts
- `agent/` — the agent runtime (TypeScript): key check → policy read → contract-gated signature → BSC tx → on-chain log read-back
- `dashboard/` — a static page that renders the live policy and action log from the contract

## License

MIT
