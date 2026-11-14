// Bindings and secrets (see wrangler.jsonc and SMS.md "Secrets").
import type { FarmerSession } from "./sms/session";

export interface Env {
  AI: Ai; // Workers AI: reads farmer messages into fields and translates code-written texts
  CACHE?: KVNamespace;
  DB: D1Database; // market data (prices, CPI, USDA supply/demand), written by the monthly ingestion
  FARMER: DurableObjectNamespace<FarmerSession>; // one Agent per farmer
  SELF: Fetcher; // this Worker, so agents run the analysis in a separate invocation (own connection pool)
  OPENTOPO_API_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string; // the service number farmers text (NOT the Dev Phone's own number)
  ADMIN_TOKEN?: string; // protects POST /admin/ingest
  ALLOW_UNSIGNED_SMS?: string; // "true" only in .dev.vars for curl testing
}
