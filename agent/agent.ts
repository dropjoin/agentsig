/**
 * AgentSig agent runtime v2 (TESTNET ONLY).
 *
 * Flow:
 *  1. Refuse to start unless the NEAR key in .env is a function-call key
 *     scoped to the policy contract (method `request_signature` only).
 *     A full-access key is never accepted: a compromised runtime must not
 *     be able to change the policy, add keys, or drain the NEAR account.
 *  2. Read the spending policy from the AgentSig policy contract on NEAR
 *     testnet.
 *  3. Evaluate demo tasks against the policy LOCALLY as a fast fail. This
 *     is UX only: the contract re-checks everything on chain, and the
 *     on-chain check is the authoritative one.
 *  4. For the passing task, ask the POLICY CONTRACT for the signature
 *     (`request_signature`). The contract enforces the policy on chain,
 *     records the approved request, and only then calls the NEAR Chain
 *     Signatures signer. The derived EVM address belongs to (contract
 *     account, derivation path), so no signature for it exists outside
 *     this path. The agent NEVER calls the signer directly.
 *  5. Assemble the signed BSC testnet tx from the returned signature and
 *     broadcast it if the derived address holds enough tBNB; otherwise
 *     save the signed tx and report that broadcast is pending funding.
 *  6. Read back the on-chain action log the contract recorded.
 */
import * as fs from "node:fs";
import { chainAdapters, contracts } from "chainsig.js";
import { createPublicClient, http, keccak256, serializeTransaction, toBytes, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { loadEnvFile, NearClient } from "./near.js";

// ---------- config ----------
// The runtime prefers agent/.env.agent (the scoped function-call key) and
// falls back to agent/.env. Keep the full-access key in .env for deploys
// and policy changes only; the runtime refuses to run with it.
function loadAgentEnv(): { env: Record<string, string>; file: string } {
  const dir = new URL("./", import.meta.url).pathname;
  for (const name of [".env.agent", ".env"]) {
    const p = dir + name;
    if (fs.existsSync(p)) return { env: loadEnvFile(p), file: name };
  }
  throw new Error("No agent/.env.agent or agent/.env found (copy agent/.env.example to agent/.env)");
}
const { env, file: envFile } = loadAgentEnv();
console.log("Using env file:", envFile);
const accountId = env.NEAR_ACCOUNT_ID;
const privateKey = env.NEAR_PRIVATE_KEY;
const POLICY_CONTRACT = env.POLICY_CONTRACT_ID;
if (!accountId || !privateKey) throw new Error(`NEAR_ACCOUNT_ID / NEAR_PRIVATE_KEY missing in agent/${envFile}`);
if (!POLICY_CONTRACT) throw new Error(`POLICY_CONTRACT_ID missing in agent/${envFile} (run the contract deploy first)`);

const MPC_CONTRACT = "v1.signer-prod.testnet";

// ---------- BSC testnet RPC ----------
const RPC_CANDIDATES = [
  "https://data-seed-prebsc-1-s1.binance.org:8545",
  "https://bsc-testnet-rpc.publicnode.com",
  "https://data-seed-prebsc-2-s1.binance.org:8545",
];
let rpcUrl: string | undefined;
for (const u of RPC_CANDIDATES) {
  try {
    const c = createPublicClient({ chain: bscTestnet, transport: http(u, { timeout: 10_000 }) });
    if ((await c.getChainId()) === 97) { rpcUrl = u; break; }
  } catch { /* next */ }
}
if (!rpcUrl) throw new Error("No working BSC testnet RPC found");
console.log("BSC testnet RPC:", rpcUrl);
const publicClient = createPublicClient({ chain: bscTestnet, transport: http(rpcUrl) });

// ---------- NEAR + policy ----------
const near = new NearClient(accountId, privateKey);
console.log("NEAR agent account:", accountId);
console.log("Policy contract:", POLICY_CONTRACT);

// Fail closed on a full-access key before doing anything else.
await near.assertScopedKey(POLICY_CONTRACT);

const policy = await near.viewFunction(POLICY_CONTRACT, "get_policy");
if (!policy) throw new Error("No policy set on the policy contract");
console.log("Policy read from NEAR:", JSON.stringify(policy));

const recorded: any[] = (await near.viewFunction(POLICY_CONTRACT, "get_actions", { limit: 100 })) ?? [];
const startOfDay = new Date();
startOfDay.setUTCHours(0, 0, 0, 0);
const spentTodayWei = recorded
  .filter((a) => a.agent_path === policy.agent_path && Number(a.timestamp_ms) >= startOfDay.getTime())
  .reduce((sum, a) => sum + BigInt(a.amount_wei), 0n);
console.log(
  `Recorded actions for path ${policy.agent_path}: ${recorded.length} total, spent today (UTC) ${spentTodayWei} wei`,
);

// ---------- Chain Signatures (derivation + tx assembly only) ----------
// The ChainSignatureContract instance is used ONLY for view calls (derived
// public key) and tx assembly. Signing goes through the policy contract;
// `csContract.sign` must never be called here.
const csContract = new contracts.ChainSignatureContract({
  networkId: "testnet",
  contractId: MPC_CONTRACT,
  fallbackRpcUrls: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"],
} as any);
const evm = new chainAdapters.evm.EVM({ publicClient: publicClient as any, contract: csContract });

// The derived address belongs to the CONTRACT account + path: the contract
// is the account that requests signatures from the signer, so derivation
// must use its id as predecessor. (v1 derived from the agent account,
// because the agent called the signer directly.)
const { address: derivedAddress } = await evm.deriveAddressAndPublicKey(POLICY_CONTRACT, policy.agent_path);
console.log("Derived EVM address (contract account + path):", derivedAddress);
const bal = await evm.getBalance(derivedAddress);
console.log("Derived address tBNB balance (wei):", bal.balance.toString());

// ---------- policy pre-check (local fast fail; contract re-checks) ----------
interface Task { label: string; to: string; valueWei: bigint }
function evaluatePolicy(task: Task): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!policy.active) reasons.push("policy is not active");
  if (task.valueWei > BigInt(policy.per_tx_cap_wei))
    reasons.push(`amount ${task.valueWei} wei exceeds per-tx cap ${policy.per_tx_cap_wei} wei`);
  if (spentTodayWei + task.valueWei > BigInt(policy.daily_cap_wei))
    reasons.push(`amount would exceed daily cap ${policy.daily_cap_wei} wei (spent today ${spentTodayWei})`);
  const allowed = (policy.allowed_targets as string[]).map((t) => t.toLowerCase());
  if (!allowed.includes(task.to.toLowerCase()))
    reasons.push(`target ${task.to} is not in allowed_targets`);
  return { ok: reasons.length === 0, reasons };
}

