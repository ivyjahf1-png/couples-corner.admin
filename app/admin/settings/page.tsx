"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/app/PageHeader";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/landing/Icon";
import {
  getPlatformSettingsAction,
  getSubscriptionMetricsAction,
  listTierSubscribersAction,
  savePaymentSettingsAction,
  testPaystackConnectionAction,
} from "@/lib/actions/settings";
import type { TierSubscriber } from "@/lib/server/settings";

const inputClass =
  "mt-1 w-full rounded-xl border border-orange-500/30 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/40";
const labelClass = "flex flex-col text-sm font-medium text-slate-200";

const TIERS = [
  { key: "weekly", name: "Weekly", price: "$6", period: "per week", features: "Full access, cancel anytime", border: "border-orange-500/30" },
  { key: "monthly", name: "Monthly", price: "$19", period: "per month", features: "Best value for regular users", border: "border-orange-500 ring-2 ring-orange-500/20" },
  { key: "yearly", name: "Yearly", price: "$55", period: "per year", features: "Best deal — save vs monthly", border: "border-orange-500/30" },
] as const;

type TierKey = (typeof TIERS)[number]["key"];

interface MetricsState {
  mrr: number;
  activeSubscribers: number;
  byTier: Record<string, { count: number; mrr: number }>;
}

interface Feedback {
  type: "success" | "error";
  msg: string;
}

