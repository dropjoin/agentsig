/**
 * Shared NEAR testnet client for AgentSig.
 *
 * Extracted from the feasibility spike (../spike/spike.ts): @near-js 2.5.1's
 * high-level Account helpers cannot sign with an InMemorySigner, so every
 * transaction is built with @near-js/transactions primitives, signed with
 * InMemorySigner.signMessage, broadcast via the provider, and polled with
 * short txStatus requests until the outcome carries SuccessValue/Failure
 * (MPC sign calls only reveal their signature at that point).
 * TESTNET ONLY.
 */
import * as fs from "node:fs";
import { JsonRpcProvider } from "@near-js/providers";
import { InMemorySigner } from "@near-js/signers";
import { InMemoryKeyStore } from "@near-js/keystores";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
  SignedTransaction,
  Signature,
  type Action,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import { sha256 } from "@noble/hashes/sha256";

export const NEAR_RPCS = [
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.near.org",
  "https://near-testnet.drpc.org",
];

export function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

export async function retry<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.log(`  [retry] ${label} attempt ${i}/${tries} failed: ${(e as Error).message?.slice(0, 90)}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

export class NearClient {
  readonly accountId: string;
  readonly provider: JsonRpcProvider;
  private readonly keyPair: KeyPair;
  private readonly signer: InMemorySigner;
  private readonly ready: Promise<void>;

  constructor(accountId: string, privateKey: string) {
    this.accountId = accountId;
    this.keyPair = KeyPair.fromString(privateKey as KeyPairString);
    const keyStore = new InMemoryKeyStore();
    this.ready = keyStore.setKey("testnet", accountId, this.keyPair).then(() => undefined);
    this.signer = new InMemorySigner(keyStore);
    this.provider = new JsonRpcProvider({ url: NEAR_RPCS[0] });
  }

  get publicKey() {
    return this.keyPair.getPublicKey();
  }

  /** Build, sign, broadcast one transaction of `actions` to `receiverId`, and wait for its final outcome. */
  async sendActions(
    receiverId: string,
    actions: Action[],
  ): Promise<{ txHash: string; outcome: any }> {
    await this.ready;
    const accessKey: any = await retry("viewAccessKey", () =>
      this.provider.viewAccessKey(this.accountId, this.publicKey.toString(), {
        finality: "final",
      } as any),
    );
    const block: any = await retry("viewBlock", () =>
      this.provider.viewBlock({ finality: "final" } as any),
    );
    const tx = createTransaction(
      this.accountId,
      this.publicKey,
      receiverId,
      BigInt(accessKey.nonce) + 1n,
      actions,
      baseDecode(block.header.hash),
    );
    const sig = await this.signer.signMessage(encodeTransaction(tx), this.accountId, "testnet");
    const signedTx = new SignedTransaction({
      transaction: tx,
      signature: new Signature({ keyType: this.publicKey.keyType, data: sig.signature }),
    });
    const txHash = baseEncode(sha256(encodeTransaction(tx)));
    await retry("broadcast", () => this.provider.sendTransaction(signedTx));
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const outcome: any = await retry(
        "txStatus",
        () => (this.provider as any).txStatus(txHash, this.accountId, "EXECUTED_OPTIMISTIC"),
        3,
      );
      const st = outcome?.status ?? {};
      if ("SuccessValue" in st || "Failure" in st) {
        if ("Failure" in st) {
          throw new Error(`NEAR tx ${txHash} failed: ${JSON.stringify(st.Failure).slice(0, 400)}`);
        }
        return { txHash, outcome };
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for NEAR tx ${txHash}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  async functionCall(
    receiverId: string,
    methodName: string,
    args: Record<string, unknown>,
    gas: bigint = 30_000_000_000_000n,
    deposit: bigint = 0n,
  ): Promise<{ txHash: string; outcome: any }> {
    return this.sendActions(receiverId, [actionCreators.functionCall(methodName, args, gas, deposit)]);
  }

  async viewFunction(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<any> {
    const res: any = await retry(`view ${contractId}.${methodName}`, () =>
      this.provider.query({
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      } as any),
    );
    const text = new TextDecoder().decode(Uint8Array.from(res.result));
    return text.length ? JSON.parse(text) : null;
  }

  async balanceYocto(accountId: string = this.accountId): Promise<bigint> {
    const acc: any = await retry("view_account", () =>
      this.provider.query({
        request_type: "view_account",
        finality: "final",
        account_id: accountId,
      } as any),
    );
    return BigInt(acc.amount) + BigInt(acc.locked);
  }

  /**
   * The signerAccount shape chainsig.js 1.1.16 expects: it hands us bare
   * { signerId, receiverId, actions } transactions and wants
   * FinalExecutionOutcome[] back (the MPC signature rides in SuccessValue).
   */
  chainsigSignerAccount() {
    return {
      accountId: this.accountId,
      signAndSendTransactions: async ({ transactions }: any) => {
        const outcomes: any[] = [];
        for (const tx of transactions) {
          const { txHash, outcome } = await this.sendActions(tx.receiverId, tx.actions);
          console.log("  NEAR tx:", txHash, "->", tx.receiverId);
          outcomes.push(outcome);
        }
        return outcomes;
      },
    };
  }
}
