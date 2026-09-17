import "server-only";

/**
 * Couples Corner — Supabase server-side client (SERVER ONLY).
 *
 * SECURITY BOUNDARY
 * - Imports `server-only`, so any attempt to reach it from a Client Component
 *   fails the production build.
 * - The service role key (`SUPABASE_SERVICE_ROLE_KEY`) is read from
 *   server-only environment variables and must never be prefixed with
 *   `NEXT_PUBLIC_` or logged.
 * - Everything the service role client can do bypasses RLS — only trusted,
 *   server-side code paths (session routes, Server Actions, audit logging)
 *   may use it.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = stripWrappingQuotes(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const supabaseServiceRoleKey = stripWrappingQuotes(
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
).trim();

/**
 * Strip a single pair of wrapping quotes from an env value.
 *
 * Some `.env` setups pass `KEY="value"` through with the literal quotes
 * intact (e.g. values supplied via `process.env` from the shell or a
 * container platform rather than Next's own dotenv loader). Without this,
 * a correctly configured admin would hit the "not configured" fallback
 * because `'"https://…"'` is truthy but not a valid URL.
 */
function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Return the (trimmed, unquoted) service role key for ad-hoc authorization
 * headers — e.g. Storage uploads called outside the cached client's own
 * session scope. Never expose this to the client; it is server-only.
 */
export function getSupabaseServiceRoleKey(): string {
  return supabaseServiceRoleKey;
}

/**
 * Validate that the configured key is usable as a *service role* key.
 *
 * Supabase issues two key generations and both must be accepted:
 *
 *  1. Legacy JWT keys — `eyJ…` with three base64url segments separated by
 *     dots. A malformed/truncated JWT is the most common cause of
 *     "Invalid Compact JWS" errors from the Storage API.
 *  2. New-format secret keys — `sb_secret_<random>` (Supabase ≥ 2024).
 *     These are NOT JWTs; the old three-segment check rejected them, which
 *     made `getSupabaseServerClient()` return null and rendered every admin
 *     metric as 0 even when the key was perfectly valid.
 *
 * Publishable keys (`sb_publishable_…`) and legacy anon JWTs are rejected:
 * they are client-safe credentials and must never be used as the
 * server-side service role key.
 */
function isValidServiceRoleKey(key: string): boolean {
  if (!key || typeof key !== "string") return false;

  // New-format secret key. Strict charset also rejects truncated values
  // pasted with a literal "…" / "..." (e.g. "sb_secret_abc...").
  if (key.startsWith("sb_secret_")) {
    return /^sb_secret_[A-Za-z0-9_-]+$/.test(key);
  }

  // Publishable / anon credentials are never valid here.
  if (key.startsWith("sb_publishable_")) return false;

  // Legacy JWT: three non-empty base64url segments.
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

/** True when `key` is a legacy JWT (used only for diagnostic messaging). */
function isLegacyJwtShape(key: string): boolean {
  return key.split(".").length === 3;
}

let cachedClient: SupabaseClient | null = null;

/** Lazily-initialized Supabase server client (service role, bypasses RLS). */
export function getSupabaseServerClient(): SupabaseClient | null {
  if (!supabaseUrl) {
    console.warn("[Supabase] NEXT_PUBLIC_SUPABASE_URL is not set. Admin features will be unavailable.");
    return null;
  }
  if (!supabaseServiceRoleKey) {
    console.warn("[Supabase] SUPABASE_SERVICE_ROLE_KEY is not set. Admin features will be unavailable.");
    return null;
  }
  if (!isValidServiceRoleKey(supabaseServiceRoleKey)) {
    const looksLikeJwt = isLegacyJwtShape(supabaseServiceRoleKey);
    console.error(
      "[Supabase] SUPABASE_SERVICE_ROLE_KEY is set but is not a usable service role key. " +
        (looksLikeJwt
          ? "It looks like a truncated or malformed legacy JWT. "
          : "It is neither a legacy service_role JWT nor a new-format sb_secret_ key. ") +
        "Every admin metric (including Total Users) will read 0 until this is fixed. " +
        "Copy the FULL service_role / secret key from the Supabase dashboard (Settings → API) " +
        "and ensure it is not truncated with a literal '...', wrapped in quotes, or the publishable/anon key."
    );
    return null;
  }
  if (!cachedClient) {
    try {
      cachedClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
    } catch (err) {
      console.error(
        `[Supabase] Failed to create server client: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }
  return cachedClient;
}
