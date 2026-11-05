use super::*;
use k256::ecdsa::SigningKey;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;
use sha3::{Digest, Keccak256};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const T0: u64 = 1_800_000_000; // seconds

fn vault() -> AccountId {
    "vault.test.near".parse().unwrap()
}
fn owner() -> AccountId {
    accounts(0)
}
fn merchant() -> AccountId {
    "api-provider.test.near".parse().unwrap()
}
fn attacker() -> AccountId {
    "attacker.test.near".parse().unwrap()
}
fn agent_pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}

fn policy() -> Policy {
    Policy {
        max_per_tx: U128(NEAR),            // 1 NEAR
        max_per_window: U128(3 * NEAR),    // 3 NEAR / day
        window_secs: 86_400,
        approval_above: U128(NEAR / 2),    // > 0.5 NEAR needs the owner
        cooldown_secs: 10,
        strike_limit: 3,
        strike_window_secs: 3_600,
        require_attestation: false,
        max_attestation_age_secs: 600,
        reserve: U128(NEAR),
    }
}

/// Context where the call comes from `predecessor`, signed by `signer_pk`.
fn ctx(predecessor: AccountId, signer_pk: PublicKey, ts_secs: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .signer_account_pk(signer_pk)
        .block_timestamp(ts_secs * 1_000_000_000)
        .account_balance(NearToken::from_yoctonear(50 * NEAR))
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}

fn as_agent(ts: u64) {
    ctx(vault(), agent_pk(), ts, 0);
}
fn as_owner(ts: u64) {
    ctx(owner(), "ed25519:Eg2jtsiMrprn7zgKKUk79qM1hWhANsFyE6JSX4txLEuy".parse().unwrap(), ts, 1);
}

fn setup() -> Mandate {
    ctx(vault(), agent_pk(), T0, 0);
    let mut c = Mandate::new(owner(), policy(), vec![merchant()]);
    as_owner(T0);
    let _ = c.add_agent(agent_pk(), "ops-agent".into(), U128(NEAR / 4));
    c
}

fn spend(c: &mut Mandate, to: AccountId, amount: u128, invoice: &str) -> SpendResult {
    c.spend(to, U128(amount), invoice.into(), None, None)
}

#[test]
fn pays_inside_policy() {
    let mut c = setup();
    as_agent(T0 + 1);
    let r = spend(&mut c, merchant(), NEAR / 10, "inv-1");
    assert_eq!(r.status, "paid");
    assert!(c.is_invoice_used("inv-1".into()));
    assert_eq!(c.get_status().spent_in_window.0, NEAR / 10);
}

#[test]
fn hard_violations_are_strikes_and_third_strike_revokes_the_key() {
    let mut c = setup();
    as_agent(T0 + 1);
    let r1 = spend(&mut c, attacker(), NEAR / 10, "inj-1");
    assert_eq!((r1.status.as_str(), r1.reason.as_str(), r1.strike), ("refused", "receiver_not_allowlisted", true));
    let r2 = spend(&mut c, merchant(), 2 * NEAR, "inj-2");
    assert_eq!(r2.reason, "over_per_payment_cap");
    assert!(!r2.agent_revoked);
    let r3 = spend(&mut c, attacker(), NEAR, "inj-3");
    assert!(r3.agent_revoked);
    let a = &c.get_agents()[0];
    assert!(!a.agent.active);
    assert_eq!(c.get_log(None, Some(1))[0].kind, "revoked");
}

#[test]
#[should_panic(expected = "agent is revoked")]
fn revoked_agent_cannot_spend_even_before_key_deletion_lands() {
    let mut c = setup();
    as_agent(T0 + 1);
    for i in 0..3 {
        spend(&mut c, attacker(), NEAR / 10, &format!("x{i}"));
    }
    spend(&mut c, merchant(), NEAR / 10, "legit");
}

#[test]
fn strikes_expire_outside_the_window() {
    let mut c = setup();
    as_agent(T0 + 1);
    spend(&mut c, attacker(), 1, "a");
    spend(&mut c, attacker(), 1, "b");
    as_agent(T0 + 1 + 3_601);
    let r = spend(&mut c, attacker(), 1, "c");
    assert!(r.strike && !r.agent_revoked);
}

