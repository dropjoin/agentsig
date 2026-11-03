/**
 * AgentSig agent runtime v1 (TESTNET ONLY).
 *
 * Flow:
 *  1. Read the spending policy from the AgentSig policy contract on NEAR testnet.
 *  2. Evaluate demo tasks against the policy LOCALLY. A violating task is
 *     rejected before any signature is requested (no MPC call is made for it).
 *  3. For the passing task, request an MPC signature via NEAR Chain
 *     Signatures (spike approach), assemble the signed BSC testnet tx, and
 *     broadcast it if the derived address holds enough tBNB; otherwise save
 *     the signed tx and report that broadcast is pending funding.
 *  4. Record the executed action on the NEAR policy contract.
 */
import * as fs from "node:fs";
import { chainAdapters, contracts } from "chainsig.js";
import { createPublicClient, http, keccak256, serializeTransaction, toBytes, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { loadEnvFile, NearClient } from "./near.js";

// ---------- config ----------
const env = loadEnvFile(new URL("./.env", import.meta.url).pathname);
const accountId = env.NEAR_ACCOUNT_ID;
const privateKey = env.NEAR_PRIVATE_KEY;
const POLICY_CONTRACT = env.POLICY_CONTRACT_ID;
if (!accountId || !privateKey) throw new Error("NEAR_ACCOUNT_ID / NEAR_PRIVATE_KEY missing in agent/.env");
if (!POLICY_CONTRACT) throw new Error("POLICY_CONTRACT_ID missing in agent/.env (run the contract deploy first)");

const MPC_CONTRACT = "v1.signer-prod.testnet";
const EXPECTED_DERIVED = "0xaE39D8017CD26d188593bDD55a706cC6ab412D9e";

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

// ---------- Chain Signatures ----------
const csContract = new contracts.ChainSignatureContract({
  networkId: "testnet",
  contractId: MPC_CONTRACT,
  fallbackRpcUrls: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"],
} as any);
const evm = new chainAdapters.evm.EVM({ publicClient: publicClient as any, contract: csContract });
const signerAccount = near.chainsigSignerAccount();

const { address: derivedAddress } = await evm.deriveAddressAndPublicKey(accountId, policy.agent_path);
console.log("Derived EVM address:", derivedAddress, "| matches spike:", derivedAddress === EXPECTED_DERIVED);
const bal = await evm.getBalance(derivedAddress);
console.log("Derived address tBNB balance (wei):", bal.balance.toString());

// ---------- policy enforcement (local, pre-signature) ----------
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
    console.log(`POLICY PASS: "${task.label}" -> ${task.to} ${task.valueWei} wei`);
    passing = passing ?? task;
  } else {
    console.log(`POLICY REJECT: "${task.label}" -> ${task.to} ${task.valueWei} wei | reasons: ${verdict.reasons.join("; ")}`);
  }
}
if (!passing) throw new Error("No task passed the policy; nothing to execute");

// ---------- execute the passing task via MPC ----------
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

const t0 = Date.now();
const rsvSignatures = await csContract.sign({
  payloads: hashesToSign,
  path: policy.agent_path,
  keyType: "Ecdsa",
  signerAccount,
});
console.log(`MPC signature received in ${Date.now() - t0} ms`);

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

// ---------- record the action on NEAR ----------
const { txHash: recordTxHash } = await near.functionCall(POLICY_CONTRACT, "record_action", {
  agent_path: policy.agent_path,
  target: passing.to,
  amount_wei: passing.valueWei.toString(),
  tx_hash: broadcastHash ?? bscTxHash,
});
console.log("record_action NEAR tx:", recordTxHash);

const actionsAfter: any[] = await near.viewFunction(POLICY_CONTRACT, "get_actions", { limit: 100 });
console.log("Actions on policy contract now:", JSON.stringify(actionsAfter));
console.log("AGENT RUN DONE");
