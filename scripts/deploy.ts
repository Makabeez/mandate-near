/**
 * Deploy a Mandate vault to testnet (or mainnet with NEAR_NETWORK=mainnet).
 *
 *   npm run deploy
 *
 * Creates <VAULT_PREFIX>.<owner> plus two demo vendor accounts, deploys and
 * initializes the contract in ONE transaction (nobody can front-run `new`),
 * and writes deployments/<network>.json. The vault's full-access key goes to
 * .keys/vault.json (mode 600) until you `npm run owner -- lock`.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Account, KeyPairSigner } from "near-api-js";
import { Mandate, defaultPolicy, near, newKey, txHash, fmt } from "../sdk/mandate.ts";
import { NETWORK, RPC_URL, env, optEnv, ownerAccount, provider, saveDeployment, saveKey, path, txUrl, accountUrl } from "./config.ts";

const owner = ownerAccount();
const prefix = optEnv("VAULT_PREFIX") ?? "mandate";
const vaultId = `${prefix}.${owner.accountId}`;
const fund = optEnv("VAULT_FUND") ?? "4.5";
const wasmPath = path("res", "mandate_near.wasm");
if (!existsSync(wasmPath)) throw new Error("res/mandate_near.wasm missing: run `npm run build:contract`");
const wasm = readFileSync(wasmPath);

const exists = async (id: string) => {
  try {
    await provider.viewAccount({ accountId: id, finalityQuery: { finality: "final" } } as never);
    return true;
  } catch {
    return false;
  }
};

console.log(`network ${NETWORK} · rpc ${RPC_URL}`);
const ownerState = await owner.getState();
const ownerBal = BigInt((ownerState as unknown as { balance: { available: bigint } }).balance.available);
console.log(`owner ${owner.accountId} · available ${fmt(ownerBal)} NEAR`);
const need = BigInt(near(fund)) + BigInt(near("0.2"));
if (ownerBal < need) throw new Error(`owner needs at least ${fmt(need)} NEAR (vault ${fund} + vendors/fees). Top up at https://near-faucet.io`);
if (await exists(vaultId)) throw new Error(`${vaultId} already exists. Set VAULT_PREFIX=mandate2 (or similar) in .env for a fresh vault.`);
env("OWNER_ACCOUNT_ID");

const txs: Record<string, string> = {};

// 1. Vault account, funded from the owner.
const vaultKey = newKey();
const c1 = await owner.createSubAccount({ accountOrPrefix: prefix, publicKey: vaultKey.publicKey, nearToTransfer: BigInt(near(fund)) });
txs.create_vault = txHash(c1 as never);
saveKey("vault", vaultId, vaultKey.secretKey, vaultKey.publicKey);
console.log(`✔ vault account ${vaultId} (${fund} NEAR) ${txUrl(txs.create_vault)}`);

// 2. Two demo vendors (receive payments) — subaccounts of the owner so the money stays yours.
const vendors = { api: `api-vendor.${owner.accountId}`, compute: `gpu-vendor.${owner.accountId}` };
for (const [k, id] of Object.entries(vendors)) {
  if (await exists(id)) {
    console.log(`• vendor ${id} already exists`);
    continue;
  }
  const vk = newKey();
  const prefixOf = id.split(".")[0];
  const r = await owner.createSubAccount({ accountOrPrefix: prefixOf, publicKey: vk.publicKey, nearToTransfer: BigInt(near("0.05")) });
  txs[`create_vendor_${k}`] = txHash(r as never);
  saveKey(`vendor-${k}`, id, vk.secretKey, vk.publicKey);
  console.log(`✔ vendor ${id}`);
}

// 3. Deploy + init in one transaction. Testnet-sized policy = the judge-demo policy x 0.25,
//    matching the sample invoices (INVOICE_SCALE=0.25).
const policy = defaultPolicy({
  max_per_tx: near(optEnv("MAX_PER_TX") ?? "0.25"),
  max_per_window: near(optEnv("MAX_PER_DAY") ?? "0.75"),
  approval_above: near(optEnv("APPROVAL_ABOVE") ?? "0.125"),
  cooldown_secs: Number(optEnv("COOLDOWN_SECS") ?? "5"),
  reserve: near(optEnv("RESERVE") ?? "0.2"),
});
const vault = new Account(vaultId, provider, KeyPairSigner.fromSecretKey(vaultKey.secretKey));
const d = await Mandate.deploy(vault, wasm, { owner: owner.accountId, policy, allowlist: [vendors.api, vendors.compute] });
txs.deploy_init = txHash(d as never);
console.log(`✔ contract deployed + initialized ${txUrl(txs.deploy_init)}`);

const m = new Mandate(RPC_URL, vaultId);
const st = await m.status();
console.log(`  available to the agent: ${fmt(st.available)} NEAR (rest is storage staking + reserve)`);

saveDeployment({
  network: NETWORK,
  vault: vaultId,
  owner: owner.accountId,
  vendors,
  attacker: optEnv("ATTACKER_ACCOUNT") ?? `attacker-not-allowlisted.${NETWORK === "mainnet" ? "near" : "testnet"}`,
  wasm_sha256: createHash("sha256").update(wasm).digest("hex"),
  deployed_at: new Date().toISOString(),
  txs,
});
// The dashboard reads web/config.json. Keep any API URL already set there.
const webCfgPath = path("web", "config.json");
const webCfg = existsSync(webCfgPath) ? (JSON.parse(readFileSync(webCfgPath, "utf8")) as Record<string, string>) : {};
writeFileSync(webCfgPath, JSON.stringify({ network: NETWORK, rpc: RPC_URL, vault: vaultId, api: optEnv("PUBLIC_API_URL") ?? webCfg.api ?? "" }, null, 2) + "\n");

console.log(`\nwrote deployments/${NETWORK}.json and web/config.json · explorer ${accountUrl(vaultId)}`);
console.log("next: npm run agent:add");