#[test]
fn soft_refusals_do_not_strike() {
    let mut c = setup();
    as_agent(T0 + 1);
    assert_eq!(spend(&mut c, merchant(), NEAR / 2, "i1").status, "paid");
    let r = spend(&mut c, merchant(), NEAR / 2, "i2");
    assert_eq!((r.reason.as_str(), r.strike), ("cooldown", false));
    // Fill the window: 0.5 + 0.5 + 0.5 + 0.5 + 0.5 + 0.5 = 3 NEAR, then the 7th is over budget.
    for (k, i) in (2..7).enumerate() {
        as_agent(T0 + 20 * (k as u64 + 1));
        assert_eq!(spend(&mut c, merchant(), NEAR / 2, &format!("w{i}")).status, "paid");
    }
    as_agent(T0 + 500);
    let r = spend(&mut c, merchant(), NEAR / 2, "over");
    assert_eq!((r.reason.as_str(), r.strike), ("window_budget_exhausted", false));
    // Next day the budget is back.
    as_agent(T0 + 86_400 + 200);
    assert_eq!(spend(&mut c, merchant(), NEAR / 2, "next-day").status, "paid");
}

#[test]
fn replayed_invoice_is_a_strike() {
    let mut c = setup();
    as_agent(T0 + 1);
    spend(&mut c, merchant(), NEAR / 10, "inv-1");
    as_agent(T0 + 30);
    let r = spend(&mut c, merchant(), NEAR / 10, "inv-1");
    assert_eq!((r.reason.as_str(), r.strike), ("invoice_already_paid", true));
}

#[test]
fn large_payment_waits_for_owner() {
    let mut c = setup();
    as_agent(T0 + 1);
    let r = spend(&mut c, merchant(), 9 * NEAR / 10, "big");
    assert_eq!(r.status, "queued");
    assert_eq!(c.get_pending().len(), 1);
    as_owner(T0 + 5);
    c.approve(0);
    assert!(c.get_pending().is_empty());
    assert_eq!(c.get_log(None, Some(1))[0].kind, "approved");
}

#[test]
fn paused_vault_refuses_without_strike() {
    let mut c = setup();
    as_owner(T0);
    c.pause();
    as_agent(T0 + 1);
    let r = spend(&mut c, merchant(), 1, "p");
    assert_eq!((r.reason.as_str(), r.strike), ("vault_paused", false));
}

#[test]
fn reserve_is_untouchable() {
    let mut c = setup();
    as_owner(T0);
    let mut p = policy();
    p.reserve = U128(49 * NEAR + NEAR / 2);
    p.approval_above = U128(NEAR);
    c.set_policy(p);
    as_agent(T0 + 1);
    let r = spend(&mut c, merchant(), NEAR, "r");
    assert_eq!(r.reason, "insufficient_balance");
}

#[test]
#[should_panic(expected = "signer key is not an agent")]
fn unknown_key_cannot_spend() {
    let mut c = setup();
    ctx(vault(), "ed25519:Eg2jtsiMrprn7zgKKUk79qM1hWhANsFyE6JSX4txLEuy".parse().unwrap(), T0 + 1, 0);
    spend(&mut c, merchant(), 1, "u");
}

#[test]
#[should_panic(expected = "spend must be signed with an agent key")]
fn spend_from_other_account_rejected() {
    let mut c = setup();
    ctx(attacker(), agent_pk(), T0 + 1, 0);
    spend(&mut c, merchant(), 1, "o");
}

#[test]
#[should_panic(expected = "attach exactly 1 yoctoNEAR")]
fn owner_methods_need_full_access_key() {
    let mut c = setup();
    ctx(owner(), agent_pk(), T0, 0);
    c.allow(vec![attacker()]);
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_call_owner_methods() {
    let mut c = setup();
    ctx(vault(), agent_pk(), T0, 1);
    c.allow(vec![attacker()]);
}

// --------------------------------------------------------------------------
// Attestation: emulate the NEAR AI Cloud TEE signer with a local secp256k1 key
// --------------------------------------------------------------------------

fn tee_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32].into()).unwrap()
}

