/**
 * Redeploy the AgentSig policy contract v2 to the EXISTING subaccount
 * (TESTNET ONLY). The v2 state layout is identical to v1, so this deploys
 * the new wasm over the old contract in place: the stored policy and the
 * action log survive. No `init` call (it would panic on existing state).
 *
 * After the deploy it derives the NEW EVM address (v2 signs from the
 * contract account, so the predecessor changed and the address with it)
 * and re-points the demo policy at it.
 *
 * Run from this folder (after building the wasm):
 *   cargo build --target wasm32-unknown-unknown --release
 *   npx tsx redeploy.ts
 * Credentials are read from ../agent/.env (the deployer's full-access key).
 */
import * as fs from "node:fs";
import { actionCreators } from "@near-js/transactions";
import { contracts } from "chainsig.js";
import { getAddress, keccak256 } from "viem";
import { loadEnvFile, NearClient } from "../agent/near.js";

const env = loadEnvFile(new URL("../agent/.env", import.meta.url).pathname);
const accountId = env.NEAR_ACCOUNT_ID;
const privateKey = env.NEAR_PRIVATE_KEY;
if (!accountId || !privateKey) throw new Error("NEAR_ACCOUNT_ID / NEAR_PRIVATE_KEY missing in agent/.env");

const SUBACCOUNT = env.POLICY_CONTRACT_ID ?? `policy.${accountId}`;
const WASM_PATH = new URL("./target/wasm32-unknown-unknown/release/agentsig_policy.wasm", import.meta.url).pathname;
const AGENT_PATH = "bsc,1";

const near = new NearClient(accountId, privateKey);
console.log("Deployer account:", accountId);
console.log("Target contract:", SUBACCOUNT);
// deployContract must be signed BY the contract account itself: a tx from
// the parent account gets ActorNoPermission. The subaccount holds the same
// keypair as a full-access key (v1 deploy convenience, see BUILD-LOG §4),
// so the deploy is signed as the subaccount with the same key. set_policy
// below still goes through the parent client: the policy owner is the
// parent account, and the contract checks predecessor == owner.
const sub = new NearClient(SUBACCOUNT, privateKey);

// Abort unless the contract account already exists (fresh deploys use deploy.ts).
try {
  await near.provider.query({ request_type: "view_account", finality: "final", account_id: SUBACCOUNT } as any);
} catch {
  throw new Error(`Contract account ${SUBACCOUNT} does not exist; use deploy.ts for a fresh deploy.`);
}

const wasm = fs.readFileSync(WASM_PATH);
console.log("Wasm size (bytes):", wasm.length);

// Deploy only: state is preserved, and `init` must NOT be called again.
const { txHash: deployTx } = await sub.sendActions(SUBACCOUNT, [
  actionCreators.deployContract(new Uint8Array(wasm)),
]);
console.log("REDEPLOY TX:", deployTx);

// The v2 derived address: predecessor is now the CONTRACT account.
const csContract = new contracts.ChainSignatureContract({
  networkId: "testnet",
  contractId: "v1.signer-prod.testnet",
} as any);
const pubkey: string = await csContract.getDerivedPublicKey({ path: AGENT_PATH, predecessor: SUBACCOUNT });
const stripped = pubkey.startsWith("04") ? pubkey.slice(2) : pubkey;
const derivedAddress = getAddress(`0x${keccak256(Buffer.from(stripped, "hex")).slice(-40)}`);
console.log("New derived EVM address (contract + path):", derivedAddress);

// Re-point the demo policy at the new address (same caps as v1).
const { txHash: policyTx } = await near.functionCall(SUBACCOUNT, "set_policy", {
  agent_path: AGENT_PATH,
  per_tx_cap_wei: "10000000000000000",
  daily_cap_wei: "25000000000000000",
  allowed_targets: [derivedAddress],
  active: true,
});
console.log("SET_POLICY TX:", policyTx);

// Proof via view calls. get_actions must still show the v1 record:
// state compatibility is the whole point of the in-place redeploy.
const policy = await near.viewFunction(SUBACCOUNT, "get_policy");
console.log("get_policy ->", JSON.stringify(policy));
const actionsLog = await near.viewFunction(SUBACCOUNT, "get_actions", { limit: 20 });
console.log("get_actions ->", JSON.stringify(actionsLog));
console.log("Contract balance (NEAR):", Number(await near.balanceYocto(SUBACCOUNT)) / 1e24);
console.log("REDEPLOY DONE.");
console.log(`Fund the NEW derived address ${derivedAddress} with ~0.001 tBNB to allow a broadcast,`);
console.log("then run the agent with its scoped key (see add-scoped-key.ts + agent/.env.agent).");
