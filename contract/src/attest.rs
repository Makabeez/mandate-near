//! On-chain verification of NEAR AI Cloud response signatures.
//!
//! NEAR AI Cloud signs every chat completion with a key that lives inside a
//! TEE. The signed text is `<model>:<sha256(request)>:<sha256(response)>`
//! (provider_tee) or `<sha256(request)>:<sha256(response)>` (gateway), and the
//! signature is an Ethereum EIP-191 personal_sign signature (ecdsa).
//!
//! The vault re-checks all of it on-chain:
//!   1. recover the signer from the EIP-191 signature (env::ecrecover),
//!   2. require the signer to be an attester the owner registered,
//!   3. require sha256(response_body) to equal the response hash in the text,
//!   4. parse the model's decision out of the response and require it to name
//!      exactly the receiver, amount and invoice the agent is trying to pay.
//!
//! So an agent cannot pay anything the attested model did not decide, and it
//! cannot reuse one decision for a different payment.

use near_sdk::env;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, Value};

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Decision {
    action: String,
    receiver_id: String,
    amount_near: String,
    invoice_id: String,
}

/// What a verified attestation proves.
pub struct Verified {
    /// 0x-prefixed lowercase Ethereum address of the TEE signing key.
    pub signer: String,
    /// sha256 of the signed text, hex. Used for replay protection and logs.
    pub text_hash: Vec<u8>,
    /// `created` timestamp of the model response, seconds.
    pub created: u64,
}

/// Recover the 0x address that EIP-191-signed `text`.
pub fn recover_eip191(text: &str, signature_hex: &str) -> Result<String, &'static str> {
    let sig = hex::decode(signature_hex.trim_start_matches("0x")).map_err(|_| "signature_not_hex")?;
    if sig.len() != 65 {
        return Err("signature_wrong_length");
    }
    let v = match sig[64] {
        27 | 28 => sig[64] - 27,
        0 | 1 => sig[64],
        _ => return Err("signature_bad_v"),
    };
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let hash = env::keccak256_array(&msg);
    let pubkey = env::ecrecover(&hash, &sig[..64], v, true).ok_or("signature_unrecoverable")?;
    let addr_hash = env::keccak256_array(&pubkey);
    Ok(format!("0x{}", hex::encode(&addr_hash[12..])))
}

/// Parse a decimal NEAR amount ("0.25", "1", "0.000001") into yoctoNEAR exactly.
pub fn parse_near(s: &str) -> Option<u128> {
    let s = s.trim();
    if s.is_empty() || s.starts_with('-') || s.starts_with('+') {
        return None;
    }
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    if whole.is_empty() && frac.is_empty() {
        return None;
    }
    if !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if frac.len() > 24 {
        return None;
    }
    let whole: u128 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
    let mut frac_padded = frac.to_string();
    while frac_padded.len() < 24 {
        frac_padded.push('0');
    }
    let frac: u128 = frac_padded.parse().ok()?;
    whole.checked_mul(10u128.pow(24))?.checked_add(frac)
}

/// Extract the decision JSON object from the model's message content.
/// The model is asked to answer with one JSON object; we tolerate code fences
/// or text around it by taking the outermost `{...}`.
fn extract_decision(content: &str) -> Option<Decision> {
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&content[start..=end]).ok()
}

/// Full verification. Returns the reason code on failure.
pub fn verify(
    text: &str,
    signature_hex: &str,
    response_body: &str,
    is_attester: impl Fn(&str) -> bool,
    receiver_id: &str,
    amount_yocto: u128,
    invoice_id: &str,
) -> Result<Verified, &'static str> {
    let signer = recover_eip191(text, signature_hex)?;
    if !is_attester(&signer) {
        return Err("attestation_unknown_signer");
    }

    // The response hash is always the last ':'-separated field of the text.
    let resp_hash_hex = text.rsplit(':').next().ok_or("attestation_text_malformed")?;
    let actual = hex::encode(env::sha256_array(response_body.as_bytes()));
    if !resp_hash_hex.eq_ignore_ascii_case(&actual) {
        return Err("attestation_response_hash_mismatch");
    }

    let v: Value = serde_json::from_str(response_body).map_err(|_| "attestation_response_not_json")?;
    let created = v.get("created").and_then(Value::as_u64).ok_or("attestation_no_created")?;
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .ok_or("attestation_no_content")?;
    let d = extract_decision(content).ok_or("decision_unparseable")?;
    if d.action != "pay" {
        return Err("decision_not_pay");
    }
    if d.receiver_id != receiver_id {
        return Err("decision_receiver_mismatch");
    }
    if parse_near(&d.amount_near) != Some(amount_yocto) {
        return Err("decision_amount_mismatch");
    }
    if d.invoice_id != invoice_id {
        return Err("decision_invoice_mismatch");
    }

    Ok(Verified { signer, text_hash: env::sha256_array(text.as_bytes()).to_vec(), created })
}

#[cfg(test)]
mod tests {
    use super::parse_near;

    #[test]
    fn parses_near_amounts_exactly() {
        assert_eq!(parse_near("1"), Some(10u128.pow(24)));
        assert_eq!(parse_near("0.25"), Some(25 * 10u128.pow(22)));
        assert_eq!(parse_near(".5"), Some(5 * 10u128.pow(23)));
        assert_eq!(parse_near("0.000000000000000000000001"), Some(1));
        assert_eq!(parse_near("1.0000000000000000000000001"), None); // 25 decimals
        assert_eq!(parse_near("-1"), None);
        assert_eq!(parse_near("1e3"), None);
        assert_eq!(parse_near(""), None);
        assert_eq!(parse_near("."), None);
    }
}
