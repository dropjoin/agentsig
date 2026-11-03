import * as fs from "node:fs";
import { recoverTransactionAddress, type Hex } from "viem";
const saved = JSON.parse(fs.readFileSync(new URL("./signed-tx.json", import.meta.url).pathname, "utf8"));
const recovered = await recoverTransactionAddress({ serializedTransaction: saved.signedTx as Hex });
console.log("recovered:", recovered);
console.log("expected :", saved.derivedAddress);
console.log("MATCH:", recovered === saved.derivedAddress);
