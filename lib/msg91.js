// MSG91 SMS OTP integration for delivery confirmation - OTP WIDGET API.
//
// Per explicit direction (Option A): OTP generation, sending, and
// verification are ALL delegated to MSG91's own OTP API rather than
// handled locally.
//
// IMPORTANT: this uses MSG91's OTP WIDGET API specifically
// (api.msg91.com/api/v5/widget/...), NOT the separate "SendOTP" REST
// API (control.msg91.com/api/v5/otp) initially built against. Found
// via a real, reproduced failure: the SendOTP REST API requires the
// caller's OWN DLT-registered template_id - genuine DLT registration
// through a telecom operator, a multi-day regulatory process, not
// something MSG91 provides by default. The Widget API instead uses
// MSG91's own pre-approved default template (their own docs: "A
// default SMS template is being provided by MSG91 to use till your
// template is not approved on DLT"), avoiding that requirement
// entirely - matching what the user actually has access to.
//
// Confirmed directly from MSG91's own interactive API docs
// (docs.msg91.com/otp-widget/send-otp-1 and .../verify-otp), not
// inferred from third-party wrapper libraries this time, after an
// earlier integration attempt silently failed against a different,
// incorrect API shape.
//
// The security boundary this feeds into - executeSingleActor()'s
// otpVerified gate in lib/v2/transitionEngine.js - is completely
// unchanged: only a successful call to verifyDeliveryOtpMsg91() should
// ever result in otpVerified=true being passed through.

const WIDGET_BASE_URL = 'https://api.msg91.com/api/v5/widget';

function requireConfig() {
  // NOTE: MSG91's own docs label this header generically as
  // "authkey" with no distinction from the account-level Auth Key -
  // despite the widget's own embed snippet pairing widgetId with a
  // separate tokenAuth value, a real "Authentication failure" error
  // with confirmed-correct MSG91_WIDGET_TOKEN/MSG91_WIDGET_ID values
  // suggests the server-side widget API may actually expect the
  // ACCOUNT-level Auth Key here instead, matching the docs page's own
  // plain "authkey" label. Using MSG91_AUTH_KEY (the account key from
  // Settings -> Authkey) as the fallback/primary now, since the more
  // specific tokenAuth guess was tried first and failed.
  const authkey = process.env.MSG91_AUTH_KEY || process.env.MSG91_WIDGET_TOKEN;
  const widgetId = process.env.MSG91_WIDGET_ID;
  if (!authkey || !widgetId) {
    throw new Error('MSG91 OTP sending is not configured - missing MSG91_AUTH_KEY (or MSG91_WIDGET_TOKEN) or MSG91_WIDGET_ID environment variable.');
  }
  return { authkey, widgetId };
}

// Normalizes a phone number into the international format (country
// code + number, digits only, no "+") that MSG91's API requires.
// Found via a real, reproduced bug: customers.phone in this app
// stores plain 10-digit Indian numbers with no country code at all
// (e.g. "7573800773"). Assumes India (+91) specifically, matching
// this app's only currently-known market - a 10-digit number gets
// "91" prepended; a number already 12 digits starting with "91" is
// left as-is; any other length/prefix is passed through unchanged
// rather than guessed at.
function normalizeIndianMobile(phone) {
  const digitsOnly = String(phone).replace(/\D/g, '');
  if (digitsOnly.length === 10) return `91${digitsOnly}`;
  return digitsOnly;
}

// Sends a delivery-confirmation OTP via MSG91's Widget API. MSG91
// generates the actual code itself (using their own pre-approved
// default template) - we never see or store it. Returns the `reqId`
// from MSG91's response, which the CALLER must persist (on the keg)
// and pass back into verifyDeliveryOtpMsg91() later - unlike the
// SendOTP REST API, the Widget API's verify call is keyed by this
// request ID, not by the phone number alone.
async function sendDeliveryOtpMsg91(phone) {
  const { authkey, widgetId } = requireConfig();
  const identifier = normalizeIndianMobile(phone);

  const res = await fetch(`${WIDGET_BASE_URL}/sendOtp`, {
    method: 'POST',
    headers: {
      authkey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ widgetId, identifier }),
  });

  const data = await res.json().catch(() => ({}));
  // Diagnostic logging, kept from the earlier debugging round - shows
  // MSG91's actual raw response in server logs (never logs the phone
  // number itself), so a mismatch between "our code thinks this
  // succeeded" and what MSG91 actually did can be seen directly
  // rather than guessed at blindly.
  console.log('[msg91] widget sendOtp response:', res.status, JSON.stringify(data));

  // MSG91's Widget API reports success via `type` (same convention as
  // their SendOTP REST API) - a non-2xx HTTP status OR type !==
  // 'success' both mean the send failed and must not be treated as
  // though a code went out.
  if (!res.ok || data.type !== 'success') {
    const reason = data.message || `HTTP ${res.status}`;
    throw new Error(`MSG91 OTP send failed: ${reason}`);
  }
  if (!data.message) {
    // The reqId is documented as coming back in the response, under
    // `message` per MSG91's own success-object convention seen
    // elsewhere in their API family - fail loudly here rather than
    // silently proceeding with an undefined reqId that would only
    // surface as a confusing verify-time failure later.
    throw new Error('MSG91 OTP send succeeded but no reqId was returned in the response - cannot verify later.');
  }
  return { reqId: data.message };
}

// Verifies a submitted OTP against MSG91's own records, using the
// reqId returned from the original sendDeliveryOtpMsg91() call for
// this same delivery attempt. Returns true only on MSG91's own
// explicit success response; every other outcome (wrong code,
// expired, network/API error) returns false, never throws, so a
// transient MSG91-side failure can never be mistaken for a verified
// delivery.
async function verifyDeliveryOtpMsg91(reqId, submittedCode) {
  const { authkey, widgetId } = requireConfig();

  let res;
  let data;
  try {
    res = await fetch(`${WIDGET_BASE_URL}/verifyOtp`, {
      method: 'POST',
      headers: {
        authkey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ widgetId, reqId, otp: String(submittedCode) }),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    return false;
  }
  console.log('[msg91] widget verifyOtp response:', res.status, JSON.stringify(data));
  return res.ok && data.type === 'success';
}

module.exports = { sendDeliveryOtpMsg91, verifyDeliveryOtpMsg91 };
