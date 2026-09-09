import { promises as fs } from "node:fs";
import * as path from "node:path";
import { config } from "../config.js";
import { FILE_SIGNATURES, KNOWN_PROCEDURES, MIN_MEDIA_BYTES } from "../constants.js";
import { FlowError, type MediaItem } from "../types.js";
import { getFlowPage, reloadSession } from "./browser.js";
import { callTrpc } from "./transport.js";

/**
 * Flow's Download button frequently writes nothing to disk in an automated
 * profile, and Scenebuilder exports never touch the filesystem at all. The
 * reliable path is always: media id -> signed CDN url -> fetch bytes ourselves.
 */

/** Enumerate the project library from modern Flow batch containers and media elements. */
export async function listMedia(limit = 50, offset = 0): Promise<{ items: MediaItem[]; total: number }> {
  const page = await getFlowPage();
  const all = await page.evaluate(() => {
    const seen = new Map<string, { mediaId: string; kind: string; name: string | null; thumbnailUrl: string | null }>();

    // 1. Scan modern batch containers
    for (const batch of document.querySelectorAll(".batch-container")) {
      const prompt = batch.querySelector(".prompt-text")?.textContent?.trim() || null;
      for (const img of batch.querySelectorAll("img")) {
        const src = img.src;
        if (!src) continue;
        const idMatch =
          src.match(/flow-content\.google\/(?:image|video)\/([a-zA-Z0-9_-]+)/) ||
          src.match(/getMediaUrlRedirect\?name=([^&"']+)/) ||
          src.match(/\/asb\/([a-zA-Z0-9_-]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : src.slice(-24);
        if (!seen.has(id)) {
          seen.set(id, {
            mediaId: id,
            kind: src.includes("/video/") ? "video" : "image",
            name: prompt ? prompt.slice(0, 60) : img.alt || null,
            thumbnailUrl: src,
          });
        }
      }
    }

    // 2. Scan all other images and videos on page
    for (const el of document.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")) {
      const src = (el as HTMLImageElement).src || (el as HTMLVideoElement).currentSrc || el.getAttribute("src");
      if (!src) continue;
      if (src.includes("flow-content.google") || src.includes("getMediaUrlRedirect") || src.includes("/asb/")) {
        const idMatch =
          src.match(/flow-content\.google\/(?:image|video)\/([a-zA-Z0-9_-]+)/) ||
          src.match(/getMediaUrlRedirect\?name=([^&"']+)/) ||
          src.match(/\/asb\/([a-zA-Z0-9_-]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : src.slice(-24);
        if (!seen.has(id)) {
          seen.set(id, {
            mediaId: id,
            kind: el.tagName === "VIDEO" || src.includes("/video/") ? "video" : "image",
            name: (el as HTMLImageElement).alt || null,
            thumbnailUrl: src,
          });
        }
      }
    }

    return [...seen.values()];
  });

  const items = all.slice(offset, offset + limit).map((i) => ({ ...i, kind: i.kind as MediaItem["kind"] }));
  return { items, total: all.length };
}

/** Resolve a media id to its signed CDN url. */
export async function resolveMediaUrl(mediaId: string, kind?: "video" | "image"): Promise<string> {
  const page = await getFlowPage();

  // 1. If looking for a video, check video elements or click batch tile to mount video player
  if (kind !== "image") {
    const existingVideo = await page.evaluate((id) => {
      for (const v of document.querySelectorAll<HTMLVideoElement>("video")) {
        const src = v.src || v.currentSrc;
        if (src && src.includes(id)) return src;
      }
      return null;
    }, mediaId);

    if (existingVideo && existingVideo.startsWith("http")) return existingVideo;

    // Click matching batch tile or play button to mount video element
    await page.evaluate((id) => {
      const img = [...document.querySelectorAll<HTMLImageElement>("img")].find(
        (i) => i.src.includes(id) || i.src.includes(encodeURIComponent(id)),
      );
      const batch = img?.closest(".batch-container, flow-custom-tile, [class*='tile']");
      if (batch) {
        const playBtn =
          batch.querySelector<HTMLElement>("button, [aria-label*='Play' i], img") || (batch as HTMLElement);
        if (playBtn && playBtn.click) playBtn.click();
      }
    }, mediaId);

    await page.waitForTimeout(2000);

    const mountedVideo = await page.evaluate((id) => {
      for (const v of document.querySelectorAll<HTMLVideoElement>("video")) {
        const src = v.src || v.currentSrc;
        if (src && (src.includes(id) || src.includes("/video/"))) return src;
      }
      return null;
    }, mediaId);

    if (mountedVideo && mountedVideo.startsWith("http")) return mountedVideo;
  }

  // 2. Direct lookup for image or any element
  const domUrl = await page.evaluate((id) => {
    for (const el of document.querySelectorAll<HTMLImageElement | HTMLVideoElement>("video, img, a")) {
      const src = (el as HTMLImageElement).src || (el as HTMLVideoElement).currentSrc || el.getAttribute("href");
      if (src && src.includes(id)) return src;
    }
    return null;
  }, mediaId);

  if (domUrl && domUrl.startsWith("http")) return domUrl;

  // 3. Direct CDN url pattern fallback
  if (/^[a-f0-9-]{36}$/i.test(mediaId)) {
    return `https://flow-content.google/${kind === "image" ? "image" : "video"}/${mediaId}`;
  }

  throw new FlowError(
    `Could not resolve a CDN url for media ${mediaId}.`,
    `Run flow_check_session to ensure the active Flow tab is open.`,
  );
}

/** Retrieve the latest media item from the active project. */
export async function getLatestMedia(kind?: "video" | "image"): Promise<MediaItem | null> {
  const { items } = await listMedia(20, 0);
  if (items.length === 0) return null;
  if (!kind) return items[0];
  return items.find((i) => i.kind === kind) ?? null;
}

/**
 * Download and verify. The verification is not paranoia: an expired session
 * returns a 200-ish JSON error body, and writing that straight to disk produces
 * a 27-byte "video" that only fails much later, in the edit.
 */
export async function downloadMedia(
  mediaId: string,
  outFile: string,
): Promise<{ file: string; bytes: number; kind: string }> {
  let resolvedPath = path.isAbsolute(outFile) ? outFile : path.join(config.outputDir, outFile);
  const isVideo = resolvedPath.toLowerCase().endsWith(".mp4") || !resolvedPath.includes(".");
  if (resolvedPath.endsWith("/") || resolvedPath.endsWith("\\")) {
    resolvedPath = path.join(resolvedPath, `flow-${mediaId.slice(-12)}.${isVideo ? "mp4" : "jpg"}`);
  }
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  const targetKind = isVideo ? "video" : "image";
  let buffer = await fetchSigned(mediaId, targetKind);

  // A stale session yields a JSON/text body where media bytes belong. One reload fixes it.
  if (!identify(buffer)) {
    await reloadSession();
    buffer = await fetchSigned(mediaId, targetKind);
  }

  const kind = identify(buffer);
  if (!kind) {
    const preview = buffer.subarray(0, 200).toString("utf8").replace(/\s+/g, " ");
    throw new FlowError(
      `Downloaded ${buffer.length} bytes for ${mediaId} that are not image or video data. Body starts: ${preview}`,
      `This is the expired-session signature ("No session found"). Nothing was written. Run flow_check_session, then retry.`,
    );
  }
  if (buffer.length < MIN_MEDIA_BYTES) {
    throw new FlowError(
      `Downloaded file for ${mediaId} is only ${buffer.length} bytes — too small to be a real ${kind}.`,
      `Nothing was written. Confirm the generation actually finished before downloading.`,
    );
  }

  await fs.writeFile(resolvedPath, buffer);
  return { file: resolvedPath, bytes: buffer.length, kind };
}

async function fetchSigned(mediaId: string, kind?: "video" | "image"): Promise<Buffer> {
  const url = await resolveMediaUrl(mediaId, kind);
  const res = await fetch(url, { redirect: "follow" });
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Magic-byte identification. This is the check that stops an expired-session JSON
 * error body from being written to disk as a .jpg.
 * @internal exported for unit tests
 */
export function identify(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  return FILE_SIGNATURES.find((s) => s.test(buffer))?.ext ?? null;
}

/**
 * Deletion hygiene keeps a project navigable, but it is genuinely destructive and
 * has over-reached before — a deleted source clip cannot be re-added to a scene
 * reliably. Callers must pass explicit ids; there is deliberately no "delete all".
 */
export async function deleteMedia(mediaIds: string[]): Promise<{ deleted: string[]; failed: string[] }> {
  const page = await getFlowPage();
  const deleted: string[] = [];
  const failed: string[] = [];

  for (const id of mediaIds) {
    const ok = await page.evaluate((mediaId) => {
      const img = [...document.querySelectorAll<HTMLImageElement>("img")].find(
        (i) => i.src.includes(encodeURIComponent(mediaId)) || i.src.includes(mediaId),
      );
      const card = img?.closest("[data-media-id],[role=listitem],li,article") as HTMLElement | null;
      if (!card) return false;
      const menu = [...card.querySelectorAll<HTMLElement>("button,[role=button]")].find((b) =>
        /more|option|menu|⋮/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
      );
      if (!menu) return false;
      menu.click();
      return true;
    }, id);

    if (!ok) {
      failed.push(id);
      continue;
    }
    await page.waitForTimeout(600);
    const confirmed = await page.evaluate(() => {
      const item = [...document.querySelectorAll<HTMLElement>("[role=menuitem],button,div[role]")].find(
        (e) => e.offsetParent && /^delete|remove$/i.test((e.textContent ?? "").trim()),
      );
      if (!item) return false;
      item.click();
      return true;
    });
    (confirmed ? deleted : failed).push(id);
    await page.waitForTimeout(600);
  }

  return { deleted, failed };
}
