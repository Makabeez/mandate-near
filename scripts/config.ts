/**
 * Shared config for the testnet scripts and the live agent.
 * Secrets come from .env and .keys/ (both git-ignored), never from the repo.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { Mandate } from "../sdk/mandate.ts";

const ROOT = new URL("..", import.meta.url).pathname;
export const path = (...p: string[]) => join(ROOT, ...p);

// Minimal .env loader (no dependency). Existing env vars win.
const envFile = path(".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing ${k} (set it in .env, see .env.example)`);
  return v;
};
export const optEnv = (k: string) => process.env[k] || undefined;

export const NETWORK = optEnv("NEAR_NETWORK") ?? "testnet";
export const RPC_URL = optEnv("NEAR_RPC_URL") ?? (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const txUrl = (h: string) => `${EXPLORER}/txns/${h}`;
export const accountUrl = (a: string) => `${EXPLORER}/address/${a}`;

export const provider = new JsonRpcProvider({ url: RPC_URL });

/** Owner key: OWNER_PRIVATE_KEY, or the near-cli legacy keychain (~/.near-credentials/<net>/<id>.json). */
export function ownerAccount(): Account {
  const id = env("OWNER_ACCOUNT_ID");
  let sk = optEnv("OWNER_PRIVATE_KEY");
  if (!sk) {
    const f = join(homedir(), ".near-credentials", NETWORK, `${id}.json`);
    if (!existsSync(f)) throw new Error(`no key for ${id}: set OWNER_PRIVATE_KEY or create ${f} (near-cli-rs: save-to-legacy-keychain)`);
    sk = (JSON.parse(readFileSync(f, "utf8")) as { private_key: string }).private_key;
  }
  return new Account(id, provider, KeyPairSigner.fromSecretKey(sk as KeyPairString));
}

export interface Deployment {
  network: string;
  vault: string;
  owner: string;
  vendors: { api: string; compute: string };
  attacker: string;
  wasm_sha256: string;
  deployed_at: string;
  txs: Record<string, string>;
}

const deploymentFile = () => path("deployments", `${NETWORK}.json`);
export function loadDeployment(): Deployment {
  const f = deploymentFile();
  if (!existsSync(f)) throw new Error(`no ${f}: run \`npm run deploy\` first`);
  return JSON.parse(readFileSync(f, "utf8")) as Deployment;
}
export function saveDeployment(d: Deployment) {
  mkdirSync(path("deployments"), { recursive: true });
  writeFileSync(deploymentFile(), JSON.stringify(d, null, 2) + "\n");
}

/** Secret keys live in .keys/<name>.json with mode 600. */
export function saveKey(name: string, accountId: string, secretKey: string, publicKey: string) {
  mkdirSync(path(".keys"), { recursive: true, mode: 0o700 });
  const f = path(".keys", `${name}.json`);
  writeFileSync(f, JSON.stringify({ account_id: accountId, public_key: publicKey, private_key: secretKey }, null, 2));
  chmodSync(f, 0o600);
  return f;
}
export function loadKey(name: string): { account_id: string; public_key: string; private_key: KeyPairString } {
  const f = path(".keys", `${name}.json`);
  if (!existsSync(f)) throw new Error(`missing ${f}`);
  return JSON.parse(readFileSync(f, "utf8"));
}
export const hasKey = (name: string) => existsSync(path(".keys", `${name}.json`));

export function mandate(): Mandate {
  return new Mandate(RPC_URL, loadDeployment().vault);
}

export function nearAi() {
  const apiKey = optEnv("NEAR_AI_API_KEY");
  return apiKey
    ? { apiKey, model: optEnv("NEAR_AI_MODEL") ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017", base: optEnv("NEAR_AI_BASE") }
    : undefined;
}

export const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
