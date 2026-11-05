/**
 * Find and check the NEAR AI Cloud TEE signing address you will trust.
 *
 *   npm run attestation
 *
 * 1. Fetches the model attestation report (Intel TDX + NVIDIA evidence) with a fresh nonce.
 * 2. Runs one real chat completion and fetches its signature.
 * 3. Checks locally: the signature covers the exact response bytes and recovers to
 *    the signing address, and that address appears in the attestation report.
 * 4. Saves everything to evidence/nearai-attestation.json and prints the owner command.
 *
 * What this does NOT do: verify the TDX quote itself. Do that once with NEAR's verifier
 * (https://cloud.near.ai/verify or github.com/nearai/nearai-cloud-verifier) before trusting the address.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { attestationReport, chat, checkLocally, signature } from "../agent/nearai.ts";
import { nearAi, path } from "./config.ts";

const cfg = nearAi();
if (!cfg) throw new Error("set NEAR_AI_API_KEY in .env (cloud.near.ai → API keys; claim $10 via nearbuilders.org/join)");

const nonce = randomBytes(32).toString("hex");
console.log(`model ${cfg.model}`);
const report = await attestationReport(cfg, nonce);
const reported = (report.model_attestations ?? []).map((a) => a.signing_address.toLowerCase());
const gateway = report.gateway_attestation?.signing_address?.toLowerCase();
console.log(`attestation report: ${reported.length} model signing address(es)${gateway ? ` + gateway ${gateway}` : ""}`);
for (const a of report.model_attestations ?? []) console.log(`  model  ${a.signing_address} (${a.signing_algo}) nonce echoed: ${a.request_nonce === nonce}`);

const c = await chat(cfg, [
  { role: "system", content: "Answer with one JSON object only." },
  { role: "user", content: '{"ping":"mandate attestation check"}' },
]);
const s = await signature(cfg, c.id);
const local = checkLocally(c, s);
const inReport = reported.includes(s.signing_address.toLowerCase()) || s.signing_address.toLowerCase() === gateway;
console.log(`completion ${c.id}: signed by ${s.signing_address} (${s.signature_kind ?? "kind n/a"})`);
console.log(`  signature valid over exact response bytes: ${local.ok ? "yes" : `NO — ${local.problem}`}${local.warning ? ` (note: ${local.warning})` : ""}`);
console.log(`  signer present in attestation report: ${inReport ? "yes" : "NO"}`);

mkdirSync(path("evidence"), { recursive: true });
writeFileSync(
  path("evidence", "nearai-attestation.json"),
  JSON.stringify({ checked_at: new Date().toISOString(), model: cfg.model, nonce, report, sample: { chat_id: c.id, signature: s, local_check: local, signer_in_report: inReport } }, null, 2),
);
console.log("saved evidence/nearai-attestation.json");

if (local.ok && inReport) {
  console.log(`\nregister it on the vault, then require it:\n  npm run owner -- set-attesters ${s.signing_address.toLowerCase()}\n  npm run owner -- attestation on`);
} else {
  console.log("\nDo not register this address until both checks say yes.");
  process.exit(1);
}
