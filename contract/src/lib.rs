//! Mandate for NEAR — a vault an AI agent can spend from, but only inside the
//! rules its owner set, and that fires the agent when it misbehaves.
//!
//! How the agent is boxed in, using NEAR's own account model:
//!
//! * The agent never holds a full-access key. `add_agent` makes the vault add a
//!   **function-call access key** to *its own account*, valid only for calling
//!   `spend` on the vault, with a capped gas allowance. NEAR rejects anything
//!   else signed with that key at the protocol level: no transfers, no other
//!   methods, no other contracts, no attached deposit.
//! * Every `spend` is checked against the owner's policy: per-payment cap,
//!   rolling budget, recipient allowlist, cooldown, invoice replay, a human
//!   approval queue above a threshold, and optionally a NEAR AI Cloud TEE
//!   signature proving an attested model made exactly this decision.
//! * A refusal does **not** panic. It is recorded on-chain, so it can be counted.
//!   Hard violations are strikes; when an agent reaches `strike_limit` strikes
//!   inside `strike_window_secs`, the vault deletes the agent's access key from
//!   its own account in the same transaction. The agent is locked out by the
//!   protocol, not by an off-chain process.
//! * Owner methods require 1 yoctoNEAR attached, so they can only be signed with
//!   a full-access key, never with a function-call key.

mod attest;

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PublicKey,
};

const MAX_INVOICE_LEN: usize = 64;
const MAX_MEMO_LEN: usize = 140;
const MAX_NAME_LEN: usize = 32;
const MAX_ATTESTERS: u32 = 8;
const MAX_LOG_PAGE: u64 = 100;
/// The ledger keeps the last MAX_LOG entries (ring buffer), so a flood of
/// refused invoices cannot grow storage and eat the vault's balance.
const MAX_LOG: u64 = 250;
/// Max payments waiting for the owner at once.
const MAX_PENDING: u32 = 20;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Clock skew tolerated between the model response `created` time and the block.
const FUTURE_SKEW_SECS: u64 = 120;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Allowlist,
    Agents,
    Attesters,
    UsedInvoices,
    UsedAttestations,
    Log,
    Pending,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Policy {
    /// Hard cap for a single payment, yoctoNEAR. Above it: strike.
    pub max_per_tx: U128,
    /// Budget for all payments inside the rolling window, yoctoNEAR.
    pub max_per_window: U128,
    pub window_secs: u64,
    /// Payments strictly above this go to the owner's approval queue.
    pub approval_above: U128,
    /// Minimum seconds between two payments.
    pub cooldown_secs: u64,
    /// Strikes inside `strike_window_secs` that get the agent's key deleted.
    pub strike_limit: u32,
    pub strike_window_secs: u64,
    /// If true, every spend must carry a NEAR AI Cloud TEE signature.
    pub require_attestation: bool,
    /// Max age of the signed model response, seconds.
    pub max_attestation_age_secs: u64,
    /// Balance the agent can never touch, yoctoNEAR (on top of storage).
    pub reserve: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub name: String,
    pub active: bool,
    pub added_at: u64,
    pub strikes: Vec<u64>,
    pub paid: u32,
    pub refused: u32,
    pub queued: u32,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub public_key: PublicKey,
    #[serde(flatten)]
    pub agent: Agent,
}

