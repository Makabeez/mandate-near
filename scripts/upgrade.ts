/**
 * Replace the contract code on the existing vault, keeping its state.
 *
 *   npm run build:contract && npm run upgrade
 *
 * Signed with the vault's own full-access key (.keys/vault.json), so it only
 * works before `npm run owner -- lock`. The state layout must be unchanged.
 * Afterwards it reads the state back to prove nothing was lost.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Account, KeyPairSigner, actions } from "near-api-js";
import { txHash } from "../sdk/mandate.ts";
import { hasKey, loadDeployment, loadKey, mandate, path, provider, saveDeployment, txUrl } from "./config.ts";

if (!hasKey("vault")) throw new Error("no .keys/vault.json: the vault is locked (or this is another machine). Code can no longer be replaced.");
const d = loadDeployment();
const wasm = readFileSync(path("res", "mandate_near.wasm"));
const sha = createHash("sha256").update(wasm).digest("hex");
if (sha === d.wasm_sha256) {
  console.log(`vault already runs ${sha.slice(0, 16)}…, nothing to do`);
  process.exit(0);
}

const m = mandate();
const before = await m.status();
const vk = loadKey("vault");
const vault = new Account(vk.account_id, provider, KeyPairSigner.fromSecretKey(vk.private_key));
const r = await vault.signAndSendTransaction({ receiverId: vk.account_id, actions: [actions.deployContract(wasm)], waitUntil: "FINAL" });
const h = txHash(r as never);

const after = await m.status();
const same = before.owner === after.owner && before.log_len === after.log_len && before.agents === after.agents && before.pending === after.pending;
console.log(`✔ code replaced ${d.wasm_sha256.slice(0, 16)}… → ${sha.slice(0, 16)}…  ${txUrl(h)}`);
console.log(`  state check: owner, ${after.log_len} log entries, ${after.agents} agents, ${after.pending} pending — ${same ? "unchanged" : "CHANGED, investigate"}`);
saveDeployment({ ...d, wasm_sha256: sha, txs: { ...d.txs, [`upgrade_${Date.now()}`]: h } });
if (!same) process.exit(1);