const target = policy.allowed_targets[0] as string;
const tasks: Task[] = [
  { label: "demo payment within policy (0.001 tBNB)", to: target, valueWei: 1_000_000_000_000_000n },
  { label: "over-cap payment (0.02 tBNB)", to: target, valueWei: 20_000_000_000_000_000n },
];

let passing: Task | undefined;
for (const task of tasks) {
  const verdict = evaluatePolicy(task);
  if (verdict.ok) {
    console.log(`POLICY PASS (local pre-check): "${task.label}" -> ${task.to} ${task.valueWei} wei`);
    passing = passing ?? task;
  } else {
    console.log(`POLICY REJECT (local pre-check): "${task.label}" -> ${task.to} ${task.valueWei} wei | reasons: ${verdict.reasons.join("; ")}`);
  }
}
if (!passing) throw new Error("No task passed the policy; nothing to execute");

// ---------- build the unsigned tx + hash to sign ----------
console.log(`\nExecuting passing task: ${passing.label}`);
let transaction: any;
let hashesToSign: any;
try {
  const prepared = await evm.prepareTransactionForSigning({
    from: derivedAddress as Hex,
    to: passing.to as Hex,
    value: passing.valueWei,
  });
  transaction = prepared.transaction;
  hashesToSign = prepared.hashesToSign;
} catch (e) {
  // Fallback (e.g. RPC fee/gas estimation against the unfunded account):
  // build the EIP-1559 tx manually; the hash to sign is keccak256 of the
  // unsigned serialization, same as the adapter computes.
  console.log("  prepareTransactionForSigning failed, using manual build:", (e as Error).message?.slice(0, 120));
  const nonce = await publicClient.getTransactionCount({ address: derivedAddress as Hex });
  const fees = await publicClient.estimateFeesPerGas();
  transaction = {
    to: passing.to as Hex,
    value: passing.valueWei,
    nonce,
    chainId: 97,
    type: "eip1559",
    gas: 21_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  const unsigned = serializeTransaction(transaction as any);
  hashesToSign = [Array.from(toBytes(keccak256(unsigned)))];
}
const payloadHex = Buffer.from(hashesToSign[0]).toString("hex");
console.log("Signing payload (tx hash):", payloadHex);

// ---------- request the signature THROUGH the policy contract ----------
// 300 TGas: the contract forwards most of it to the signer and reserves
// 30 TGas for its callback. A policy violation fails here, inside the
// contract, before any MPC call is made.
const t0 = Date.now();
const { txHash: signTxHash, outcome } = await near.functionCall(
  POLICY_CONTRACT,
  "request_signature",
  {
    target: passing.to,
    amount_wei: passing.valueWei.toString(),
    payload_hex: payloadHex,
  },
  300_000_000_000_000n,
  0n,
);
console.log(`request_signature NEAR tx: ${signTxHash} (MPC signature received in ${Date.now() - t0} ms)`);

// The contract callback returns the MPC SignResult JSON as the final
// SuccessValue of the transaction (base64-encoded, like every NEAR
// return value). Convert it to r/s/v exactly like chainsig.js `toRSV`.
const successB64 = (outcome as any)?.status?.SuccessValue;
if (typeof successB64 !== "string" || !successB64) {
  throw new Error("request_signature returned no SuccessValue; inspect the NEAR tx outcome");
}
const mpcResult = JSON.parse(Buffer.from(successB64, "base64").toString("utf8"));
const rsvSignatures = [mpcResultToRsv(mpcResult)];

const signedTx = evm.finalizeTransactionSigning({ transaction, rsvSignatures }) as Hex;
const bscTxHash = keccak256(signedTx);
console.log("Signed BSC tx hash:", bscTxHash);

// ---------- broadcast if funded, else park the signed tx ----------
const gasCost = 21_000n * BigInt(transaction.maxFeePerGas ?? 3_000_000_000n);
let broadcastHash: string | undefined;
if (bal.balance >= passing.valueWei + gasCost) {
  const res: any = await evm.broadcastTx(signedTx as any);
  broadcastHash = res?.transactionHash ?? res?.hash ?? bscTxHash;
  console.log("BROADCAST: tx submitted, hash:", broadcastHash);
} else {
  fs.writeFileSync(
    new URL("./signed-tx.json", import.meta.url).pathname,
    JSON.stringify(
      {
        nearAccount: accountId,
        policyContract: POLICY_CONTRACT,
        path: policy.agent_path,
        derivedAddress,
        to: passing.to,
        valueWei: passing.valueWei.toString(),
        signedTx,
        txHash: bscTxHash,
        note: "Not broadcast: derived address underfunded. Fund it with ~0.001 tBNB and broadcast signedTx via eth_sendRawTransaction (valid while nonce is unchanged).",
      },
      null,
      2,
    ),
  );
  console.log(
    `BROADCAST PENDING: derived address holds ${bal.balance} wei, needs ~${passing.valueWei + gasCost} wei. ` +
      `Signed tx saved to agent/signed-tx.json — fund ${derivedAddress} with ~0.001 tBNB to broadcast.`,
  );
}

// ---------- read back the on-chain record (written by the contract) ----------
const actionsAfter: any[] = await near.viewFunction(POLICY_CONTRACT, "get_actions", { limit: 100 });
console.log("Actions on policy contract now:", JSON.stringify(actionsAfter));
const spentToday = await near.viewFunction(POLICY_CONTRACT, "get_spent_today");
console.log("Spent today per contract (wei):", spentToday);
console.log("AGENT RUN DONE");

/**
 * chainsig.js `toRSV` (cryptography utils), copied semantics: the MPC
 * `big_r.affine_point` is the R x-coordinate with a "04" prefix, `s` is
 * the scalar, and `v` is recovery_id + 27. Both the object form and the
 * flat string form of the SignResult are accepted.
 */
function mpcResultToRsv(sig: any): { r: string; s: string; v: number } {
  if (
    "big_r" in sig && typeof sig.big_r === "object" && "affine_point" in sig.big_r &&
    "s" in sig && typeof sig.s === "object" && "scalar" in sig.s
  ) {
    return { r: sig.big_r.affine_point.substring(2), s: sig.s.scalar, v: sig.recovery_id + 27 };
  }
  if ("big_r" in sig && typeof sig.big_r === "string" && "s" in sig && typeof sig.s === "string") {
    return { r: sig.big_r.substring(2), s: sig.s, v: sig.recovery_id + 27 };
  }
  throw new Error("Invalid MPC signature format");
}