#[near(serializers = [json])]
pub struct Attestation {
    /// The signed text returned by GET /v1/signature/{chat_id}.
    pub text: String,
    /// 65-byte hex ecdsa signature returned with it.
    pub signature: String,
    /// Exact raw bytes of the chat completion response body.
    pub response_body: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Entry {
    pub id: u64,
    pub ts: u64,
    /// paid | refused | queued | approved | rejected | failed | revoked | agent_added | agent_removed
    pub kind: String,
    pub agent: String,
    pub receiver_id: Option<AccountId>,
    pub amount: U128,
    pub invoice_id: String,
    pub memo: String,
    pub reason: String,
    pub strike: bool,
    pub attested_by: Option<String>,
    pub attestation_hash: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Pending {
    pub id: u64,
    pub created_at: u64,
    pub agent: String,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub invoice_id: String,
    pub memo: String,
    pub attested_by: Option<String>,
    pub attestation_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct SpendResult {
    /// paid | refused | queued
    pub status: String,
    pub reason: String,
    pub entry_id: u64,
    pub strike: bool,
    pub agent_revoked: bool,
}

#[near(serializers = [json])]
pub struct Status {
    pub owner: AccountId,
    pub paused: bool,
    pub balance: U128,
    pub available: U128,
    pub spent_in_window: U128,
    pub window_remaining: U128,
    pub spent_total: U128,
    pub last_spend_ts: u64,
    pub now: u64,
    pub log_len: u64,
    pub pending: u32,
    pub agents: u32,
    pub active_agents: u32,
    pub allowlist: u32,
    pub attesters: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Mandate {
    owner: AccountId,
    policy: Policy,
    paused: bool,
    allowlist: IterableSet<AccountId>,
    agents: IterableMap<PublicKey, Agent>,
    attesters: IterableSet<String>,
    used_invoices: LookupSet<String>,
    used_attestations: LookupSet<Vec<u8>>,
    /// (timestamp, amount) of payments inside the rolling window.
    window: Vec<(u64, u128)>,
    last_spend_ts: u64,
    spent_total: u128,
    /// Ring buffer: entry id -> entry, only the last MAX_LOG ids are kept.
    log: LookupMap<u64, Entry>,
    log_len: u64,
    pending: IterableMap<u64, Pending>,
    next_pending: u64,
}

fn now() -> u64 {
    env::block_timestamp_ms() / 1000
}

fn validate_policy(p: &Policy) {
    require!(p.max_per_tx.0 > 0, "max_per_tx must be > 0");
    require!(p.max_per_window.0 >= p.max_per_tx.0, "max_per_window must be >= max_per_tx");
    require!(p.approval_above.0 <= p.max_per_tx.0, "approval_above must be <= max_per_tx");
    require!(p.window_secs > 0 && p.strike_window_secs > 0, "windows must be > 0");
    require!(p.strike_limit >= 1, "strike_limit must be >= 1");
    require!(p.max_attestation_age_secs > 0, "max_attestation_age_secs must be > 0");
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({"standard": "mandate", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

#[near]
impl Mandate {
    /// Initialize the vault. Only the vault account itself can call this (at deploy).
    #[init]
    #[private]
    pub fn new(owner: AccountId, policy: Policy, allowlist: Vec<AccountId>) -> Self {
        require!(owner != env::current_account_id(), "owner must be a different account than the vault");
        validate_policy(&policy);
        let mut s = Self {
            owner,
            policy,
            paused: false,
            allowlist: IterableSet::new(Key::Allowlist),
            agents: IterableMap::new(Key::Agents),
            attesters: IterableSet::new(Key::Attesters),
            used_invoices: LookupSet::new(Key::UsedInvoices),
            used_attestations: LookupSet::new(Key::UsedAttestations),
            window: Vec::new(),
            last_spend_ts: 0,
            spent_total: 0,
            log: LookupMap::new(Key::Log),
            log_len: 0,
            pending: IterableMap::new(Key::Pending),
            next_pending: 0,
        };
        for a in allowlist {
            s.allowlist.insert(a);
        }
        s
    }

    // ------------------------------------------------------------------
    // Agent entrypoint
    // ------------------------------------------------------------------

    /// The only method an agent key can call. Never panics on a policy
    /// violation: it records a refusal (and maybe a strike) instead, so the
    /// tripwire can count bad behaviour across transactions.
    pub fn spend(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        invoice_id: String,
        memo: Option<String>,
        attestation: Option<Attestation>,
    ) -> SpendResult {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "spend must be signed with an agent key of this vault"
        );
        let pk = env::signer_account_pk();
        let mut agent = self.agents.get(&pk).cloned().unwrap_or_else(|| env::panic_str("signer key is not an agent of this vault"));
        require!(agent.active, "agent is revoked");
        let memo = memo.unwrap_or_default();
        require!(amount.0 > 0, "amount must be > 0");
        require!(!invoice_id.is_empty() && invoice_id.len() <= MAX_INVOICE_LEN, "invoice_id length 1-64");
        require!(memo.len() <= MAX_MEMO_LEN, "memo too long");

        let t = now();
        let mut attested_by = None;
        let mut attestation_hash = None;
        let mut attestation_key: Option<Vec<u8>> = None;

        // Hard checks: any failure is a strike.
        let hard: Option<&'static str> = if self.used_invoices.contains(&invoice_id) {
            Some("invoice_already_paid")
        } else if !self.allowlist.contains(&receiver_id) {
            Some("receiver_not_allowlisted")
        } else if amount.0 > self.policy.max_per_tx.0 {
            Some("over_per_payment_cap")
        } else {
            match (&attestation, self.policy.require_attestation) {
                (None, true) => Some("attestation_required"),
                (None, false) => None,
                (Some(a), _) => {
                    let attesters = &self.attesters;
                    match attest::verify(
                        &a.text,
                        &a.signature,
                        &a.response_body,
                        |s| attesters.contains(&s.to_string()),
                        receiver_id.as_str(),
                        amount.0,
                        &invoice_id,
                    ) {
                        Err(e) => Some(e),
                        Ok(v) => {
                            if self.used_attestations.contains(&v.text_hash) {
                                Some("attestation_replayed")
                            } else if v.created > t + FUTURE_SKEW_SECS
                                || t.saturating_sub(v.created) > self.policy.max_attestation_age_secs
                            {
                                Some("attestation_stale")
                            } else {
                                attested_by = Some(v.signer);
                                attestation_hash = Some(hex::encode(&v.text_hash));
                                // Consumed only once the payment goes through (paid or queued),
                                // so a soft refusal (cooldown, budget) does not burn the decision.
                                attestation_key = Some(v.text_hash);
                                None
                            }
                        }
                    }
                }
            }
        };

        if let Some(reason) = hard {
            return self.refuse(&pk, &mut agent, receiver_id, amount, invoice_id, memo, reason, true);
        }

        // Soft checks: refused, no strike (the agent may legitimately retry later).
        self.prune_window(t);
        let in_window: u128 = self.window.iter().map(|(_, a)| a).sum();
        let soft: Option<&'static str> = if self.paused {
            Some("vault_paused")
        } else if in_window + amount.0 > self.policy.max_per_window.0 {
            Some("window_budget_exhausted")
        } else if self.last_spend_ts > 0 && t < self.last_spend_ts + self.policy.cooldown_secs {
            Some("cooldown")
        } else if amount.0 > self.available() {
            Some("insufficient_balance")
        } else if amount.0 > self.policy.approval_above.0 && self.pending.len() >= MAX_PENDING {
            Some("approval_queue_full")
        } else {
            None
        };
        if let Some(reason) = soft {
            return self.refuse(&pk, &mut agent, receiver_id, amount, invoice_id, memo, reason, false);
        }

        self.used_invoices.insert(invoice_id.clone());
        if let Some(k) = attestation_key {
            self.used_attestations.insert(k);
        }

        if amount.0 > self.policy.approval_above.0 {
            let id = self.next_pending;
            self.next_pending += 1;
            self.pending.insert(
                id,
                Pending {
                    id,
                    created_at: t,
                    agent: agent.name.clone(),
                    receiver_id: receiver_id.clone(),
                    amount,
                    invoice_id: invoice_id.clone(),
                    memo: memo.clone(),
                    attested_by: attested_by.clone(),
                    attestation_hash: attestation_hash.clone(),
                },
            );
            agent.queued += 1;
            self.agents.insert(pk, agent.clone());
            let entry_id = self.push_log("queued", &agent.name, Some(receiver_id), amount, invoice_id, memo,
                format!("pending_id={id}"), false, attested_by, attestation_hash);
            return SpendResult { status: "queued".into(), reason: format!("pending_id={id}"), entry_id, strike: false, agent_revoked: false };
        }

        agent.paid += 1;
        self.agents.insert(pk, agent.clone());
        let entry_id = self.pay(t, &agent.name, receiver_id, amount, invoice_id, memo, "paid", attested_by, attestation_hash);
        SpendResult { status: "paid".into(), reason: String::new(), entry_id, strike: false, agent_revoked: false }
    }

    /// Callback after a transfer. Rolls the budget back if the transfer failed.
    #[private]
    pub fn on_paid(&mut self, entry_id: u64, ts: u64, amount: U128, invoice_id: String) {
        // A transfer returns no data; any successful result means the money moved.
        if env::promise_result_checked(0, 64).is_ok() {
            return;
        }
        if let Some(pos) = self.window.iter().position(|(t, a)| *t == ts && *a == amount.0) {
            self.window.remove(pos);
        }
        self.spent_total = self.spent_total.saturating_sub(amount.0);
        self.used_invoices.remove(&invoice_id);
        if let Some(e) = self.log.get_mut(&entry_id) {
            e.kind = "failed".into();
            e.reason = "transfer_failed_refunded".into();
        }
        emit("spend_failed", near_sdk::serde_json::json!({"entry_id": entry_id, "invoice_id": invoice_id}));
    }

    // ------------------------------------------------------------------
    // Owner methods (full-access key only: 1 yoctoNEAR attached)
    // ------------------------------------------------------------------

    /// Give an agent a function-call key on this vault, limited to `spend`.
    #[payable]
    pub fn add_agent(&mut self, public_key: PublicKey, name: String, gas_allowance: U128) -> Promise {
        self.assert_owner_yocto();
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, "name length 1-32");
        require!(self.agents.get(&public_key).map_or(true, |a| !a.active), "key is already an active agent");
        require!(gas_allowance.0 > 0, "gas_allowance must be > 0");
        self.agents.insert(
            public_key.clone(),
            Agent { name: name.clone(), active: true, added_at: now(), strikes: vec![], paid: 0, refused: 0, queued: 0 },
        );
        self.push_log("agent_added", &name, None, U128(0), String::new(), String::new(), String::new(), false, None, None);
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            Allowance::limited(NearToken::from_yoctonear(gas_allowance.0)).unwrap_or_else(|| env::panic_str("bad allowance")),
            env::current_account_id(),
            "spend".to_string(),
        )
    }

    /// Remove an agent and delete its key from the vault account.
    #[payable]
    pub fn remove_agent(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner_yocto();
        let mut a = self.agents.get(&public_key).cloned().unwrap_or_else(|| env::panic_str("unknown agent"));
        require!(a.active, "agent already inactive");
        a.active = false;
        let name = a.name.clone();
        self.agents.insert(public_key.clone(), a);
        self.push_log("agent_removed", &name, None, U128(0), String::new(), String::new(), "owner".into(), false, None, None);
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    #[payable]
    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner_yocto();
        validate_policy(&policy);
        self.policy = policy;
        emit("policy_set", near_sdk::serde_json::json!({"by": self.owner}));
    }

    #[payable]
    pub fn allow(&mut self, accounts: Vec<AccountId>) {
        self.assert_owner_yocto();
        for a in accounts {
            self.allowlist.insert(a);
        }
    }

    #[payable]
    pub fn disallow(&mut self, accounts: Vec<AccountId>) {
        self.assert_owner_yocto();
        for a in accounts {
            self.allowlist.remove(&a);
        }
    }

    /// Register the TEE signing addresses (0x...) of NEAR AI Cloud models you trust.
    /// Verify them first against the attestation report (see scripts/attestation.ts).
    #[payable]
    pub fn set_attesters(&mut self, attesters: Vec<String>) {
        self.assert_owner_yocto();
        require!(attesters.len() as u32 <= MAX_ATTESTERS, "too many attesters");
        self.attesters.clear();
        for a in attesters {
            let a = a.to_lowercase();
            require!(a.len() == 42 && a.starts_with("0x") && hex::decode(&a[2..]).is_ok(), "attester must be a 0x address");
            self.attesters.insert(a);
        }
    }

    /// Kill switch. No deposit needed so it can be hit fast from any owner key.
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit("paused", near_sdk::serde_json::json!({}));
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner_yocto();
        self.paused = false;
        emit("unpaused", near_sdk::serde_json::json!({}));
    }

    /// Approve a queued payment. Still bounded by balance and allowlist.
    #[payable]
    pub fn approve(&mut self, pending_id: u64) {
        self.assert_owner_yocto();
        let p = self.pending.remove(&pending_id).unwrap_or_else(|| env::panic_str("unknown pending_id"));
        require!(self.allowlist.contains(&p.receiver_id), "receiver no longer allowlisted");
        require!(p.amount.0 <= self.available(), "insufficient balance");
        let t = now();
        self.prune_window(t);
        self.pay(t, &p.agent, p.receiver_id, p.amount, p.invoice_id, p.memo, "approved", p.attested_by, p.attestation_hash);
    }

    #[payable]
    pub fn reject(&mut self, pending_id: u64) {
        self.assert_owner_yocto();
        let p = self.pending.remove(&pending_id).unwrap_or_else(|| env::panic_str("unknown pending_id"));
        self.push_log("rejected", &p.agent, Some(p.receiver_id), p.amount, p.invoice_id, p.memo, "owner".into(), false, None, None);
    }

    /// Owner withdraws funds from the vault.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner_yocto();
        require!(amount.0 <= self.available() + self.policy.reserve.0, "insufficient balance");
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    #[payable]
    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner_yocto();
        require!(new_owner != env::current_account_id(), "owner must be a different account than the vault");
        self.owner = new_owner;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_status(&self) -> Status {
        let t = now();
        let in_window: u128 = self.window.iter().filter(|(ts, _)| t < ts + self.policy.window_secs).map(|(_, a)| a).sum();
        Status {
            owner: self.owner.clone(),
            paused: self.paused,
            balance: U128(env::account_balance().as_yoctonear()),
            available: U128(self.available()),
            spent_in_window: U128(in_window),
            window_remaining: U128(self.policy.max_per_window.0.saturating_sub(in_window)),
            spent_total: U128(self.spent_total),
            last_spend_ts: self.last_spend_ts,
            now: t,
            log_len: self.log_len,
            pending: self.pending.len(),
            agents: self.agents.len(),
            active_agents: self.agents.values().filter(|a| a.active).count() as u32,
            allowlist: self.allowlist.len(),
            attesters: self.attesters.len(),
        }
    }

    pub fn get_allowlist(&self) -> Vec<AccountId> {
        self.allowlist.iter().cloned().collect()
    }

    pub fn get_attesters(&self) -> Vec<String> {
        self.attesters.iter().cloned().collect()
    }

    pub fn get_agents(&self) -> Vec<AgentView> {
        self.agents.iter().map(|(k, a)| AgentView { public_key: k.clone(), agent: a.clone() }).collect()
    }

    pub fn get_pending(&self) -> Vec<Pending> {
        self.pending.values().cloned().collect()
    }

    /// Newest first when `from_index` is omitted. Only the last 250 entries are retained.
    pub fn get_log(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Entry> {
        let len = self.log_len;
        let oldest = len.saturating_sub(MAX_LOG);
        let limit = limit.unwrap_or(50).min(MAX_LOG_PAGE);
        match from_index {
            Some(from) => (from.max(oldest)..len.min(from.max(oldest) + limit)).filter_map(|i| self.log.get(&i).cloned()).collect(),
            None => (len.saturating_sub(limit).max(oldest)..len).rev().filter_map(|i| self.log.get(&i).cloned()).collect(),
        }
    }

    pub fn is_invoice_used(&self, invoice_id: String) -> bool {
        self.used_invoices.contains(&invoice_id)
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_owner_yocto(&self) {
        self.assert_owner();
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "attach exactly 1 yoctoNEAR (owner methods need a full-access key)"
        );
    }

    /// Spendable balance: account balance minus storage staking minus reserve.
    fn available(&self) -> u128 {
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance().as_yoctonear().saturating_sub(storage).saturating_sub(self.policy.reserve.0)
    }

    fn prune_window(&mut self, t: u64) {
        let w = self.policy.window_secs;
        self.window.retain(|(ts, _)| t < ts + w);
    }

    #[allow(clippy::too_many_arguments)]
    fn pay(
        &mut self,
        t: u64,
        agent: &str,
        receiver_id: AccountId,
        amount: U128,
        invoice_id: String,
        memo: String,
        kind: &str,
        attested_by: Option<String>,
        attestation_hash: Option<String>,
    ) -> u64 {
        self.window.push((t, amount.0));
        self.last_spend_ts = t;
        self.spent_total += amount.0;
        let entry_id = self.push_log(kind, agent, Some(receiver_id.clone()), amount, invoice_id.clone(), memo,
            String::new(), false, attested_by, attestation_hash);
        Promise::new(receiver_id)
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_paid(entry_id, t, amount, invoice_id))
            .detach();
        entry_id
    }

    #[allow(clippy::too_many_arguments)]
    fn refuse(
        &mut self,
        pk: &PublicKey,
        agent: &mut Agent,
        receiver_id: AccountId,
        amount: U128,
        invoice_id: String,
        memo: String,
        reason: &str,
        strike: bool,
    ) -> SpendResult {
        let t = now();
        agent.refused += 1;
        let mut revoked = false;
        if strike {
            let w = self.policy.strike_window_secs;
            agent.strikes.retain(|ts| t < ts + w);
            agent.strikes.push(t);
            if agent.strikes.len() as u32 >= self.policy.strike_limit {
                agent.active = false;
                revoked = true;
            }
        }
        self.agents.insert(pk.clone(), agent.clone());
        let entry_id = self.push_log("refused", &agent.name, Some(receiver_id), amount, invoice_id, memo, reason.into(),
            strike, None, None);
        if revoked {
            self.push_log("revoked", &agent.name, None, U128(0), String::new(), String::new(),
                format!("{} strikes in {}s", agent.strikes.len(), self.policy.strike_window_secs), false, None, None);
            Promise::new(env::current_account_id()).delete_key(pk.clone()).detach();
        }
        SpendResult { status: "refused".into(), reason: reason.into(), entry_id, strike, agent_revoked: revoked }
    }

    #[allow(clippy::too_many_arguments)]
    fn push_log(
        &mut self,
        kind: &str,
        agent: &str,
        receiver_id: Option<AccountId>,
        amount: U128,
        invoice_id: String,
        memo: String,
        reason: String,
        strike: bool,
        attested_by: Option<String>,
        attestation_hash: Option<String>,
    ) -> u64 {
        let id = self.log_len;
        let e = Entry {
            id,
            ts: now(),
            kind: kind.into(),
            agent: agent.into(),
            receiver_id,
            amount,
            invoice_id,
            memo,
            reason,
            strike,
            attested_by,
            attestation_hash,
        };
        emit(kind, near_sdk::serde_json::to_value(&e).unwrap_or_default());
        self.log.insert(id, e);
        self.log_len += 1;
        if id >= MAX_LOG {
            self.log.remove(&(id - MAX_LOG));
        }
        id
    }
}

#[cfg(test)]
mod tests;
