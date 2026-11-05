/** Print the vault's live state from the chain.   npm run status */
import { fmt } from "../sdk/mandate.ts";
import { accountUrl, loadDeployment, mandate } from "./config.ts";

const d = loadDeployment();
const m = mandate();
const [st, p, agents, keys, pending, log, attesters] = await Promise.all([
  m.status(), m.policy(), m.agents(), m.keys(), m.pending(), m.log(15), m.attesters(),
]);
console.log(`vault ${d.vault} (${d.network})  ${accountUrl(d.vault)}`);
console.log(`owner ${st.owner} · ${st.paused ? "PAUSED" : "live"} · balance ${fmt(st.balance)} · available ${fmt(st.available)} NEAR`);
console.log(`window: spent ${fmt(st.spent_in_window)} / ${fmt(p.max_per_window)} · per payment ≤ ${fmt(p.max_per_tx)} · owner approves > ${fmt(p.approval_above)}`);
console.log(`attestation ${p.require_attestation ? "REQUIRED" : "optional"} · attesters ${attesters.join(", ") || "none"}`);
console.log(`\nagents:`);
for (const a of agents) {
  const onChain = keys.some((k) => k.public_key === a.public_key);
  console.log(`  ${a.active ? "ARMED" : "FIRED"}  ${a.name}  ${a.public_key.slice(0, 20)}…  key on-chain: ${onChain ? "yes" : "no"}  paid ${a.paid} · refused ${a.refused} · queued ${a.queued} · strikes ${a.strikes.length}`);
}
if (pending.length) console.log(`\npending approval:`, pending);
console.log(`\nlast ${log.length} log entries:`);
for (const e of log) {
  console.log(`  #${e.id} ${new Date(e.ts * 1000).toISOString().slice(5, 19)} ${e.kind.padEnd(12)} ${(e.receiver_id ?? "").padEnd(34)} ${fmt(e.amount).padStart(5)}  ${e.invoice_id} ${e.reason}${e.strike ? " [strike]" : ""}${e.attested_by ? ` [TEE ${e.attested_by.slice(0, 10)}…]` : ""}`);
}
