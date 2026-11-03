# AgentSig — give your agent a wallet, not your keys

**Built for the NEAR Hackathon 2026 — Build Beyond Boundaries** (tracks: Agents, Security, Business).

## The problem

An AI agent that can pay, mint, or trade needs a wallet. Handing it a private key means one prompt injection, one leaked log, or one buggy loop can drain everything. Custodial accounts just move the trust to a company.

## The product

AgentSig gives the agent a **keyless wallet governed by an on-chain policy**:

- The agent's EVM address is **derived from NEAR Chain Signatures** (path `bsc,1`). The key is split across the NEAR MPC network — **no private key exists anywhere**, so there is nothing to leak.
- A **policy contract on NEAR** (Rust, near-sdk) stores the hard rules: per-transaction cap, daily cap, an allowlist of target addresses, and an active flag. Only the owner can change them.
- The agent runtime reads the policy from chain before every task. A task outside the rules is **rejected locally before any signature is requested**. A passing task is signed by the MPC network and the action is written back to the policy contract as an on-chain audit record.

Think of it as a spending policy enforced by two chains: NEAR decides what is allowed, the MPC network holds the pen, BSC is where the agent acts.

## Live on testnet (do this, see that)

| Piece | Where |
|---|---|
| Policy contract | `policy.agentsigspike1103.testnet` — [NearBlocks](https://testnet.nearblocks.io/address/policy.agentsigspike1103.testnet) |
| Deploy tx | `4prGuK6yd7LJxx4dMA3JHRxrcQkbpTrUU2mEbUkWzgun` |
| Agent NEAR account | `agentsigspike1103.testnet` |
| Derived EVM address (BSC) | `0xaE39D8017CD26d188593bDD55a706cC6ab412D9e` — [BscScan testnet](https://testnet.bscscan.com/address/0xaE39D8017CD26d188593bDD55a706cC6ab412D9e) |
| Stored policy | per-tx cap 0.01 BNB, daily cap 0.025 BNB, one allowlisted target, active |
| Dashboard | open `dashboard/index.html` — reads the policy and the action log live from the contract |

Run the demo yourself:

1. **Policy + runtime:** `cd agent && npm install && cp .env.example .env` (fill in a throwaway NEAR testnet account), then `npx tsx agent.ts`. You will see, in order: the policy fetched from chain, a 0.001 tBNB task **PASS**, a 0.02 tBNB task **REJECTED** (`exceeds per-tx cap`) with no signature requested, then an MPC signature for the passing task.
2. **Verify the signature offline:** `npx tsx verify.ts` — recovers the sender from the signed BSC transaction and checks it equals the derived address.
3. **Contract:** `cd contract && cargo build --target wasm32-unknown-unknown --release`, deploy with `npx tsx deploy.ts` (creates a subaccount, deploys, inits, sets the demo policy).

Full evidence, tx hashes, and reproduction notes: [BUILD-LOG.md](BUILD-LOG.md).

## Status and honest limits

- Everything above is proven on testnet: policy enforcement, MPC signing, signature recovery, and the on-chain audit record (`record_action` tx `DqY1T7irizp6Tvgbg2NFtVBYNqD6adLtyKarZrXZvfn9`).
- One step is pending a human-gated faucet: the derived address holds 0 tBNB, so the signed demo transaction (hash `0x64d556d88b41d503bc0a01ad581a8a0e519781ab927aeb3589945d7c73d71dd4`) has not been broadcast yet. Funding it with ~0.001 tBNB makes the saved signed transaction broadcastable as-is.
- Roadmap: daily-cap accounting inside the contract (currently read + enforced by the runtime), more target chains via other derivation paths, and a hosted dashboard.

## Layout

- `contract/` — the NEAR policy contract (Rust) + deploy script
- `agent/` — the agent runtime (TypeScript): policy check → Chain Signatures → BSC tx → audit record
- `dashboard/` — a static page that renders the live policy and action log from the contract

## License

MIT
