/**
 * Deploy the AgentSig policy contract to NEAR testnet (TESTNET ONLY).
 *
 * Creates the subaccount `policy.<agent account>` and, in ONE transaction,
 * funds it, adds the parent account's key (full access, throwaway dev setup),
 * deploys the wasm, and calls init(owner = agent account). Then sets the demo
 * policy and proves the deployment with view calls.
 *
 * Run from this folder:  npx tsx deploy.ts
 * Credentials are read from ../agent/.env (the spike's throwaway account).
 */
import * as fs from "node:fs";
import { actionCreators } from "@near-js/transactions";
import { loadEnvFile, NearClient, retry } from "../agent/near.js";

const env = loadEnvFile(new URL("../agent/.env", import.meta.url).pathname);
const accountId = env.NEAR_ACCOUNT_ID;
const privateKey = env.NEAR_PRIVATE_KEY;
if (!accountId || !privateKey) throw new Error("NEAR_ACCOUNT_ID / NEAR_PRIVATE_KEY missing in agent/.env");

const SUBACCOUNT = `policy.${accountId}`;
const WASM_PATH = new URL("./target/wasm32-unknown-unknown/release/agentsig_policy.wasm", import.meta.url).pathname;
const DERIVED_EVM = "0xaE39D8017CD26d188593bDD55a706cC6ab412D9e";
const FUND_NEAR = 3_000_000_000_000_000_000_000_000n; // 3 NEAR

const near = new NearClient(accountId, privateKey);
console.log("Deployer (parent) account:", accountId);
console.log("Target subaccount:", SUBACCOUNT);
console.log("Parent balance (NEAR):", Number(await near.balanceYocto()) / 1e24);

// Abort if the subaccount already exists (createAccount would fail the tx).
let exists = true;
try {
  await retry("view subaccount", () =>
    near.provider.query({ request_type: "view_account", finality: "final", account_id: SUBACCOUNT } as any),
  );
} catch {
  exists = false;
}
if (exists) throw new Error(`Subaccount ${SUBACCOUNT} already exists; aborting deploy.`);

const wasm = fs.readFileSync(WASM_PATH);
console.log("Wasm size (bytes):", wasm.length);

const actions = [
  actionCreators.createAccount(),
  actionCreators.transfer(FUND_NEAR),
  actionCreators.addKey(near.publicKey, actionCreators.fullAccessKey()),
  actionCreators.deployContract(new Uint8Array(wasm)),
  actionCreators.functionCall("init", { owner: accountId }, 30_000_000_000_000n, 0n),
];
const { txHash: deployTx } = await near.sendActions(SUBACCOUNT, actions);
console.log("DEPLOY TX:", deployTx);

// Demo policy: per-tx 0.01 BNB, daily 0.025 BNB, target = the derived EVM address itself.
const { txHash: policyTx } = await near.functionCall(SUBACCOUNT, "set_policy", {
  agent_path: "bsc,1",
  per_tx_cap_wei: "10000000000000000",
  daily_cap_wei: "25000000000000000",
  allowed_targets: [DERIVED_EVM],
  active: true,
});
console.log("SET_POLICY TX:", policyTx);

// Proof via view calls.
const policy = await near.viewFunction(SUBACCOUNT, "get_policy");
console.log("get_policy ->", JSON.stringify(policy));
const actionsLog = await near.viewFunction(SUBACCOUNT, "get_actions", { limit: 20 });
console.log("get_actions ->", JSON.stringify(actionsLog));
console.log("Subaccount balance (NEAR):", Number(await near.balanceYocto(SUBACCOUNT)) / 1e24);

// Point the agent runtime at this contract.
const envPath = new URL("../agent/.env", import.meta.url).pathname;
const envText = fs.readFileSync(envPath, "utf8");
if (!envText.includes("POLICY_CONTRACT_ID=")) {
  fs.appendFileSync(envPath, `POLICY_CONTRACT_ID=${SUBACCOUNT}\n`);
  console.log("Appended POLICY_CONTRACT_ID to agent/.env");
}
console.log("DEPLOY DONE:", SUBACCOUNT);