export default function AdminSettingsPage() {
  const router = useRouter();
  const [paystackPublicKey, setPaystackPublicKey] = useState("");
  const [paystackSecretKey, setPaystackSecretKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [testing, setTesting] = useState(false);
  const [testFeedback, setTestFeedback] = useState<Feedback | null>(null);
  const [metrics, setMetrics] = useState<MetricsState | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [selectedTier, setSelectedTier] = useState<TierKey | null>(null);
  const [subscribers, setSubscribers] = useState<TierSubscriber[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [subsError, setSubsError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    // Load independently so a settings-table error doesn't hide revenue metrics (and vice versa).
    getPlatformSettingsAction()
      .then((s) => {
        if (!mounted) return;
        setPaystackPublicKey(s.paystackPublicKey ?? "");
        setPaystackSecretKey(s.paystackSecretKey ?? "");
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        setFeedback({
          type: "error",
          msg: err instanceof Error ? err.message : "Failed to load platform settings.",
        });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    getSubscriptionMetricsAction()
      .then((m) => {
        if (mounted) setMetrics(m);
      })
      .finally(() => {
        if (mounted) setMetricsLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await savePaymentSettingsAction(paystackPublicKey, paystackSecretKey);
      if (res.ok) {
        setFeedback({ type: "success", msg: res.message ?? "Payment settings saved successfully." });
        router.refresh();
      } else {
        setFeedback({ type: "error", msg: res.error ?? "Failed to save payment settings." });
      }
    } catch (err) {
      setFeedback({
        type: "error",
        msg: err instanceof Error ? err.message : "Failed to save payment settings.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (testing) return;
    setTesting(true);
    setTestFeedback(null);
    try {
      // Prefer the on-screen secret (unsaved edits included); fall back to stored keys server-side.
      const res = await testPaystackConnectionAction(paystackSecretKey.trim() || undefined);
      setTestFeedback(
        res.ok
          ? { type: "success", msg: res.message ?? "Paystack connection successful." }
          : { type: "error", msg: res.error ?? "Paystack connection failed." }
      );
    } catch (err) {
      setTestFeedback({
        type: "error",
        msg: err instanceof Error ? err.message : "Failed to test Paystack connection.",
      });
    } finally {
      setTesting(false);
    }
  }

  async function openTierDetail(tier: TierKey) {
    setSelectedTier(tier);
    setSubsLoading(true);
    setSubsError(null);
    setSubscribers([]);
    try {
      const rows = await listTierSubscribersAction(tier);
      setSubscribers(rows);
    } catch (err) {
      setSubsError(err instanceof Error ? err.message : "Failed to load subscribers.");
    } finally {
      setSubsLoading(false);
    }
  }

  function closeTierDetail() {
    setSelectedTier(null);
    setSubscribers([]);
    setSubsError(null);
  }

  const selectedTierMeta = selectedTier ? TIERS.find((t) => t.key === selectedTier) : undefined;

  return (
    <>
      <div className="flex min-w-0 flex-col gap-8">
        <PageHeader
          eyebrow="Settings"
          title="Platform configuration"
          subtitle="Manage global platform settings, subscription tiers, and feature flags."
        />

        {/* Revenue summary */}
        <section aria-label="Subscription revenue summary" className="grid gap-4 sm:grid-cols-3">
          <div className="min-w-0 rounded-2xl border border-orange-500/20 bg-slate-900 p-5 shadow-md">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">MRR</p>
            <p className="mt-1 text-3xl font-bold text-white">
              {metricsLoading ? "…" : `$${(metrics?.mrr ?? 0).toFixed(2)}`}
            </p>
            <p className="mt-1 text-xs text-slate-500">Monthly-equivalent revenue from active plans.</p>
          </div>
          <div className="min-w-0 rounded-2xl border border-orange-500/20 bg-slate-900 p-5 shadow-md">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Active subscribers</p>
            <p className="mt-1 text-3xl font-bold text-white">
              {metricsLoading ? "…" : (metrics?.activeSubscribers ?? 0)}
            </p>
            <p className="mt-1 text-xs text-slate-500">Across weekly, monthly, and yearly tiers.</p>
          </div>
          <div className="min-w-0 rounded-2xl border border-orange-500/20 bg-slate-900 p-5 shadow-md">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Per-tier breakdown</p>
            {metricsLoading ? (
              <p className="mt-2 text-sm text-slate-500">Loading…</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm text-slate-300">
                {TIERS.map((t) => (
                  <li key={t.key} className="flex items-center justify-between gap-2">
                    <span>{t.name}</span>
                    <span className="font-semibold text-white">
                      {metrics?.byTier[t.key]?.count ?? 0} · ${(metrics?.byTier[t.key]?.mrr ?? 0).toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Subscription tiers */}
        <section className="min-w-0 rounded-2xl border border-orange-500/20 bg-slate-900 p-6 shadow-md">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-500/20 text-orange-400">
              <Icon name="sparkle" className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-white">Subscription tiers</h2>
              <p className="text-sm text-slate-300">Select a tier to view its subscriber breakdown.</p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {TIERS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={()=>void openTierDetail(t.key)}
                aria-label={`View ${t.name} subscribers`}
                className={`min-w-0 cursor-pointer rounded-xl border bg-slate-800 p-4 text-left transition hover:-translate-y-0.5 hover:border-orange-400/60 hover:bg-slate-700/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 ${t.border} ${selectedTier === t.key ? "border-orange-400 ring-2 ring-orange-400/40" : ""}`}
              >
                <h3 className="font-semibold text-white">{t.name}</h3>
                <p className="mt-1 text-xs text-slate-400">{t.features}</p>
                <p className="mt-2 text-2xl font-bold text-white">
                  {t.price}
                  <span className="text-sm font-normal text-slate-400"> {t.period}</span>
                </p>
                <p className="mt-2 text-xs font-medium text-orange-300">
                  {metricsLoading ? "Loading subscribers…" : `${metrics?.byTier[t.key]?.count ?? 0} active — view details →`}
                </p>
              </button>
            ))}
          </div>
        </section>

        {/* Payment gateway */}
        <section className="min-w-0 rounded-2xl border border-orange-500/20 bg-slate-900 p-6 shadow-md">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-success-500/20 text-success-300">
              <Icon name="lock" className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-white">Payment gateway</h2>
              <p className="text-sm text-slate-300">Configure your payment provider settings.</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              Paystack public key
              <input
                type="text"
                autoComplete="off"
                value={paystackPublicKey}
                onChange={(e) => setPaystackPublicKey(e.target.value)}
                placeholder="pk_live_..."
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Paystack secret key
              <input
                type="password"
                autoComplete="new-password"
                value={paystackSecretKey}
                onChange={(e) => setPaystackSecretKey(e.target.value)}
                placeholder="sk_live_..."
                className={inputClass}
              />
            </label>
          </div>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          {feedback ? (
            <p
              role="status"
              className={`text-sm font-medium ${feedback.type === "success" ? "text-success-300" : "text-danger-300"}`}
            >
              {feedback.msg}
            </p>
          ) : (
            <p className="text-sm text-slate-500">Values are stored server-side.</p>
          )}
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={handleTestConnection}
              disabled={loading || testing}
            >
              {testing ? "Testing…" : "Test Paystack connection"}
            </Button>
            <Button
              size="sm"
              type="button"
              onClick={handleSave}
              disabled={loading || saving}
              className="bg-orange-600 text-white hover:bg-orange-500"
            >
              {saving ? "Saving…" : "Save payment settings"}
            </Button>
          </div>
          {testFeedback && (
            <p
              role="status"
              className={`mt-3 text-sm font-medium ${testFeedback.type === "success" ? "text-success-300" : "text-danger-300"}`}
            >
              {testFeedback.msg}
            </p>
          )}
        </section>
      </div>

      {/* Tier subscriber breakdown modal */}
      {selectedTier && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`${selectedTierMeta?.name ?? selectedTier} subscribers`}
          onClick={closeTierDetail}
        >
          <div
            className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-orange-500/20 bg-slate-900 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-white/10 p-5">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {selectedTierMeta?.name ?? selectedTier} subscribers
                </h2>
                <p className="text-sm text-slate-400">
                  {selectedTierMeta?.price} {selectedTierMeta?.period} · {subscribers.length} shown
                </p>
              </div>
              <Button size="sm" variant="secondary" type="button" onClick={closeTierDetail}>
                Close
              </Button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto p-5">
              {subsLoading && <p className="text-sm text-slate-400">Loading subscribers…</p>}
              {!subsLoading && subsError && (
                <p role="alert" className="text-sm font-medium text-danger-300">{subsError}</p>
              )}
              {!subsLoading && !subsError && subscribers.length === 0 && (
                <p className="text-sm text-slate-400">No active subscribers on this tier yet.</p>
              )}
              {!subsLoading && !subsError && subscribers.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wider text-slate-500">
                        <th className="pb-2 pr-3 font-semibold">User</th>
                        <th className="pb-2 pr-3 font-semibold">Email</th>
                        <th className="pb-2 pr-3 font-semibold">Start</th>
                        <th className="pb-2 pr-3 font-semibold">Expires</th>
                        <th className="pb-2 font-semibold">Time left</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {subscribers.map((s) => (
                        <tr key={s.userId} className="text-slate-300">
                          <td className="py-2 pr-3 font-medium text-white">{s.handle}</td>
                          <td className="py-2 pr-3">{s.email}</td>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            {s.startedAt ? new Date(s.startedAt).toLocaleDateString() : "—"}
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            {s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : "—"}
                          </td>
                          <td className="py-2">
                            <span className="mb-1 block text-xs text-slate-400">{s.timeRemaining}</span>
                            <span
                              className="block h-1.5 w-28 overflow-hidden rounded-full bg-slate-700"
                              role="progressbar"
                              aria-valuenow={s.periodProgressPct}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-label={`Billing period ${s.periodProgressPct}% elapsed`}
                            >
                              <span
                                className="block h-full rounded-full bg-orange-500"
                                style={{ width: `${s.periodProgressPct}%` }}
                              />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