fn eth_address(k: &SigningKey) -> String {
    let pt = k.verifying_key().to_encoded_point(false);
    let h = Keccak256::digest(&pt.as_bytes()[1..]);
    format!("0x{}", hex::encode(&h[12..]))
}

fn eip191_sign(k: &SigningKey, text: &str) -> String {
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let hash = Keccak256::digest(&msg);
    let (sig, rec) = k.sign_prehash_recoverable(&hash).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(27 + rec.to_byte());
    format!("0x{}", hex::encode(out))
}

fn sha256_hex(s: &str) -> String {
    hex::encode(env::sha256_array(s.as_bytes()))
}

fn attestation(k: &SigningKey, to: &str, amount_near: &str, invoice: &str, created: u64) -> Attestation {
    let content = format!(
        "{{\"action\":\"pay\",\"receiver_id\":\"{to}\",\"amount_near\":\"{amount_near}\",\"invoice_id\":\"{invoice}\",\"reason\":\"matches contract\"}}"
    );
    let body = near_sdk::serde_json::json!({
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": created,
        "model": "zai-org/GLM-5.1-FP8",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]
    })
    .to_string();
    let text = format!("zai-org/GLM-5.1-FP8:{}:{}", sha256_hex("{\"request\":true}"), sha256_hex(&body));
    Attestation { signature: eip191_sign(k, &text), text, response_body: body }
}

fn setup_attested() -> Mandate {
    let mut c = setup();
    as_owner(T0);
    let mut p = policy();
    p.require_attestation = true;
    c.set_policy(p);
    c.set_attesters(vec![eth_address(&tee_key())]);
    c
}

#[test]
fn eip191_recovery_matches_reference_address() {
    ctx(vault(), agent_pk(), T0, 0);
    let k = tee_key();
    let sig = eip191_sign(&k, "hello");
    assert_eq!(attest::recover_eip191("hello", &sig).unwrap(), eth_address(&k));
}

#[test]
fn attested_decision_pays() {
    let mut c = setup_attested();
    as_agent(T0 + 10);
    let a = attestation(&tee_key(), merchant().as_str(), "0.2", "inv-a", T0 + 5);
    let r = c.spend(merchant(), U128(NEAR / 5), "inv-a".into(), None, Some(a));
    assert_eq!(r.status, "paid", "{r:?}");
    let e = &c.get_log(None, Some(1))[0];
    assert_eq!(e.attested_by.as_deref(), Some(eth_address(&tee_key()).as_str()));
}

#[test]
fn missing_attestation_is_a_strike_when_required() {
    let mut c = setup_attested();
    as_agent(T0 + 10);
    let r = spend(&mut c, merchant(), NEAR / 5, "no-att");
    assert_eq!((r.reason.as_str(), r.strike), ("attestation_required", true));
}

#[test]
fn decision_must_match_payment_exactly() {
    let mut c = setup_attested();
    as_agent(T0 + 10);
    // Model decided 0.2 to merchant; agent tries 0.9.
    let a = attestation(&tee_key(), merchant().as_str(), "0.2", "inv-b", T0 + 5);
    let r = c.spend(merchant(), U128(9 * NEAR / 10), "inv-b".into(), None, Some(a));
    assert_eq!(r.reason, "decision_amount_mismatch");
    // Model decided invoice inv-c; agent reuses it for inv-d.
    let a = attestation(&tee_key(), merchant().as_str(), "0.2", "inv-c", T0 + 5);
    let r = c.spend(merchant(), U128(NEAR / 5), "inv-d".into(), None, Some(a));
    assert_eq!(r.reason, "decision_invoice_mismatch");
}

