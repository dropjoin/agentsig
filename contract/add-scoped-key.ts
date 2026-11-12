/**
 * Create the scoped key the AgentSig runtime must run with (TESTNET ONLY).
 *
 * Generates a fresh ed25519 keypair, adds its public key to the agent
 * account as a FUNCTION-CALL key (receiver = the policy contract, method
 * = `request_signature` only, allowance 1 NEAR), and writes the new
 * private key to agent/.env.agent. The runtime prefers .env.agent over
 * .env; the full-access key stays in .env for deploys and policy changes
 * only, and is never used by the runtime again.
 *
 * The private key is NEVER printed: it goes straight into the gitignored
 * file. Aborts if agent/.env.agent already exists, so a live scoped key
 * is never silently overwritten; delete that file to rotate.
 *
 * Run from this folder:
 *   npx tsx add-scoped-key.ts
 * Credentials are read from ../agent/.env (the full-access key, used once
 * here to add the scoped key).
 */
import * as fs from "node:fs";
import { KeyPair } from "@near-js/crypto";
import { actionCreators } from "@near-js/transactions";
import { loadEnvFile, NearClient } from "../agent/near.js";

const env = loadEnvFile(new URL("../agent/.env", import.meta.url).pathname);
const accountId = env.NEAR_ACCOUNT_ID;
const privateKey = env.NEAR_PRIVATE_KEY;
if (!accountId || !privateKey) throw new Error("NEAR_ACCOUNT_ID / NEAR_PRIVATE_KEY missing in agent/.env");

const POLICY_CONTRACT = env.POLICY_CONTRACT_ID ?? `policy.${accountId}`;
const OUT_PATH = new URL("../agent/.env.agent", import.meta.url).pathname;
if (fs.existsSync(OUT_PATH)) {
  throw new Error(
    "agent/.env.agent already exists; delete it to rotate to a new scoped key " +
      "(and remove the old key from the account afterwards).",
  );
}

const scoped = KeyPair.fromRandom("ed25519");
const near = new NearClient(accountId, privateKey);
const { txHash } = await near.sendActions(accountId, [
  actionCreators.addKey(
    scoped.getPublicKey(),
    actionCreators.functionCallAccessKey(
      POLICY_CONTRACT,
      ["request_signature"],
      1_000_000_000_000_000_000_000_000n, // 1 NEAR allowance
    ),
  ),
]);
console.log("ADD-KEY TX:", txHash);
console.log("Scoped public key:", scoped.getPublicKey().toString());

fs.writeFileSync(
  OUT_PATH,
  `# Scoped runtime key for the AgentSig agent (function-call only: ` +
    `request_signature on ${POLICY_CONTRACT}).\n` +
    `# Written by contract/add-scoped-key.ts. NEVER commit this file.\n` +
    `NEAR_ACCOUNT_ID=${accountId}\n` +
    `NEAR_PRIVATE_KEY=${scoped.toString()}\n` +
    `POLICY_CONTRACT_ID=${POLICY_CONTRACT}\n`,
  { mode: 0o600 },
);
console.log("Wrote agent/.env.agent (mode 600). The runtime will use it automatically.");
console.log("Keep agent/.env (full-access) for deploys and set_policy only.");
