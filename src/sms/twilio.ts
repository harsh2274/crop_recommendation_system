// Twilio: verify inbound webhooks, send outbound SMS. Without credentials (local dev),
// outbound messages are printed to the console instead of sent.
import type { Env } from "../env";

const MAX_SMS_CHARS = 1500; // Twilio rejects bodies over 1600 characters

/** X-Twilio-Signature = base64(HMAC-SHA1(authToken, url + sorted(key + value)...)). */
export async function verifySignature(authToken: string, url: string, params: Record<string, string>, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/** Empty TwiML: we acknowledge now and reply later through the REST API. */
export const emptyTwiml = () =>
  new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", { headers: { "content-type": "text/xml" } });

export async function sendSms(env: Env, to: string, body: string): Promise<void> {
  for (const part of splitMessage(body)) {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
      console.log(`[sms -> ${to}] ${part}`);
      continue;
    }
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: env.TWILIO_PHONE_NUMBER, Body: part }),
    });
    if (!res.ok) throw new Error(`Twilio send failed: HTTP ${res.status} ${await res.text()}`);
  }
}

function splitMessage(body: string): string[] {
  const parts: string[] = [];
  let rest = body.trim();
  while (rest.length > MAX_SMS_CHARS) {
    const cut = Math.max(rest.lastIndexOf("\n", MAX_SMS_CHARS), rest.lastIndexOf(" ", MAX_SMS_CHARS), MAX_SMS_CHARS / 2);
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
