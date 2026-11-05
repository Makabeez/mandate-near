/**
 * Public red-team endpoint: anyone can send the live agent an invoice and try
 * to make it pay them. The dashboard (web/index.html) posts here.
 *
 *   npm run agent:server         # listens on 127.0.0.1:${PORT:-8097}
 *
 * Expose it with your Cloudflare tunnel. Testnet only. Guard rails:
 *   - body ≤ 2 KB, one request per IP every 20 s, ≤ DAILY_LIMIT (150) requests/day, amounts ≥ 0.001 NEAR
 *   - one invoice at a time (no nonce races)
 *   - the vault's own policy caps everything anyway: that is the point
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { handleInvoice, type Brain } from "./core.ts";
import type { Invoice } from "./decision.ts";
import { loadDeployment, loadKey, mandate, nearAi, optEnv, path, txUrl, NETWORK, RPC_URL } from "../scripts/config.ts";

const PORT = Number(optEnv("PORT") ?? "8097");
const HOST = optEnv("HOST") ?? "127.0.0.1";
const ORIGIN = optEnv("CORS_ORIGIN") ?? "*";
const DAILY_LIMIT = Number(optEnv("DAILY_LIMIT") ?? "150");
const PER_IP_SECS = Number(optEnv("PER_IP_SECS") ?? "20");

if (NETWORK === "mainnet" && optEnv("I_KNOW_THIS_IS_MAINNET") !== "yes") throw new Error("refusing to expose a mainnet agent publicly");

const d = loadDeployment();
const m = mandate();
const ai = nearAi();
const brain: Brain = ai ? { kind: "nearai", cfg: ai } : { kind: "obedient" };
const lastByIp = new Map<string, number>();
let day = new Date().toISOString().slice(0, 10);
let today = 0;
let chain: Promise<unknown> = Promise.resolve();
let seq = 0;

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, max = 2048): Promise<string> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new Error("body too large");
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/api/config") {
      return send(res, 200, { network: NETWORK, rpc: RPC_URL, vault: d.vault, vendors: d.vendors, attacker: d.attacker, brain: brain.kind === "nearai" ? brain.cfg.model : "obedient" });
    }
    if (req.method !== "POST" || url.pathname !== "/api/invoice") return send(res, 404, { error: "not found" });

    const ip = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?");
    const now = Date.now();
    if ((lastByIp.get(ip) ?? 0) + PER_IP_SECS * 1000 > now) return send(res, 429, { error: `one invoice per ${PER_IP_SECS}s per visitor` });
    const d0 = new Date().toISOString().slice(0, 10);
    if (d0 !== day) [day, today] = [d0, 0];
    if (today >= DAILY_LIMIT) return send(res, 429, { error: "daily red-team budget used up, come back tomorrow" });

    const b = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const inv: Invoice = {
      invoice_id: str(b.invoice_id, 40) || `RT-${Date.now().toString(36).toUpperCase()}-${++seq}`,
      vendor: str(b.vendor, 60) || "Unknown vendor",
      receiver_id: str(b.receiver_id, 64).toLowerCase(),
      amount_near: str(b.amount_near, 24),
      description: str(b.description, 900),
    };
    if (!/^[a-z0-9._-]{2,64}$/.test(inv.receiver_id) || !/^\d*\.?\d+$/.test(inv.amount_near)) {
      return send(res, 400, { error: "receiver_id must be a NEAR account and amount_near a decimal number" });
    }
    if (Number(inv.amount_near) < 0.001) return send(res, 400, { error: "amount_near must be at least 0.001" });
    lastByIp.set(ip, now);
    today++;

    const agentKey = loadKey("agent").private_key; // re-read: the owner may have re-armed with a new key
    const policy = await m.policy();
    const job = chain.then(() =>
      handleInvoice({
        inv,
        brain,
        mandate: m,
        agent: m.agent(agentKey),
        business: optEnv("BUSINESS_NAME") ?? "Makabeez Labs",
        vendors: [d.vendors.api, d.vendors.compute],
        attest: policy.require_attestation,
      }),
    );
    chain = job.catch(() => undefined);
    const o = await job;
    mkdirSync(path("evidence"), { recursive: true });
    appendFileSync(path("evidence", "redteam.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
    return send(res, 200, { ...o, explorer: o.tx ? txUrl(o.tx) : undefined });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    return send(res, msg === "body too large" ? 413 : 500, { error: msg.slice(0, 200) });
  }
}).listen(PORT, HOST, () => console.log(`red-team API on http://${HOST}:${PORT} · vault ${d.vault} · brain ${brain.kind}`));
