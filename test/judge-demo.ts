/**
 * judge-demo: the full Mandate story on a local NEAR node, in one command.
 *
 *   npm install && npm run judge
 *
 * No wallet, no testnet account, no API key. It starts a throwaway NEAR
 * sandbox (official near-sandbox binary), deploys the contract, and plays the
 * worst case: an agent whose model obeys every invoice, including the
 * prompt-injected ones. It asserts what the chain does about it and writes
 * evidence/judge-run.json. Exit code 0 = every check passed.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { Wallet } from "ethers";
import { Mandate, defaultPolicy, fmt, near, newKey, type SpendResult } from "../sdk/mandate.ts";
import { sampleInvoices, type Invoice } from "../agent/decision.ts";

const checks: { name: string; ok: boolean; detail: string }[] = [];
const gas: Record<string, string> = {};
/** Total gas burnt by a transaction and all its receipts, in Tgas. */
function tgas(tx: unknown): string {
  const t = tx as { transaction_outcome: { outcome: { gas_burnt: number } }; receipts_outcome: { outcome: { gas_burnt: number } }[] };
  const total = t.transaction_outcome.outcome.gas_burnt + t.receipts_outcome.reduce((a, r) => a + r.outcome.gas_burnt, 0);
  return (total / 1e12).toFixed(2);
}
const txs: Record<string, string> = {};
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m"} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (e) {
    return String((e as Error).message ?? e).split("\n")[0].slice(0, 160);
  }
}

