import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Couples Corner -- server-side dashboard metrics service.
 * Fetches real-time key metrics for the admin overview dashboard.
 * All queries run through the Supabase server client (bypasses RLS).
 */

export interface DashboardMetrics {
  totalUsers: number;
  newUsersToday: number;
  newCouplesToday: number;
  activeSubscriptions: number;
  revenueToday: number;
  openReports: number;
  openSupportTickets: number;
}

export interface RecentActivity {
  id: string;
  type: "signup" | "report" | "support" | "subscription";
  description: string;
  timestamp: string;
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const supabase = getSupabaseServerClient();
  const empty: DashboardMetrics = {
    totalUsers: 0,
    newUsersToday: 0,
    newCouplesToday: 0,
    activeSubscriptions: 0,
    revenueToday: 0,
    openReports: 0,
    openSupportTickets: 0,
  };
  if (!supabase) {
    console.warn("[Dashboard] Supabase server client unavailable -- returning empty metrics.");
    return empty;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  const client = supabase;
  // Helper: head-count a table. Returns 0 on error but logs the cause so a
  // missing table / bad column surfaces in server logs instead of silently
  // rendering "0" on the dashboard.
  async function headCount(
    table: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apply?: (q: any) => any,
  ): Promise<number> {
    try {
      let query = client.from(table).select("id", { count: "exact", head: true });
      if (apply) query = apply(query);
      const { count, error } = await query;
      if (error) {
        console.error(`[Dashboard] count failed on "${table}": ${error.message}`);
        return 0;
      }
      return count ?? 0;
    } catch (err) {
      console.error(`[Dashboard] count threw on "${table}": ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async function authUserCount(): Promise<number | null> {
    // Supabase Admin API `listUsers` returns `{ data: { users }, error }` --
    // there is NO `data.total` field, so paginate to get the true total.
    // Returns null (not 0) on failure so a broken auth call can never
    // drag the max() below the real public-table counts.
    try {
      const perPage = 1000;
      let page = 1;
      let total = 0;
      for (;;) {
        const { data, error } = await client.auth.admin.listUsers({ page, perPage });
        if (error) {
          console.error(`[Dashboard] auth.admin.listUsers failed: ${error.message}`);
          return null;
        }
        const users = data?.users ?? [];
        total += users.length;
        if (users.length < perPage) break;
        page += 1;
        // Safety cap: 1M users is far beyond current scale.
        if (page > 1000) break;
      }
      return total;
    } catch (err) {
      console.error(`[Dashboard] auth count threw: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // Source of truth for registered accounts is public.users (one row per
  // provisioned auth user). public.profiles mirrors users 1:1, so use the
  // larger of the two as totalUsers -- this stays correct even if one table
  // lags (e.g. profile insert failed or a legacy DB lacks a table).
  // NOTE: there is no `couples_profiles` table in this schema -- do not query
  // it. Couple accounts live in `profiles` with profile_type = 'coupled'.
  const [authTotal, profilesTotal, usersTotal, newUsersToday, newCouplesToday, activeSubscriptions, openReports, openSupportTickets] =
    await Promise.all([
      authUserCount(),
      headCount("profiles"),
      headCount("users"),
      headCount("users", (q) => q.gte("created_at", todayISO)),
      headCount("profiles", (q) => q.eq("profile_type", "coupled").gte("created_at", todayISO)),
      // Active subscriptions live in the `subscriptions` table (status column,
      // values from SubscriptionStatus). The `users` table has no `role` column
      // in this schema -- querying users.role = 'premium' raises a 42703 error and
      // silently logged 0. This mirrors web/lib/server/subscription.ts.
      headCount("subscriptions", (q) => q.eq("status", "active")),
      headCount("reports", (q) => q.eq("status", "open")),
      headCount("support_tickets", (q) => q.in("status", ["open", "in_progress"])),
    ]);

  // Prefer the canonical public.users count; the auth.users total and
  // public.profiles mirror act as cross-checks. authTotal === null means the
  // Admin API call failed -- fall back to table counts rather than 0.
  const candidates = [usersTotal, profilesTotal, authTotal ?? 0];
  const totalUsers = Math.max(...candidates);
  void authTotal;

  return {
    totalUsers,
    newUsersToday,
    newCouplesToday,
    activeSubscriptions,
    revenueToday: 0,
    openReports,
    openSupportTickets,
  };
}

export async function getRecentActivity(): Promise<RecentActivity[]> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return [];

  const activities: RecentActivity[] = [];

  const [{ data: recentUsers }, { data: recentReports }, { data: recentTickets }] = await Promise.all([
    supabase.from("users").select("id, email, display_name, created_at").order("created_at", { ascending: false }).limit(5),
    supabase.from("reports").select("id, reason, created_at").order("created_at", { ascending: false }).limit(5),
    supabase.from("support_tickets").select("id, subject, created_at").order("created_at", { ascending: false }).limit(5),
  ]);

  if (recentUsers) {
    for (const user of recentUsers) {
      activities.push({
        id: `signup-${user.id}`,
        type: "signup",
        description: `${(user.display_name as string) ?? (user.email as string)?.split("@")[0] ?? "A new user"} joined Couples Corner`,
        timestamp: user.created_at as string,
      });
    }
  }

  if (recentReports) {
    for (const report of recentReports) {
      activities.push({
        id: `report-${report.id}`,
        type: "report",
        description: `New report: ${report.reason as string}`,
        timestamp: report.created_at as string,
      });
    }
  }

  if (recentTickets) {
    for (const ticket of recentTickets) {
      activities.push({
        id: `support-${ticket.id}`,
        type: "support",
        description: `Support ticket: ${ticket.subject as string}`,
        timestamp: ticket.created_at as string,
      });
    }
  }

  activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return activities.slice(0, 10);
}

