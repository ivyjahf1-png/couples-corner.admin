"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { requireAdminDev } from "@/lib/auth/authorization";
import { rethrowIfNavigation } from "@/lib/utils/errors";
import {
  getPlatformSettings,
  getSubscriptionMetrics,
  listTierSubscribers,
  savePlatformSettings,
  testPaystackConnection,
} from "@/lib/server/settings";
import type { SubscriptionMetrics, TierSubscriber } from "@/lib/server/settings";

export interface SettingsActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

/** Load payment settings (admin only). */
export async function getPlatformSettingsAction() {
  await requireAdminDev();
  return getPlatformSettings();
}

/** MRR + active subscriber summary (admin only). Never throws — returns empty metrics on failure. */
export async function getSubscriptionMetricsAction(): Promise<SubscriptionMetrics> {
  const fallback: SubscriptionMetrics = { mrr: 0, activeSubscribers: 0, byTier: {} };
  try {
    await requireAdminDev();
    return await getSubscriptionMetrics();
  } catch (err) {
    rethrowIfNavigation(err);
    return fallback;
  }
}

/** Subscriber list for one tier (admin only). Returns [] on failure. */
export async function listTierSubscribersAction(tier: string): Promise<TierSubscriber[]> {
  try {
    await requireAdminDev();
    return await listTierSubscribers(tier.trim().toLowerCase());
  } catch (err) {
    rethrowIfNavigation(err);
    return [];
  }
}

/** Test the stored Paystack secret key (admin only). Never throws. */
export async function testPaystackConnectionAction(
  secretKeyOverride?: string
): Promise<SettingsActionResult> {
  try {
    await requireAdminDev();
    const result = await testPaystackConnection(secretKeyOverride);
    return result.ok
      ? { ok: true, message: result.message }
      : { ok: false, error: result.message };
  } catch (err) {
    rethrowIfNavigation(err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to test Paystack connection.",
    };
  }
}

/** Persist Paystack credentials (admin only). */
export async function savePaymentSettingsAction(
  paystackPublicKey: string,
  paystackSecretKey: string
): Promise<SettingsActionResult> {
  try {
    await requireAdminDev();
    const result = await savePlatformSettings({
      paystackPublicKey: paystackPublicKey.trim(),
      paystackSecretKey: paystackSecretKey.trim(),
    });
    if (!result.ok) {
      // Validation or DB error from the server helper — surface its explicit
      // message instead of a blank/generic failure.
      return { ok: false, error: result.message };
    }
    revalidatePath("/admin/settings");
    return { ok: true, message: result.message };
  } catch (err) {
    // redirect()/notFound() from requireAdminDev() must propagate so Next.js
    // navigates correctly instead of reporting a bogus save error.
    rethrowIfNavigation(err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save payment settings.",
    };
  }
}