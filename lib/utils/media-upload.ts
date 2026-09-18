/**
 * Client-side media upload for the admin content form.
 *
 * Files are uploaded DIRECTLY from the browser to the Supabase Storage
 * `media` bucket via the anon-key browser client. Only the resulting public
 * URL strings are handed to the Server Action (`createContentAction` /
 * `updateContentAction`), so large media payloads never travel through the
 * Next.js Server Action POST body (which is capped — previously the source of
 * "Body exceeded 1 MB limit" errors).
 *
 * Prerequisite: the `media` bucket must allow authenticated uploads. Migration
 * 014_user_media_endless_uploads.sql grants authenticated users write access
 * to their own paths; admin content lives under content/{contentId}/ so an
 * authenticated-insert policy on that prefix is required.
 */

import { getSupabaseClient } from "@/lib/supabase/client";
import { CONTENT_UPLOAD } from "@/lib/models/content";

export interface ClientUploadResult {
  mediaUrls: string[];
}

/** Validate one file against the shared content-upload limits. Returns null when valid, else an error message. */
function validateFile(file: File): string | null {
  const isImage = CONTENT_UPLOAD.imageTypes.some((t) => t === file.type);
  const isVideo = CONTENT_UPLOAD.videoTypes.some((t) => t === file.type);
  if (!isImage && !isVideo) return `${file.name}: unsupported type (${file.type || "unknown"})`;
  const maxSize = isImage ? CONTENT_UPLOAD.maxImageBytes : CONTENT_UPLOAD.maxVideoBytes;
  if (file.size > maxSize) return `${file.name}: exceeds ${(maxSize / 1024 / 1024).toFixed(0)}MB`;
  return null;
}

/** Build a storage-safe object path: content/{contentId}/{timestamp}_{rand}_{name} */
function buildPath(contentId: string, file: File): string {
  const name = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
  const rand = Math.random().toString(36).slice(2, 8);
  return `content/${contentId}/${new Date().getTime()}_${rand}_${name}`;
}

/** Constructed public URL fallback (mirrors the storage API layout). */
function fallbackPublicUrl(path: string): string {
  const base =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!base) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured");
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/media/${path}`;
}

/**
 * Upload files from the browser straight to Supabase Storage.
 * Throws on total failure; collects per-file failures into the returned
 * warnings so a single bad file doesn't abort the whole batch.
 */
export async function uploadMediaFromBrowser(
  contentId: string,
  files: File[]
): Promise<{ result: ClientUploadResult; warnings: string[] }> {
  if (files.length === 0) return { result: { mediaUrls: [] }, warnings: [] };
  if (files.length > CONTENT_UPLOAD.maxFiles) {
    throw new Error(`Max ${CONTENT_UPLOAD.maxFiles} files. Got ${files.length}.`);
  }

  const supabase = getSupabaseClient();
  const mediaUrls: string[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const problem = validateFile(file);
    if (problem) {
      warnings.push(problem);
      continue;
    }
    const path = buildPath(contentId, file);
    // The browser client streams the File directly — no arrayBuffer copy.
    const { error } = await supabase.storage
      .from("media")
      .upload(path, file, { contentType: file.type, upsert: false });
    if (error) {
      warnings.push(`${file.name}: ${error.message}`);
      continue;
    }
    // getPublicUrl is synchronous in this supabase-js version.
    const { data } = supabase.storage.from("media").getPublicUrl(path);
    mediaUrls.push(data?.publicUrl || fallbackPublicUrl(path));
  }

  return { result: { mediaUrls }, warnings };
}