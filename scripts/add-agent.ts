/**
 * Hire (or re-hire) the agent: generate a fresh ed25519 key, and have the
 * owner ask the vault to add it as a function-call key limited to `spend`.
 *
 *   npm run agent:add               # first agent
 *   npm run agent:add -- --rotate   # after the vault fired the previous one
 */
import { newKey, txHash } from "../sdk/mandate.ts";
import { hasKey, loadKey, mandate, ownerAccount, saveKey, txUrl, optEnv, path } from "./config.ts";
import { renameSync } from "node:fs";

const m = mandate();
const owner = m.owner(ownerAccount());
const rotate = process.argv.includes("--rotate");
const name = optEnv("AGENT_NAME") ?? "ap-agent";

if (hasKey("agent")) {
  const old = loadKey("agent");
  const agents = await m.agents();
  const current = agents.find((a) => a.public_key === old.public_key);
  if (current?.active && !rotate) {
    console.log(`agent ${current.name} (${old.public_key}) is already active. Use --rotate to replace it.`);
    process.exit(0);
  }
  if (current?.active && rotate) {
    const r = await owner.removeAgent(old.public_key);
    console.log(`✔ removed old agent key ${txUrl(txHash(r as never))}`);
  }
  renameSync(path(".keys", "agent.json"), path(".keys", `agent.retired-${Date.now()}.json`));
}

const k = newKey();
saveKey("agent", m.vaultId, k.secretKey, k.publicKey);
const allowance = optEnv("AGENT_GAS_ALLOWANCE") ?? "0.5";
const r = await owner.addAgent(k.publicKey, `${name}-${Date.now().toString(36).slice(-4)}`, allowance);
console.log(`✔ agent key ${k.publicKey}`);
console.log(`  can call: ${m.vaultId}.spend only · gas allowance ${allowance} NEAR · saved to .keys/agent.json`);
console.log(`  ${txUrl(txHash(r as never))}`);
