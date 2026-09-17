import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireActorUuid } from "@/lib/server/actor";
import { omitBlankUuids, toUuidOrNull } from "@/lib/utils/uuid";
import type { ContentItem, ContentPlacement, ContentStatus } from "@/lib/models";

export interface ContentFilters {
  category?: string;
  status?: ContentStatus;
  placement?: ContentPlacement;
  search?: string;
}

/** Allowed placements — must mirror the `content_placement_check` constraint
 * (see supabase/migrations/011_content_table.sql + 014_content_placement_check_expand.sql). */
const ALLOWED_PLACEMENTS: readonly ContentPlacement[] = [
  "hero", "homepage", "dashboard", "discover",
  "feed", "matches", "messages", "events", "testimonials",
];

/** Throws an explicit error for placements the DB check constraint would reject. */
function assertValidPlacement(placement: string | null | undefined): void {
  if (!placement || !ALLOWED_PLACEMENTS.includes(placement as ContentPlacement)) {
    throw new Error(
      `Invalid placement "${placement ?? ""}". Allowed values: ${ALLOWED_PLACEMENTS.join(", ")}.`
    );
  }
}

function dbToContentItem(row: Record<string, unknown>): ContentItem {
  const mediaUrls = (row.media_urls as string[] | null) ?? [];
  const primaryMediaUrl = (row.media_url as string) ?? mediaUrls[0] ?? "";
  return {
    id: row.id as string,
    category: row.category as ContentItem["category"],
    title: row.title as string,
    description: row.description as string | undefined,
    mediaType: row.media_type as ContentItem["mediaType"],
    mediaUrl: primaryMediaUrl,
    mediaUrls,
    thumbnailUrl: row.thumbnail_url as string | undefined,
    buttonText: row.button_text as string | undefined,
    destinationUrl: row.destination_url as string | undefined,
    placement: row.placement as ContentItem["placement"],
    status: row.status as ContentItem["status"],
    priority: row.priority as number,
    startAt: row.start_at as string,
    endAt: row.end_at as string,
    targetAudience: row.target_audience as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string,
    updatedBy: row.updated_by as string,
  };
}

export async function listContent(filters: ContentFilters = {}): Promise<ContentItem[]> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return [];

  let query = supabase.from("content").select("*").order("created_at", { ascending: false });

  if (filters.category) query = query.eq("category", filters.category);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.placement) query = query.eq("placement", filters.placement);

  const { data } = await query;
  if (!data) return [];
  return data.map(dbToContentItem);
}

export async function createContent(
  data: Omit<ContentItem, "id" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy">,
  adminUid: string,
  id?: string
): Promise<string> {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    throw new Error(
      "Database unavailable: Supabase is not configured. " +
      "Ensure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set."
    );
  }
  const now = new Date().toISOString();

  // Guard against content_placement_check violations before the row reaches
  // Postgres — surface an actionable message instead of a raw constraint error.
  assertValidPlacement(data.placement);

  // Resolve a real UUID for the author columns. A blank client uid ("" left by
  // an unresolved session lookup) would otherwise go straight to Postgres and
  // fail with `invalid input syntax for type uuid: ""`.
  const actorUid = await requireActorUuid(adminUid, "content creation");

  // `id` is optional and client-supplied: omit it when blank/malformed so the
  // column default (gen_random_uuid()) applies, and normalise every other UUID
  // key the same way (empty/malformed → key dropped, never "").
  const row = omitBlankUuids(
    {
      ...(id ? { id } : {}),
      category: data.category,
      title: data.title,
      description: data.description ?? null,
      media_type: data.mediaType,
      media_url: data.mediaUrl ?? "",
      thumbnail_url: data.thumbnailUrl ?? null,
      button_text: data.buttonText ?? null,
      destination_url: data.destinationUrl ?? null,
      placement: data.placement,
      status: data.status,
      priority: data.priority,
      start_at: data.startAt,
      end_at: data.endAt,
      target_audience: data.targetAudience ?? null,
      created_by: actorUid,
      updated_by: actorUid,
      created_at: now,
      updated_at: now,
    },
    ["id", "created_by", "updated_by"]
  );

  const { data: inserted, error } = await supabase
    .from("content")
    .insert(row)
    .select("id")
    .single();

  if (error || !inserted) {
    // Provide helpful error messages based on the type of error
    if (error?.code === "42P01") {
      // Table not found
      throw new Error(
        `Database table "content" not found. ` +
        `Please run the migration 011_content_table.sql in your Supabase project ` +
        `(Supabase Dashboard → SQL Editor) or use the Supabase CLI: supabase db push.`
      );
    }
    if (error?.code === "23503") {
      // Foreign key violation
      throw new Error(
        "Database error: Invalid reference. " +
        "The admin user ID may not exist in the users table. " +
        "Please ensure the admin account is properly provisioned."
      );
    }
    if (error?.code === "22P02") {
      // Invalid text representation — almost always an empty/malformed UUID
      // reaching a uuid column ("invalid input syntax for type uuid").
      throw new Error(
        "Database error: an identifier was sent in an invalid format. " +
          "Reload the page and retry; if this persists, contact the platform administrator."
      );
    }
    throw new Error(error?.message ?? "Failed to create content");
  }

  await supabase.from("audit_logs").insert({
    admin_user_id: actorUid,
    action: "content.create",
    target_ref: { type: "content", id: inserted.id },
    created_at: now,
  });

  return inserted.id as string;
}

