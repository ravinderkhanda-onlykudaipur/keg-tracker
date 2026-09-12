// MSG91 SMS OTP integration for delivery confirmation.
//
// Per explicit direction (Option A): OTP generation, sending, and
// verification are ALL delegated to MSG91's own OTP API rather than
// handled locally - this uses MSG91's already-approved, DLT-compliant
// authentication template, avoiding the need for a separate DLT
// registration of our own custom SMS wording.
//
// This REPLACES the WhatsApp integration (lib/whatsapp.js) as the
// delivery-confirmation channel. The security boundary this feeds
// into - executeSingleActor()'s otpVerified gate in
// lib/v2/transitionEngine.js - is completely unchanged: only a
// successful call to verifyDeliveryOtpMsg91() should ever result in
// otpVerified=true being passed through.

const MSG91_BASE_URL = 'https://control.msg91.com/api/v5/otp';

function requireConfig() {
  const authkey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  if (!authkey || !templateId) {
    throw new Error('MSG91 OTP sending is not configured - missing MSG91_AUTH_KEY or MSG91_TEMPLATE_ID environment variable.');
  }
  return { authkey, templateId };
}

// Normalizes a phone number into the international format (country
// code + number, digits only, no "+") that MSG91's API requires.
// Found via a real, reproduced bug: customers.phone in this app
// stores plain 10-digit Indian numbers with no country code at all
// (e.g. "7573800773") - sent to MSG91 as-is, their API accepted the
// request and returned a success response WITHOUT ever actually
// queuing a real send, which is why the app showed "code sent" while
// MSG91's own dashboard showed zero sent OTPs and nothing arrived on
// the phone. Rather than requiring every existing customer record to
// be re-entered with a country code, this normalizes at the one point
// both send and verify actually talk to MSG91, so both call sites
// stay correct without duplicating this logic.
//
// Assumes India (+91) specifically, matching this app's only
// currently-known market - a 10-digit number gets "91" prepended; a
// number already 12 digits starting with "91" is left as-is; any
// other length/prefix is passed through unchanged rather than guessed
// at, since silently mangling an already-correct international number
// for a different country would be worse than leaving it alone.
function normalizeIndianMobile(phone) {
  const digitsOnly = String(phone).replace(/\D/g, '');
  if (digitsOnly.length === 10) return `91${digitsOnly}`;
  return digitsOnly;
}

// Sends a delivery-confirmation OTP via MSG91's own OTP API. MSG91
// generates the actual code itself (using the approved template) -
// we never see or store it.
async function sendDeliveryOtpMsg91(phone) {
  const { authkey, templateId } = requireConfig();
  const mobile = normalizeIndianMobile(phone);
  const url = `${MSG91_BASE_URL}?template_id=${encodeURIComponent(templateId)}&mobile=${encodeURIComponent(mobile)}&otp_length=6&otp_expiry=10`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authkey,
      'Content-Type': 'application/json',
    },
  });

  const data = await res.json().catch(() => ({}));
  // MSG91's own success indicator - a non-2xx HTTP status OR a
  // type !== 'success' body both mean the send failed and must not
  // be treated as though a code went out.
  if (!res.ok || data.type !== 'success') {
    const reason = data.message || `HTTP ${res.status}`;
    throw new Error(`MSG91 OTP send failed: ${reason}`);
  }
  return data;
}

// Verifies a submitted OTP against MSG91's own records for this
// phone number - MSG91 tracks the code, its expiry, and validity
// entirely on their side. Returns true only on MSG91's own explicit
// success response; every other outcome (wrong code, expired,
// network/API error) returns false, never throws, so a transient
// MSG91-side failure can never be mistaken for a verified delivery.
async function verifyDeliveryOtpMsg91(phone, submittedCode) {
  const { authkey } = requireConfig();
  const mobile = normalizeIndianMobile(phone);
  const url = `${MSG91_BASE_URL}/verify?mobile=${encodeURIComponent(mobile)}&otp=${encodeURIComponent(submittedCode)}`;

  let res;
  let data;
  try {
    res = await fetch(url, { method: 'GET', headers: { authkey } });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    return false;
  }
  return res.ok && data.type === 'success';
}

module.exports = { sendDeliveryOtpMsg91, verifyDeliveryOtpMsg91 };