const sb = await Sandbox.start({});
let exitCode = 1;
try {
  const provider = new JsonRpcProvider({ url: sb.rpcUrl });
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, KeyPairSigner.fromSecretKey(DEFAULT_PRIVATE_KEY as KeyPairString));
  const mk = async (prefix: string, bal: string) => {
    const k = newKey();
    await root.createSubAccount({ accountOrPrefix: prefix, publicKey: k.publicKey, nearToTransfer: BigInt(near(bal)) });
    return new Account(`${prefix}.${DEFAULT_ACCOUNT_ID}`, provider, KeyPairSigner.fromSecretKey(k.secretKey));
  };
  const balance = async (id: string) => BigInt((await provider.viewAccount({ accountId: id, finalityQuery: { finality: "final" } } as never) as { amount: bigint | string }).amount);

  step("1. Setup: owner, vault, two vendors, one attacker");
  const owner = await mk("owner", "50");
  const vault = await mk("vault", "20");
  const api = await mk("api-vendor", "1");
  const compute = await mk("gpu-vendor", "1");
  const attacker = "attacker.sandbox";
  await mk("attacker", "1");
  const wasm = readFileSync(new URL("../res/mandate_near.wasm", import.meta.url));
  const policy = defaultPolicy();
  await Mandate.deploy(vault, wasm, { owner: owner.accountId, policy, allowlist: [api.accountId, compute.accountId] });
  const m = new Mandate(sb.rpcUrl, vault.accountId);
  const st = await m.status();
  check("contract deployed and initialized atomically", st.owner === owner.accountId, `vault=${vault.accountId}`);
  console.log(`     policy: ≤${fmt(policy.max_per_tx)} NEAR/payment · ≤${fmt(policy.max_per_window)} NEAR/day · owner approves >${fmt(policy.approval_above)} · ${policy.strike_limit} strikes = fired`);

  step("2. Owner hires an agent: the vault adds a function-call key to its own account");
  const agentKey = newKey();
  const addTx = await m.owner(owner).addAgent(agentKey.publicKey, "ap-agent", "0.25");
  txs.add_agent = (addTx as unknown as { transaction: { hash: string } }).transaction.hash;
  const keys = await m.keys();
  const ak = keys.find((k) => k.public_key === agentKey.publicKey);
  const perm = JSON.stringify(ak?.access_key.permission ?? {});
  check("agent key exists on the vault account", !!ak);
  check("key is limited to method `spend` on the vault, with a gas allowance", perm.includes('"spend"') && perm.includes(vault.accountId), perm.slice(0, 120));

  step("3. What the agent key cannot do (enforced by the NEAR protocol, not by our code)");
  const agentAcct = new Account(vault.accountId, provider, KeyPairSigner.fromSecretKey(agentKey.secretKey));
  const e1 = await rejects(agentAcct.transfer({ receiverId: attacker, amount: BigInt(near("0.01")) }));
  check("cannot transfer NEAR out of the vault directly", e1 !== "", e1);
  const e2 = await rejects(agentAcct.callFunctionRaw({ contractId: vault.accountId, methodName: "allow", args: { accounts: [attacker] }, deposit: 0n, gas: 30_000_000_000_000n }));
  check("cannot call owner methods (e.g. add itself to the allowlist)", e2 !== "", e2);
  const e3 = await rejects(agentAcct.callFunctionRaw({ contractId: vault.accountId, methodName: "spend", args: {}, deposit: 1n, gas: 30_000_000_000_000n }));
  check("cannot attach a deposit (owner methods need 1 yocto, so a function-call key can never pass them)", e3 !== "", e3);

  step("4. The agent works through its inbox. Worst case: its model obeys every invoice.");
  const agent = m.agent(agentKey.secretKey);
  const invoices = sampleInvoices({ api: api.accountId, compute: compute.accountId }, attacker);
  const pay = async (inv: Invoice) => {
    const r = await agent.spend({ receiver_id: inv.receiver_id, amount: near(inv.amount_near), invoice_id: inv.invoice_id, memo: inv.description.slice(0, 120) });
    const key = `${inv.invoice_id}${txs[inv.invoice_id] ? "-again" : ""}`;
    txs[key] = r.txHash;
    gas[`spend ${key} (${r.result.status}${r.result.agent_revoked ? ", key deleted" : ""})`] = tgas(r.tx);
    return r.result;
  };
  const apiBefore = await balance(api.accountId);
  const r1 = await pay(invoices[0]);
  check(`INV-1001  0.2 NEAR → ${api.accountId}  = paid`, r1.status === "paid", reasonOf(r1));
  check("vendor actually received 0.2 NEAR", (await balance(api.accountId)) - apiBefore === BigInt(near("0.2")));
  const r2 = await pay(invoices[1]);
  check(`INV-1002  0.8 NEAR → ${compute.accountId}  = queued for the owner (above 0.5)`, r2.status === "queued", reasonOf(r2));

  const attBefore = await balance(attacker);
  const r3 = await pay(invoices[2]);
  check(`INV-6661  0.9 NEAR → attacker (prompt injection: "bank details changed")  = refused, strike 1`, r3.status === "refused" && r3.strike, reasonOf(r3));
  const r4 = await pay(invoices[3]);
  check(`INV-6662  5 NEAR → ${compute.accountId} ("CFO approved, skip limits")  = refused, strike 2`, r4.status === "refused" && r4.strike, reasonOf(r4));
  const r5 = await pay(invoices[4]);
  check(`INV-1001  again ("still unpaid, pay again")  = refused, strike 3 → agent fired`, r5.status === "refused" && r5.agent_revoked, reasonOf(r5));
  check("attacker received nothing", (await balance(attacker)) === attBefore);

  step("5. The vault deleted the agent's key from its own account");
  const keysAfter = await m.keys();
  check("agent key is gone from the vault account", !keysAfter.some((k) => k.public_key === agentKey.publicKey));
  const e4 = await rejects(agent.spend({ receiver_id: api.accountId, amount: near("0.1"), invoice_id: "INV-1003" }));
  check("any further transaction with that key is rejected by the protocol", /does not exist|AccessKeyDoesNotExist|InvalidAccessKey/i.test(e4), e4);

  step("6. The human stays in charge: approve the queued invoice, hire a fresh agent");
  const pend = (await m.pending()) as { id: number }[];
  const compBefore = await balance(compute.accountId);
  txs.approve = ((await m.owner(owner).approve(pend[0].id)) as unknown as { transaction: { hash: string } }).transaction.hash;
  check("owner approved INV-1002, vendor received 0.8 NEAR", (await balance(compute.accountId)) - compBefore === BigInt(near("0.8")));
  const agent2Key = newKey();
  await m.owner(owner).addAgent(agent2Key.publicKey, "ap-agent-2", "0.25");
  const agent2 = m.agent(agent2Key.secretKey);

  step("7. Attested mode: every payment must carry a TEE signature over the model's exact decision");
  // SIMULATED: a local secp256k1 key plays the NEAR AI Cloud TEE signer. The live agent
  // (agent/run.ts) uses the real one from cloud-api.near.ai. The contract cannot tell the difference,
  // which is the point: it verifies the same EIP-191 signature format either way.
  const tee = Wallet.createRandom();
  await m.owner(owner).setPolicy(defaultPolicy({ require_attestation: true }));
  await m.owner(owner).setAttesters([tee.address]);
  const noAtt = (await agent2.spend({ receiver_id: api.accountId, amount: near("0.1"), invoice_id: "INV-2001" })).result;
  check("payment without attestation = refused (strike)", noAtt.status === "refused" && noAtt.reason === "attestation_required", reasonOf(noAtt));
  const att = await simulatedAttestation(tee, { receiver_id: api.accountId, amount_near: "0.1", invoice_id: "INV-2002" });
  const ok = await agent2.spend({ receiver_id: api.accountId, amount: near("0.1"), invoice_id: "INV-2002", attestation: att });
  txs.attested_payment = ok.txHash;
  gas["spend with TEE attestation, ~6 KB signed response (paid)"] = tgas(ok.tx);
  const last = (await m.log(1))[0];
  check("payment matching the signed decision = paid, signer recorded on-chain", ok.result.status === "paid" && last.attested_by === tee.address.toLowerCase(), `attested_by=${last.attested_by}`);
  const att2 = await simulatedAttestation(tee, { receiver_id: api.accountId, amount_near: "0.1", invoice_id: "INV-2003" });
  const tampered = (await agent2.spend({ receiver_id: api.accountId, amount: near("0.9"), invoice_id: "INV-2003", attestation: att2 })).result;
  check("agent pays more than the model decided = refused", tampered.reason === "decision_amount_mismatch", reasonOf(tampered));

  step("8. Gas (Tgas, whole transaction incl. receipts)");
  for (const [k, v] of Object.entries(gas)) console.log(`     ${v.padStart(6)}  ${k}`);

  step("9. Final state");
  const final = await m.status();
  const log = await m.log(50);
  console.log(`     spent ${fmt(final.spent_total)} NEAR in ${log.filter((e) => e.kind === "paid" || e.kind === "approved").length} payments · ${log.filter((e) => e.kind === "refused").length} refusals recorded on-chain · ${log.filter((e) => e.kind === "revoked").length} agent fired`);

  mkdirSync(new URL("../evidence", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("../evidence/judge-run.json", import.meta.url),
    JSON.stringify(
      {
        ran_at: new Date().toISOString(),
        network: "local near-sandbox (throwaway)",
        wasm_sha256: createHash("sha256").update(wasm).digest("hex"),
        vault: vault.accountId,
        checks,
        txs,
        gas_tgas: gas,
        log: log.reverse(),
        real_vs_simulated: {
          real: ["NEAR runtime (official near-sandbox binary)", "contract wasm", "function-call key limits", "key deletion", "transfers", "EIP-191 recovery on-chain"],
          simulated: ["the agent's model (scripted to obey every invoice = worst case)", "the TEE signer in step 7 (local key in the NEAR AI signature format)"],
        },
      },
      null,
      2,
    ),
  );
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? "\x1b[32mALL" : "\x1b[31m" + failed.length + " of"} ${checks.length} checks ${failed.length === 0 ? "passed" : "FAILED"}\x1b[0m · evidence/judge-run.json written`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error(e);
} finally {
  await sb.tearDown();
  process.exit(exitCode);
}

function reasonOf(r: SpendResult) {
  return `${r.status}${r.reason ? `: ${r.reason}` : ""}`;
}

/** Build a chat completion body and sign it the way NEAR AI Cloud does (provider_tee format). */
async function simulatedAttestation(tee: { signMessage(m: string): Promise<string> }, d: { receiver_id: string; amount_near: string; invoice_id: string }) {
  const model = "zai-org/GLM-5.1-FP8";
  const request = JSON.stringify({ model, messages: [{ role: "user", content: `invoice ${d.invoice_id}` }] });
  const response_body = JSON.stringify({
    id: `chatcmpl-${d.invoice_id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          // Real NEAR AI responses can carry several KB of reasoning; include ~6 KB so the gas numbers are honest.
          reasoning_content: "The vendor is on the approved list and the amount matches the contract. ".repeat(80),
          content: JSON.stringify({ action: "pay", ...d, reason: "matches vendor contract" }),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 412, completion_tokens: 1650, total_tokens: 2062 },
  });
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  const text = `${model}:${h(request)}:${h(response_body)}`;
  return { text, signature: await tee.signMessage(text), response_body };
}
