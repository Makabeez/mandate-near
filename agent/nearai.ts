/**
 * NEAR AI Cloud client that keeps what the vault needs to verify a decision:
 * the exact request bytes, the exact response bytes, and the TEE signature
 * over `<model>:<sha256(request)>:<sha256(response)>`.
 *
 * Docs: https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md
 */
import { createHash } from "node:crypto";
import { verifyMessage } from "ethers";
import type { Attestation } from "../sdk/mandate.ts";

export interface NearAiConfig {
  apiKey: string;
  model: string;
  base?: string;
}

export interface ChatResult {
  id: string;
  content: string;
  requestBody: string;
  responseBody: string;
}

export interface SignatureResult {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const baseOf = (c: NearAiConfig) => (c.base ?? "https://cloud-api.near.ai/v1").replace(/\/$/, "");

function headers(c: NearAiConfig) {
  return {
    Authorization: `Bearer ${c.apiKey}`,
    "Content-Type": "application/json",
    // Required for provider_tee signatures: use the canonical model, no alias routing.
    "x-no-aliasing": "true",
  };
}

/** fetch with retries on 429 / 5xx (NEAR AI gateway blips). Other errors return immediately. */
async function fetchRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let res: Response | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
      if (res.status !== 429 && res.status < 500) return res;
    } catch (e) {
      if (i === attempts - 1) throw e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
  }
  return res!;
}

export async function chat(c: NearAiConfig, messages: { role: string; content: string }[]): Promise<ChatResult> {
  const requestBody = JSON.stringify({ model: c.model, messages, temperature: 0, max_tokens: 400, stream: false });
  const res = await fetchRetry(`${baseOf(c)}/chat/completions`, { method: "POST", headers: headers(c), body: requestBody });
  const responseBody = await res.text(); // exact bytes: this is what the TEE signed
  if (!res.ok) throw new Error(`NEAR AI ${res.status}: ${responseBody.slice(0, 300)}`);
  const json = JSON.parse(responseBody) as { id: string; choices: { message: { content: string } }[] };
  return { id: json.id, content: json.choices?.[0]?.message?.content ?? "", requestBody, responseBody };
}

export async function signature(c: NearAiConfig, chatId: string): Promise<SignatureResult> {
  const url = `${baseOf(c)}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(c.model)}&signing_algo=ecdsa`;
  let last = "";
  for (let i = 0; i < 6; i++) {
    const res = await fetchRetry(url, { headers: headers(c) });
    const body = await res.text();
    if (res.ok) {
      const j = JSON.parse(body) as SignatureResult & { error_code?: string };
      if (j.signature && j.text) return j;
      last = body;
    } else {
      last = `${res.status} ${body}`;
    }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // signatures are stored shortly after the completion
  }
  throw new Error(`no signature for ${chatId}: ${last.slice(0, 300)}`);
}

/**
 * Check locally, before spending gas or risking a strike, that the signature
 * really covers these bytes and recovers to the claimed address.
 */
export function checkLocally(chat: ChatResult, sig: SignatureResult): { ok: boolean; problem?: string; warning?: string } {
  if (sig.signing_algo && sig.signing_algo !== "ecdsa") return { ok: false, problem: `algo ${sig.signing_algo}` };
  const parts = sig.text.split(":");
  const respHash = parts[parts.length - 1] ?? "";
  // The vault checks this one on-chain, so a mismatch here would cost a strike: stop before sending.
  if (respHash.toLowerCase() !== sha256(chat.responseBody)) return { ok: false, problem: "response hash in signed text does not match the body we received" };
  const recovered = verifyMessage(sig.text, sig.signature);
  if (recovered.toLowerCase() !== sig.signing_address.toLowerCase()) return { ok: false, problem: `signature recovers to ${recovered}` };
  // The request hash is not checked on-chain; report it so the evidence file is honest.
  const reqHash = parts[parts.length - 2] ?? "";
  const warning = reqHash.toLowerCase() === sha256(chat.requestBody) ? undefined : "request hash differs from our request bytes";
  return { ok: true, warning };
}

export function toAttestation(chat: ChatResult, sig: SignatureResult): Attestation {
  return { text: sig.text, signature: sig.signature, response_body: chat.responseBody };
}

/** Fetch the model attestation report (Intel TDX + NVIDIA evidence) for a model. */
export async function attestationReport(c: NearAiConfig, nonce: string) {
  const url = `${baseOf(c)}/attestation/report?model=${encodeURIComponent(c.model)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`;
  const res = await fetchRetry(url, { headers: headers(c) });
  const body = await res.text();
  if (!res.ok) throw new Error(`attestation report ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as {
    gateway_attestation?: { signing_address?: string };
    model_attestations?: { signing_address: string; signing_algo: string; request_nonce?: string; intel_quote?: string; nvidia_payload?: unknown }[];
    [k: string]: unknown;
  };
}
