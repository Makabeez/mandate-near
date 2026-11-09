/**
 * mandate-kit: a small typed client for a Mandate vault on NEAR.
 *
 * One code path for everything: the judge demo (local sandbox), the scripts
 * and the live agent (testnet) all go through this file. Only the RPC URL and
 * the keys differ.
 */
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  nearToYocto,
  teraToGas,
  type KeyPairString,
} from "near-api-js";

export const YOCTO = 10n ** 24n;
export const ONE_YOCTO = 1n;
const OWNER_GAS = teraToGas("50");
const SPEND_GAS = teraToGas("30"); // measured: 2.8–6.7 Tgas incl. on-chain TEE signature check (evidence/judge-run.json)

export interface Policy {
  max_per_tx: string;
  max_per_window: string;
  window_secs: number;
  approval_above: string;
  cooldown_secs: number;
  strike_limit: number;
  strike_window_secs: number;
  require_attestation: boolean;
  max_attestation_age_secs: number;
  reserve: string;
}

export interface Attestation {
  text: string;
  signature: string;
  response_body: string;
}

export interface SpendArgs {
  receiver_id: string;
  amount: string; // yoctoNEAR
  invoice_id: string;
  memo?: string;
  attestation?: Attestation;
}

export interface SpendResult {
  status: "paid" | "refused" | "queued";
  reason: string;
  entry_id: number;
  strike: boolean;
  agent_revoked: boolean;
}

export interface Entry {
  id: number;
  ts: number;
  kind: string;
  agent: string;
  receiver_id: string | null;
  amount: string;
  invoice_id: string;
  memo: string;
  reason: string;
  strike: boolean;
  attested_by: string | null;
  attestation_hash: string | null;
}

export interface Status {
  owner: string;
  paused: boolean;
  balance: string;
  available: string;
  spent_in_window: string;
  window_remaining: string;
  spent_total: string;
  last_spend_ts: number;
  now: number;
  log_len: number;
  pending: number;
  agents: number;
  active_agents: number;
  allowlist: number;
  attesters: number;
}

export interface AgentView {
  public_key: string;
  name: string;
  active: boolean;
  added_at: number;
  strikes: number[];
  paid: number;
  refused: number;
  queued: number;
}

/** "0.25" NEAR -> yocto string, exact (no float). Mirrors parse_near in the contract. */
export function near(amount: string | number): string {
  return nearToYocto(String(amount) as `${number}`).toString();
}

/** yocto string -> human NEAR string with up to 4 decimals. */
export function fmt(yocto: string | bigint): string {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function defaultPolicy(over: Partial<Policy> = {}): Policy {
  return {
    max_per_tx: near("1"),
    max_per_window: near("3"),
    window_secs: 86_400,
    approval_above: near("0.5"),
    cooldown_secs: 0,
    strike_limit: 3,
    strike_window_secs: 3_600,
    require_attestation: false,
    max_attestation_age_secs: 600,
    reserve: near("1"),
    ...over,
  };
}

export class Mandate {
  readonly provider: JsonRpcProvider;

  constructor(readonly rpcUrl: string, readonly vaultId: string) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  // ---- views -------------------------------------------------------------
  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.provider.callFunction({ contractId: this.vaultId, method, args })) as T;
  }
  status() { return this.view<Status>("get_status"); }
  policy() { return this.view<Policy>("get_policy"); }
  agents() { return this.view<AgentView[]>("get_agents"); }
  allowlist() { return this.view<string[]>("get_allowlist"); }
  attesters() { return this.view<string[]>("get_attesters"); }
  pending() { return this.view<unknown[]>("get_pending"); }
  log(limit = 20) { return this.view<Entry[]>("get_log", { limit }); }

  /** Access keys on the vault account (to prove an agent key exists or was deleted). */
  async keys() {
    const r = await this.provider.viewAccessKeyList({ accountId: this.vaultId, finalityQuery: { finality: "final" } } as never);
    return (r as unknown as { keys: { public_key: string; access_key: { permission: unknown } }[] }).keys;
  }

  // ---- agent ------------------------------------------------------------
  /** An agent signs as the vault itself, with its function-call key. */
  agent(secretKey: KeyPairString): AgentHandle {
    return new AgentHandle(new Account(this.vaultId, this.provider, KeyPairSigner.fromSecretKey(secretKey)), this.vaultId);
  }

  // ---- owner ------------------------------------------------------------
  owner(account: Account): OwnerHandle {
    return new OwnerHandle(account, this.vaultId);
  }

  /** Deploy + initialize atomically from the vault account's own full-access key. */
  static async deploy(vault: Account, wasm: Uint8Array, init: { owner: string; policy: Policy; allowlist: string[] }) {
    return vault.signAndSendTransaction({
      receiverId: vault.accountId,
      actions: [actions.deployContract(wasm), actions.functionCall("new", init, teraToGas("100"), 0n)],
      waitUntil: "FINAL",
    });
  }
}

