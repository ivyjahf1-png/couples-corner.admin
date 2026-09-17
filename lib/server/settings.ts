import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Couples Corner — platform settings persistence (SERVER ONLY).
 * Stores a single JSON blob row in `platform_settings` keyed by `id = 'default'`.
 */

export interface PlatformPaymentSettings {
  paystackPublicKey: string;
  paystackSecretKey: string;
}

/** The global settings row id (singleton). */
export const SETTINGS_ID = "default";

function parseData(raw: unknown): Partial<PlatformPaymentSettings> {
  if (raw && typeof raw === "object") return raw as Partial<PlatformPaymentSettings>;
  return {};
}
/** Aggregate MRR, active subscriber count, and per-tier breakdown.
 * Returned by `getSubscriptionMetrics()`.
 */
export interface SubscriptionMetrics {
  /** Sum of monthly-equivalent revenue across active subscriptions (USD). */
  mrr: number;
  /** Count of subscriptions whose status is `active`. */
  activeSubscribers: number;
  /** Per-tier breakdown: tier name → { active count, mrr contributed }. */
  byTier: Record<string, { count: number; mrr: number }>;
}

/** Per-subscriber row returned by `listTierSubscribers()`. */
export interface TierSubscriber {
  userId: string;
  handle: string;
  email: string;
  displayName: string | null;
  tier: string;
  status: string;
  startedAt: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
  /** Human-readable "time remaining" for the current billing period. */
  timeRemaining: string;
  /** 0–100 percentage of the current billing period already elapsed. */
  periodProgressPct: number;
}


/** Load platform payment settings, falling back to empty strings when unset. */
export async function getPlatformSettings(): Promise<PlatformPaymentSettings> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase not configured");

  const { data, error } = await supabase
    .from("platform_settings")
    .select("data")
    .eq("id", SETTINGS_ID)
    .maybeSingle();

  if (error) {
    const message = error.message || error.code || "unknown";
    throw new Error(`Failed to load platform settings: ${message}`);
  }

  const d = parseData(data?.data);
  return {
    paystackPublicKey: d.paystackPublicKey ?? "",
    paystackSecretKey: d.paystackSecretKey ?? "",
  };
}

/**
 * Validate Paystack key shape loosely.
 * Public keys start with `pk_`; secret keys start with `sk_`.
 */
function validatePaystackKeys(publicKey: string, secretKey: string): string | null {
  if (!publicKey.trim()) return "Paystack public key is required.";
  if (!secretKey.trim()) return "Paystack secret key is required.";
  if (!publicKey.trim().startsWith("pk_")) return "Public key does not look like a Paystack key (expected pk_...).";
  if (!secretKey.trim().startsWith("sk_")) return "Secret key does not look like a Paystack key (expected sk_...).";
  return null;
}

/** Upsert platform payment settings (single row). */
export async function savePlatformSettings(
  input: PlatformPaymentSettings
): Promise<{ ok: boolean; message: string }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Supabase is not configured." };

  // Normalize and validate before hitting the database.
  const publicKey = input.paystackPublicKey.trim();
  const secretKey = input.paystackSecretKey.trim();
  const validationError = validatePaystackKeys(publicKey, secretKey);
  if (validationError) return { ok: false, message: validationError };

  const payload = {
    id: SETTINGS_ID,
    data: { paystackPublicKey: publicKey, paystackSecretKey: secretKey },
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("platform_settings").upsert(payload, { onConflict: "id" });

  if (error) {
    const message = error.message || error.code || "unknown";
    return {
      ok: false,
      message: `Failed to save payment settings: ${message}. Verify the platform_settings table exists and the service-role key is correct.`,
    };
  }

  return { ok: true, message: "Payment settings saved successfully." };
}

/** Monthly-equivalent USD value per tier, derived from canonical tier prices. */
const TIER_MONTHLY_VALUE_USD: Record<string, number> = {
  weekly: (6 * 52) / 12,
  monthly: 19,
  yearly: 55 / 12,
};

function isCountedStatus(status: string | null | undefined): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

