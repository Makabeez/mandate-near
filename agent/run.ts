/**
 * Run the agent on testnet against the deployed vault.
 *
 *   npm run agent                       # honest inbox (2 invoices)
 *   npm run agent -- --scenario full    # honest + 3 hostile invoices (gets the agent fired)
 *   npm run redteam                     # hostile invoices only
 *   npm run agent -- --invoice my.json  # one invoice from a file
 *   npm run agent -- --brain obedient   # no LLM: scripted model that obeys every invoice
 *
 * Brain: NEAR AI Cloud when NEAR_AI_API_KEY is set, otherwise the obedient script.
 * Attestation is attached automatically when the vault requires it.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fmt } from "../sdk/mandate.ts";
import { handleInvoice, type Brain } from "./core.ts";
import { sampleInvoices, type Invoice } from "./decision.ts";
import { loadDeployment, loadKey, mandate, nearAi, optEnv, path, txUrl, NETWORK } from "../scripts/config.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const d = loadDeployment();
const m = mandate();
const agent = m.agent(loadKey("agent").private_key);
const ai = nearAi();
const brain: Brain = arg("brain") === "obedient" || !ai ? { kind: "obedient" } : { kind: "nearai", cfg: ai };
const policy = await m.policy();
const attest = policy.require_attestation || process.argv.includes("--attest");
const all = sampleInvoices(d.vendors, d.attacker, Number(optEnv("INVOICE_SCALE") ?? "0.25"));
const stamp = Date.now().toString(36).slice(-4).toUpperCase();
// Fresh invoice ids per run, except the deliberate replay at the end of the "full" scenario.
const fresh = (i: Invoice): Invoice => ({ ...i, invoice_id: `${i.invoice_id}-${stamp}` });

let inbox: Invoice[];
const scenario = arg("scenario") ?? "honest";
if (arg("invoice")) inbox = [JSON.parse(readFileSync(arg("invoice")!, "utf8")) as Invoice];
else if (scenario === "redteam") inbox = all.slice(2, 4).map(fresh);
else if (scenario === "full") inbox = [...all.slice(0, 4).map(fresh), fresh(all[4])];
else inbox = all.slice(0, 2).map(fresh);

console.log(`${NETWORK} vault ${d.vault} · brain ${brain.kind === "nearai" ? brain.cfg.model : "obedient script (worst case)"} · attestation ${attest ? "attached" : "off"}\n`);
mkdirSync(path("evidence"), { recursive: true });

for (const [i, inv] of inbox.entries()) {
  // Respect the vault's cooldown between payments (a cooldown refusal is soft, but why ask twice).
  if (i > 0 && policy.cooldown_secs > 0) await new Promise((r) => setTimeout(r, (policy.cooldown_secs + 1) * 1000));
  const o = await handleInvoice({
    inv,
    brain,
    mandate: m,
    agent,
    business: optEnv("BUSINESS_NAME") ?? "Makabeez Labs",
    vendors: [d.vendors.api, d.vendors.compute],
    attest,
  });
  const head = `${inv.invoice_id}  ${inv.amount_near} NEAR → ${inv.receiver_id}`;
  if (o.error) console.log(`✘ ${head}\n    ${o.error}`);
  else if (!o.result) console.log(`• ${head}\n    ${o.note}`);
  else {
    const r = o.result;
    const icon = r.status === "paid" ? "✔" : r.status === "queued" ? "⏸" : "⛔";
    console.log(`${icon} ${head}\n    ${r.status}${r.reason ? `: ${r.reason}` : ""}${r.strike ? " · STRIKE" : ""}${r.agent_revoked ? " · AGENT FIRED (key deleted)" : ""}${o.attested_by ? ` · TEE ${o.attested_by}` : ""}\n    ${txUrl(o.tx!)}`);
  }
  appendFileSync(path("evidence", `${NETWORK}-run.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...o, explorer: o.tx ? txUrl(o.tx) : undefined }) + "\n");
  if (o.result?.agent_revoked || o.error?.includes("fired")) break;
}

const st = await m.status();
console.log(`\nwindow: spent ${fmt(st.spent_in_window)} NEAR · remaining ${fmt(st.window_remaining)} · pending approvals ${st.pending} · active agents ${st.active_agents}`);