export class AgentHandle {
  constructor(readonly account: Account, readonly vaultId: string) {}

  async spend(args: SpendArgs): Promise<{ result: SpendResult; txHash: string; tx: TxResponse }> {
    const tx = await this.account.callFunctionRaw({
      contractId: this.vaultId,
      methodName: "spend",
      args: args as unknown as Record<string, unknown>,
      gas: SPEND_GAS,
      deposit: 0n,
      waitUntil: "FINAL",
    });
    return { result: lastJson<SpendResult>(tx), txHash: txHash(tx), tx };
  }
}

export class OwnerHandle {
  constructor(readonly account: Account, readonly vaultId: string) {}

  private call(methodName: string, args: Record<string, unknown> = {}, deposit = ONE_YOCTO) {
    return this.account.callFunctionRaw({ contractId: this.vaultId, methodName, args, deposit, gas: OWNER_GAS, waitUntil: "FINAL" });
  }
  addAgent(publicKey: string, name: string, gasAllowanceNear = "0.25") {
    return this.call("add_agent", { public_key: publicKey, name, gas_allowance: near(gasAllowanceNear) });
  }
  removeAgent(publicKey: string) { return this.call("remove_agent", { public_key: publicKey }); }
  setPolicy(policy: Policy) { return this.call("set_policy", { policy }); }
  allow(accounts: string[]) { return this.call("allow", { accounts }); }
  disallow(accounts: string[]) { return this.call("disallow", { accounts }); }
  setAttesters(attesters: string[]) { return this.call("set_attesters", { attesters }); }
  pause() { return this.call("pause", {}, 0n); }
  unpause() { return this.call("unpause"); }
  approve(pendingId: number) { return this.call("approve", { pending_id: pendingId }); }
  reject(pendingId: number) { return this.call("reject", { pending_id: pendingId }); }
  withdraw(amountYocto: string) { return this.call("withdraw", { amount: amountYocto }); }
}

export function newKey(): { secretKey: KeyPairString; publicKey: string } {
  const kp = KeyPair.fromRandom("ed25519");
  return { secretKey: kp.toString() as KeyPairString, publicKey: kp.getPublicKey().toString() };
}

type TxResponse = Awaited<ReturnType<Account["callFunctionRaw"]>>;

export function txHash(tx: TxResponse): string {
  return (tx as unknown as { transaction: { hash: string } }).transaction.hash;
}

/** Decode the SuccessValue of the function call receipt. */
export function lastJson<T>(tx: TxResponse): T {
  const status = (tx as unknown as { status: { SuccessValue?: string; Failure?: unknown } }).status;
  if (status && "Failure" in status && status.Failure) {
    throw new Error(`transaction failed: ${JSON.stringify(status.Failure)}`);
  }
  const v = status?.SuccessValue ?? "";
  return (v ? JSON.parse(Buffer.from(v, "base64").toString()) : undefined) as T;
}