function toTimeRemaining(currentPeriodEnd: string | null): string {
  if (!currentPeriodEnd) return "—";
  const ms = new Date(currentPeriodEnd).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "Expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d left`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

function toPeriodProgress(startedAt: string | null, currentPeriodEnd: string | null): number {
  if (!startedAt || !currentPeriodEnd) return 0;
  const start = new Date(startedAt).getTime();
  const end = new Date(currentPeriodEnd).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  const pct = ((Date.now() - start) / (end - start)) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/** Aggregate MRR, active subscriber count, and per-tier breakdown. */
export async function getSubscriptionMetrics(): Promise<SubscriptionMetrics> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase not configured");

  const { data, error } = await supabase
    .from("subscriptions")
    .select("tier, status")
    .in("status", ["active", "trialing", "past_due"]);

  if (error) {
    throw new Error(`Failed to load subscription metrics: ${error.message || error.code || "unknown"}`);
  }

  const byTier: SubscriptionMetrics["byTier"] = {};
  let activeSubscribers = 0;
  let mrr = 0;

  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const tier = String(r.tier ?? "unknown");
    if (!isCountedStatus(String(r.status ?? ""))) continue;
    activeSubscribers += 1;
    const value = TIER_MONTHLY_VALUE_USD[tier] ?? 0;
    mrr += value;
    const entry = byTier[tier] ?? { count: 0, mrr: 0 };
    entry.count += 1;
    entry.mrr += value;
    byTier[tier] = entry;
  }

  return { mrr: Math.round(mrr * 100) / 100, activeSubscribers, byTier };
}

/** List subscribers for a tier, enriched with profile name + account email. */
export async function listTierSubscribers(tier: string): Promise<TierSubscriber[]> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase not configured");

  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select("user_id, tier, status, started_at, current_period_end, canceled_at")
    .eq("tier", tier)
    .in("status", ["active", "trialing", "past_due"])
    .order("started_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load subscribers: ${error.message || error.code || "unknown"}`);
  }
  if (!subs || subs.length === 0) return [];

  const userIds = [...new Set(subs.map((s) => s.user_id as string).filter(Boolean))];
  if (userIds.length === 0) return [];

  // `display_name` + `email` both live on the `users` table (see lib/server/admin.ts).
  const { data: userRows } = await supabase
    .from("users")
    .select("id, display_name, email")
    .in("id", userIds);

  const nameByUser = new Map<string, string | null>(
    (userRows ?? []).map(
      (u): [string, string | null] => [String(u.id ?? ""), (u.display_name as string | null) ?? null]
    )
  );
  const emailByUser = new Map<string, string>(
    (userRows ?? []).map((u): [string, string] => [String(u.id ?? ""), (u.email as string) ?? ""])
  );

  return subs.map((s) => {
    const userId = s.user_id as string;
    const startedAt = (s.started_at as string | null) ?? null;
    const periodEnd = (s.current_period_end as string | null) ?? null;
    return {
      userId,
      handle: nameByUser.get(userId) ?? "Member",
      email: emailByUser.get(userId) ?? "—",
      displayName: nameByUser.get(userId) ?? null,
      tier: String(s.tier ?? tier),
      status: String(s.status ?? "active"),
      startedAt,
      currentPeriodEnd: periodEnd,
      canceledAt: (s.canceled_at as string | null) ?? null,
      timeRemaining: toTimeRemaining(periodEnd),
      periodProgressPct: toPeriodProgress(startedAt, periodEnd),
    } satisfies TierSubscriber;
  });
}

/** Verify stored (or provided) Paystack secret key. Never throws. */
export async function testPaystackConnection(
  secretKeyOverride?: string
): Promise<{ ok: boolean; message: string }> {
  let secretKey = (secretKeyOverride ?? "").trim();
  if (!secretKey) {
    try {
      secretKey = (await getPlatformSettings()).paystackSecretKey.trim();
    } catch (err) {
      return { ok: false, message: `Could not load stored key: ${err instanceof Error ? err.message : "unknown"}.` };
    }
  }
  if (!secretKey) {
    return { ok: false, message: "No Paystack secret key saved yet — save your keys first, then test." };
  }

  try {
    const res = await fetch("https://api.paystack.co/bank?currency=NGN&perPage=1", {
      method: "GET",
      headers: { Authorization: `Bearer ${secretKey}` },
      cache: "no-store",
    });
    if (res.ok) return { ok: true, message: "Paystack connection successful — secret key is valid." };
    if (res.status === 401) {
      return { ok: false, message: "Paystack rejected the key (401 Unauthorized). Check the secret key value." };
    }
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = ` — ${body.message}`;
    } catch { /* non-JSON body; ignore */ }
    return { ok: false, message: `Paystack responded with HTTP ${res.status}${detail}.` };
  } catch (err) {
    return { ok: false, message: `Network error reaching Paystack: ${err instanceof Error ? err.message : "unknown"}.` };
  }
}