export async function getContent(id: string): Promise<ContentItem | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.from("content").select("*").eq("id", id).single();
  return data ? dbToContentItem(data) : null;
}


export async function updateContent(
  id: string,
  data: Partial<ContentItem>,
  adminUid: string
): Promise<void> {
  const supabase = getSupabaseServerClient();
  const now = new Date().toISOString();
  if (!supabase) throw new Error("Supabase not configured");

  // A blank/malformed target id must never reach Postgres as "" — validate it
  // here so the failure is a clear application error, not a uuid syntax error.
  const contentId = toUuidOrNull(id);
  if (!contentId) throw new Error("Invalid content id.");

  // `updated_by` is `uuid not null`: resolve a real UUID instead of forwarding
  // a possibly empty client value.
  const actorUid = await requireActorUuid(adminUid, "content update");

  if (data.placement !== undefined) assertValidPlacement(data.placement);

  const updates: Record<string, unknown> = { updated_at: now, updated_by: actorUid };
  if (data.category !== undefined) updates.category = data.category;
  if (data.title !== undefined) updates.title = data.title;
  if (data.description !== undefined) updates.description = data.description;
  if (data.mediaType !== undefined) updates.media_type = data.mediaType;
  if (data.mediaUrl !== undefined) updates.media_url = data.mediaUrl;
  if (data.mediaUrls !== undefined) updates.media_urls = data.mediaUrls;
  if (data.thumbnailUrl !== undefined) updates.thumbnail_url = data.thumbnailUrl;
  if (data.buttonText !== undefined) updates.button_text = data.buttonText;
  if (data.destinationUrl !== undefined) updates.destination_url = data.destinationUrl;
  if (data.placement !== undefined) updates.placement = data.placement;
  if (data.status !== undefined) updates.status = data.status;
  if (data.priority !== undefined) updates.priority = data.priority;
  if (data.startAt !== undefined) updates.start_at = data.startAt;
  if (data.endAt !== undefined) updates.end_at = data.endAt;
  if (data.targetAudience !== undefined) updates.target_audience = data.targetAudience;

  const { error } = await supabase.from("content").update(updates).eq("id", contentId);
  if (error) throw new Error(error.message);

  await supabase.from("audit_logs").insert({
    admin_user_id: actorUid,
    action: "content.update",
    target_ref: { type: "content", id: contentId },
    details: { changes: Object.keys(data) },
    created_at: now,
  });
}

export async function deleteContent(id: string, adminUid: string): Promise<void> {
  const supabase = getSupabaseServerClient();
  const now = new Date().toISOString();
  if (!supabase) throw new Error("Supabase not configured");

  const contentId = toUuidOrNull(id);
  if (!contentId) throw new Error("Invalid content id.");

  const actorUid = await requireActorUuid(adminUid, "content deletion");

  const { data: content } = await supabase
    .from("content")
    .select("title")
    .eq("id", contentId)
    .single();
  if (!content) throw new Error("Content not found");

  await supabase.from("content").delete().eq("id", contentId);
  await supabase.from("audit_logs").insert({
    admin_user_id: actorUid,
    action: "content.delete",
    target_ref: { type: "content", id: contentId },
    details: { title: content.title },
    created_at: now,
  });
}

export async function publishContent(id: string, adminUid: string): Promise<void> {
  await updateContent(id, { status: "published" }, adminUid);
}

export async function unpublishContent(id: string, adminUid: string): Promise<void> {
  await updateContent(id, { status: "draft" }, adminUid);
}

export async function archiveContent(id: string, adminUid: string): Promise<void> {
  await updateContent(id, { status: "archived" }, adminUid);
}

export async function getPublishedForPlacement(
  placement: ContentPlacement
): Promise<ContentItem[]> {
  const supabase = getSupabaseServerClient();
  const now = new Date().toISOString();
  if (!supabase) return [];

  const { data } = await supabase
    .from("content")
    .select("*")
    .eq("placement", placement)
    .eq("status", "published")
    .lte("start_at", now)
    .gte("end_at", now)
    .order("priority", { ascending: true });
  if (!data) return [];
  return data.map(dbToContentItem);
}

export interface ContentStats {
  total: number;
  published: number;
  scheduled: number;
  draft: number;
  archived: number;
}

export async function getContentStats(): Promise<ContentStats> {
  const supabase = getSupabaseServerClient();
  const stats: ContentStats = { total: 0, published: 0, scheduled: 0, draft: 0, archived: 0 };
  if (!supabase) return stats;

  const { data } = await supabase.from("content").select("status");
  if (!data) return stats;

  data.forEach((item) => {
    stats.total++;
    if (item.status === "published") stats.published++;
    else if (item.status === "scheduled") stats.scheduled++;
    else if (item.status === "draft") stats.draft++;
    else if (item.status === "archived") stats.archived++;
  });
  return stats;
}