#[test]
fn unknown_signer_and_tampered_body_are_refused() {
    let mut c = setup_attested();
    as_agent(T0 + 10);
    let rogue = SigningKey::from_bytes(&[9u8; 32].into()).unwrap();
    let a = attestation(&rogue, merchant().as_str(), "0.2", "inv-e", T0 + 5);
    let r = c.spend(merchant(), U128(NEAR / 5), "inv-e".into(), None, Some(a));
    assert_eq!(r.reason, "attestation_unknown_signer");

    let mut a = attestation(&tee_key(), merchant().as_str(), "0.2", "inv-f", T0 + 5);
    a.response_body = a.response_body.replace("0.2", "0.3");
    let r = c.spend(merchant(), U128(3 * NEAR / 10), "inv-f".into(), None, Some(a));
    assert_eq!(r.reason, "attestation_response_hash_mismatch");
}

#[test]
fn attestation_cannot_be_replayed_or_stale() {
    let mut c = setup_attested();
    let a = attestation(&tee_key(), merchant().as_str(), "0.2", "inv-g", T0 + 5);
    let a2 = Attestation { text: a.text.clone(), signature: a.signature.clone(), response_body: a.response_body.clone() };
    as_agent(T0 + 10);
    assert_eq!(c.spend(merchant(), U128(NEAR / 5), "inv-g".into(), None, Some(a)).status, "paid");
    as_agent(T0 + 30);
    // Same invoice is caught first; the attestation replay check covers a reused signature too.
    let r = c.spend(merchant(), U128(NEAR / 5), "inv-g".into(), None, Some(a2));
    assert_eq!(r.reason, "invoice_already_paid");

    let old = attestation(&tee_key(), merchant().as_str(), "0.1", "inv-h", T0 - 10_000);
    as_agent(T0 + 60);
    let r = c.spend(merchant(), U128(NEAR / 10), "inv-h".into(), None, Some(old));
    assert_eq!(r.reason, "attestation_stale");
}

#[test]
fn ledger_is_a_bounded_ring() {
    let mut c = setup();
    for i in 0..300u64 {
        as_agent(T0 + 1 + i);
        spend(&mut c, attacker(), 1, &format!("flood-{i}"));
        // keep the agent alive: re-arm after each revocation
        if !c.get_agents()[0].agent.active {
            as_owner(T0 + 1 + i);
            c.agents.get_mut(&agent_pk()).unwrap().active = true;
            c.agents.get_mut(&agent_pk()).unwrap().strikes.clear();
        }
    }
    let st = c.get_status();
    assert!(st.log_len > 300);
    let newest = c.get_log(None, Some(100));
    assert_eq!(newest.len(), 100);
    assert_eq!(newest[0].id, st.log_len - 1);
    // Oldest retained entry is log_len - 250; anything before is gone.
    assert!(c.get_log(Some(0), Some(5))[0].id >= st.log_len - 250);
    assert!(c.log.get(&0).is_none());
}

#[test]
fn approval_queue_is_capped() {
    let mut c = setup();
    for i in 0..20u64 {
        as_agent(T0 + 1 + i * 20);
        assert_eq!(spend(&mut c, merchant(), 6 * NEAR / 10, &format!("q{i}")).status, "queued");
    }
    as_agent(T0 + 1000);
    let r = spend(&mut c, merchant(), 6 * NEAR / 10, "q-full");
    assert_eq!((r.reason.as_str(), r.strike), ("approval_queue_full", false));
}

#[test]
fn soft_refusal_does_not_burn_the_attested_decision() {
    let mut c = setup_attested();
    as_owner(T0);
    c.pause();
    let a = attestation(&tee_key(), merchant().as_str(), "0.2", "inv-s", T0 + 5);
    let again = Attestation { text: a.text.clone(), signature: a.signature.clone(), response_body: a.response_body.clone() };
    as_agent(T0 + 10);
    assert_eq!(c.spend(merchant(), U128(NEAR / 5), "inv-s".into(), None, Some(a)).reason, "vault_paused");
    as_owner(T0 + 11);
    c.unpause();
    as_agent(T0 + 12);
    assert_eq!(c.spend(merchant(), U128(NEAR / 5), "inv-s".into(), None, Some(again)).status, "paid");
}
