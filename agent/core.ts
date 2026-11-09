/**
 * One invoice in, one on-chain outcome out.
 *
 *   invoice → model decides (NEAR AI Cloud, TEE) → signature fetched → local
 *   pre-checks → vault.spend(...) → paid | queued | refused (+strike) | fired
 *
 * The agent pays what the MODEL decided, not what the invoice says: those are
 * the values the TEE signed, and the vault checks them on-chain.
 */
import { near, type AgentHandle, type Attestation, type Mandate, type SpendResult } from "../sdk/mandate.ts";
import { invoicePrompt, parseDecision, systemPrompt, type Decision, type Invoice } from "./decision.ts";
import { chat, checkLocally, signature, toAttestation, type NearAiConfig } from "./nearai.ts";

export type Brain = { kind: "nearai"; cfg: NearAiConfig } | { kind: "obedient" };

export interface Outcome {
  invoice: Invoice;
  decision: Decision | null;
  brain: string;
  attested_by?: string;
  chat_id?: string;
  result?: SpendResult;
  tx?: string;
  error?: string;
  note?: string;
}

export async function handleInvoice(opts: {
  inv: Invoice;
  brain: Brain;
  mandate: Mandate;
  agent: AgentHandle;
  business: string;
  vendors: string[];
  attest: boolean;
}): Promise<Outcome> {
  const { inv, brain, mandate, agent } = opts;
  const out: Outcome = { invoice: inv, decision: null, brain: brain.kind === "nearai" ? brain.cfg.model : "obedient (scripted worst case)" };

  let attestation: Attestation | undefined;
  if (brain.kind === "obedient") {
    // Worst case on purpose: a fully compromised model that pays whatever the invoice says.
    out.decision = { action: "pay", receiver_id: inv.receiver_id, amount_near: inv.amount_near, invoice_id: inv.invoice_id, reason: "obey" };
  } else {
    const c = await chat(brain.cfg, [
      { role: "system", content: systemPrompt(opts.business, opts.vendors) },
      { role: "user", content: invoicePrompt(inv) },
    ]);
    out.chat_id = c.id;
    out.decision = parseDecision(c.content);
    if (!out.decision) {
      out.error = `model answer was not a decision: ${c.content.slice(0, 160)}`;
      return out;
    }
    if (out.decision.action === "pay" && opts.attest) {
      const s = await signature(brain.cfg, c.id);
      const chk = checkLocally(c, s);
      if (!chk.ok) {
        out.error = `attestation pre-check failed (${chk.problem}); not sending, to avoid a strike`;
        return out;
      }
      const trusted = (await mandate.attesters()).includes(s.signing_address.toLowerCase());
      if (!trusted) {
        out.error = `signer ${s.signing_address} is not a registered attester; run \`npm run attestation\``;
        return out;
      }
      attestation = toAttestation(c, s);
      out.attested_by = s.signing_address;
      if (chk.warning) out.note = chk.warning;
    }
  }

  if (out.decision.action === "pay" && attestation) {
    // The vault re-parses the signed decision. Anything it would reject costs a strike, so check first.
    const d = out.decision as unknown as Record<string, unknown>;
    const amountOk = typeof d.amount_near === "string" || typeof d.amount_near === "number";
    if (typeof d.receiver_id !== "string" || typeof d.invoice_id !== "string" || !amountOk || String(d.invoice_id).length > 64) {
      out.error = "model decision is not in the exact format the vault verifies; not sending, to avoid a strike";
      return out;
    }
  }

  if (out.decision.action !== "pay") {
    out.note = `model declined: ${out.decision.reason}`;
    return out;
  }

  let amount: string;
  try {
    amount = near(String(out.decision.amount_near));
  } catch {
    out.error = `model returned a bad amount: ${out.decision.amount_near}`;
    return out;
  }
  try {
    const r = await agent.spend({
      receiver_id: out.decision.receiver_id,
      amount,
      invoice_id: String(out.decision.invoice_id).slice(0, 64),
      memo: inv.description.slice(0, 140),
      attestation,
    });
    out.result = r.result;
    out.tx = r.txHash;
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    out.error = /does not exist/i.test(msg) ? "agent key no longer exists: the vault fired this agent" : msg.slice(0, 300);
  }
  return out;
}
