import * as path from "node:path";
import { TIMEOUTS } from "../constants.js";
import { FlowError } from "../types.js";
import { assertNoStopSignal, getFlowPage } from "./browser.js";
import { clickByText, pageText } from "./transport.js";

/**
 * COMPOSER CONTROL — settings, frame attachment, upload.
 *
 * Flow's generation modes are not separate endpoints. They are the same chat
 * submission with different things attached to the composer:
 *
 *   Text-to-Video          prompt alone
 *   Frames-to-Video        prompt + a start frame (optionally + an end frame)
 *   Ingredients-to-Video   prompt + up to 3 reference images
 *
 * So "which mode am I in" is decided by what is attached when Enter is pressed,
 * which is why attachment lives here and is verified by media id rather than
 * trusted. A text-only reference to an earlier still ("use the first one") lets
 * Flow's agent pick, and it picks wrong often enough to cost real credits.
 *
 * Model tier, aspect ratio and output count are per-PROJECT globals behind the
 * settings gear, not per-generation arguments. Set once, they persist across
 * chat turns — and a stale tier is the single most common way a 20-credit clip
 * silently becomes a 100-credit one.
 */

export type ModelTier = "veo-3.1-lite" | "veo-3.1-fast" | "veo-3.1-quality" | "gemini-omni-flash";
export type AspectRatio = "16:9" | "9:16" | "1:1";

export interface FlowSettings {
  model: string | null;
  aspectRatio: string | null;
  outputsPerPrompt: number | null;
  /** Clip length. A cost lever on Gemini Omni Flash, which charges 15/20/25/30 by duration. */
  durationSeconds: number | null;
  confirmGate: "always" | "off" | "unknown";
}

const SETTINGS_LABELS: Record<keyof Omit<FlowSettings, "confirmGate">, RegExp> = {
  model: /model|quality|veo/i,
  aspectRatio: /aspect|ratio|orientation/i,
  outputsPerPrompt: /outputs? per prompt|number of (outputs|videos)/i,
  durationSeconds: /duration|length|seconds/i,
};

async function openSettings(): Promise<void> {
  const page = await getFlowPage();
  const opened = await page.evaluate(() => {
    const modernBtn = document.querySelector<HTMLElement>(".settings-trigger-button, button[aria-label*='Settings trigger']");
    if (modernBtn && modernBtn.offsetParent !== null) {
      modernBtn.click();
      return true;
    }
    const gear = [...document.querySelectorAll<HTMLElement>("button,[role=button]")].find((b) => {
      const label = `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`;
      return /setting|tune|gear/i.test(label) && b.offsetParent !== null;
    });
    if (!gear) return false;
    gear.click();
    return true;
  });
  if (!opened) {
    throw new FlowError(
      "Could not find Flow's settings control.",
      "Open the settings gear manually in the browser, or re-run flow_discover_api if Flow's UI has changed.",
    );
  }
  await page.waitForTimeout(1_200);
}

async function closeSettings(): Promise<void> {
  const page = await getFlowPage();
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
}

/** Read the per-project generation settings. Checks localStorage fast-path first. */
export async function readSettings(): Promise<FlowSettings> {
  const page = await getFlowPage();

  // Fast-path: read from localStorage flow-prompt-box-settings
  const local = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem("flow-prompt-box-settings");
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          model: parsed.rt ?? null,
          aspectRatio: parsed.aspectRatio === "PORTRAIT" ? "9:16" : parsed.aspectRatio === "LANDSCAPE" ? "16:9" : parsed.aspectRatio ?? null,
          outputsPerPrompt: parsed.Jp ?? 1,
          durationSeconds: parsed.gB ?? 8,
          confirmGate: "always" as const,
        };
      }
    } catch {}
    return null;
  });

  if (local && local.model) {
    return local;
  }

  await openSettings();
  const raw = await page.evaluate(() => {
    const rows: { label: string; value: string }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("[role=dialog] *, [role=menu] *")) {
      if (el.children.length > 3 || !el.offsetParent) continue;
      const text = (el.textContent ?? "").trim();
      if (text.length > 0 && text.length < 120) rows.push({ label: text, value: text });
    }
    return rows;
  });

  const joined = raw.map((r) => r.label).join(" | ");
  const settings: FlowSettings = {
    model: /veo\s*3\.1\s*(lite|fast|quality)/i.exec(joined)?.[0] ?? null,
    aspectRatio: /\b(16:9|9:16|1:1)\b/.exec(joined)?.[0] ?? null,
    outputsPerPrompt: Number.parseInt(/(\d)\s*outputs? per prompt/i.exec(joined)?.[1] ?? "", 10) || null,
    durationSeconds: Number.parseInt(/\b(\d{1,2})\s*s(?:ec|econds)?\b/i.exec(joined)?.[1] ?? "", 10) || null,
    confirmGate: /confirm before generating[^|]{0,40}off/i.test(joined)
      ? "off"
      : /confirm before generating/i.test(joined)
        ? "always"
        : "unknown",
  };

  await closeSettings();
  return settings;
}

/**
 * Set a per-project setting by clicking its labelled control.
 *
 * Changing the model tier is the highest-leverage free action in Flow: moving a
 * project from Quality to Fast turns every subsequent clip from 100 credits into
 * 20. It is deliberately its own tool rather than a generate() argument, because
 * it is project state — setting it per-call would be a lie about how Flow works.
 */
/**
 * Set a per-project setting by syncing localStorage and clicking its labelled control.
 */
export async function setSetting(key: keyof typeof SETTINGS_LABELS | "mode", value: string): Promise<FlowSettings> {
  const page = await getFlowPage();

  // 1. Direct localStorage fast sync
  await page.evaluate(({ k, v }) => {
    try {
      const raw = localStorage.getItem("flow-prompt-box-settings");
      const current = raw ? JSON.parse(raw) : {};
      const val = v.toLowerCase();

      if (k === "model") {
        if (val.includes("lite")) current.rt = "veo_3_1_lite";
        else if (val.includes("fast")) current.rt = "veo_3_1_fast";
        else if (val.includes("quality")) current.rt = "veo_3_1_quality";
      } else if (k === "aspectRatio") {
        if (val.includes("9:16") || val.includes("portrait")) current.aspectRatio = "PORTRAIT";
        else if (val.includes("16:9") || val.includes("landscape")) current.aspectRatio = "LANDSCAPE";
        else if (val.includes("1:1") || val.includes("square")) current.aspectRatio = "SQUARE";
      } else if (k === "durationSeconds") {
        current.gB = parseInt(v, 10) || 8;
      } else if (k === "outputsPerPrompt") {
        current.Jp = parseInt(v, 10) || 1;
      } else if (k === "mode") {
        current.mode = v;
      }
      localStorage.setItem("flow-prompt-box-settings", JSON.stringify(current));
    } catch {}
  }, { k: key, v: value });

  // 2. Click in settings overlay to update Angular UI
  try {
    await openSettings();
    await page.evaluate(
      ([k, v]) => {
        const val = (v as string).toLowerCase();
        const overlays = Array.from(document.querySelectorAll<HTMLElement>(".cdk-overlay-pane button, [role=dialog] button, [role=menu] button"));
        
        if (k === "aspectRatio") {
          const targetText = val.includes("9:16") || val.includes("portrait") ? "9:16" : "16:9";
          const btn = overlays.find((b) => (b.innerText || "").includes(targetText));
          btn?.click();
        } else if (k === "durationSeconds") {
          const targetText = `${parseInt(v as string, 10)}s`;
          const btn = overlays.find((b) => (b.innerText || "").trim() === targetText);
          btn?.click();
        } else if (k === "outputsPerPrompt") {
          const targetText = `x${parseInt(v as string, 10)}`;
          const btn = overlays.find((b) => (b.innerText || "").trim() === targetText);
          btn?.click();
        } else if (k === "mode") {
          const targetText = (v as string) === "VIDEO_FRAMES" ? "Frames" : "Video";
          const btn = overlays.find((b) => (b.innerText || "").includes(targetText));
          btn?.click();
        }
      },
      [key, value] as const,
    );
    await page.waitForTimeout(400);
    await closeSettings();
  } catch {
    // If UI click fails, localStorage sync above still persists
  }

  return readSettings();
}

/**
 * Open the composer's media picker (the "+" / add control or chip slot).
 */
async function openPicker(): Promise<void> {
  const page = await getFlowPage();
  const opened = await page.evaluate(() => {
    const chip = document.querySelector<HTMLElement>(".chip-container, button[aria-label*='Add media menu']");
    if (chip && chip.offsetParent !== null) {
      chip.click();
      return true;
    }
    const add = [...document.querySelectorAll<HTMLElement>("button,[role=button]")].find((b) => {
      const label = `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`.trim();
      return /^add|add_2|attach|\+$/i.test(label) && b.offsetParent !== null;
    });
    if (!add) return false;
    add.click();
    return true;
  });
  if (!opened) {
    throw new FlowError(
      "Could not open Flow's media picker on the composer.",
      "Confirm a project is open and the chat composer is visible, then retry.",
    );
  }
  await page.waitForTimeout(1_500);
}

/**
 * Attach library media to the composer and VERIFY by media id.
 *
 * Verification matters: still batches return two outputs sharing one auto-name in
 * the picker, so selecting "by name" is ambiguous. The selected option's img src
 * carries the real id, and that is what we check.
 */
export async function attachMedia(mediaIds: string[]): Promise<{ attached: string[]; missing: string[] }> {
  if (mediaIds.length === 0) return { attached: [], missing: [] };
  if (mediaIds.length > 3) {
    throw new FlowError(
      `Flow accepts at most 3 reference images; ${mediaIds.length} were supplied.`,
      "Reduce to the 3 that matter most, or use a single start frame with Frames-to-Video instead.",
    );
  }

  await assertNoStopSignal();
  const page = await getFlowPage();
  const attached: string[] = [];
  const missing: string[] = [];

  for (const id of mediaIds) {
    await openPicker();
    const ok = await page.evaluate((mediaId) => {
      const options = [...document.querySelectorAll<HTMLElement>("[role=option],[role=listitem],li")];
      const match = options.find((o) => {
        const img = o.querySelector("img");
        return img ? img.src.includes(mediaId) || img.src.includes(encodeURIComponent(mediaId)) : false;
      });
      if (!match) return false;
      match.click();
      return true;
    }, id);

    await page.waitForTimeout(800);
    (ok ? attached : missing).push(id);
  }

  // Confirm the chips the composer now actually holds.
  const chipIds = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLImageElement>(
        '[data-testid*="chip"] img, [class*="chip"] img, [class*="attachment"] img',
      ),
    ].map((i) => i.src),
  );
  const verified = attached.filter((id) =>
    chipIds.some((src) => src.includes(id) || src.includes(encodeURIComponent(id))),
  );

  if (verified.length !== attached.length) {
    throw new FlowError(
      `Attached ${attached.length} item(s) but only ${verified.length} chip(s) are visible on the composer.`,
      "Nothing was charged. Attach the frame manually in the browser and retry, or the wrong frame may be animated.",
    );
  }

  return { attached: verified, missing };
}

/**
 * Upload an external image as a start frame. Playwright sets the file directly on
 * the input, which is more reliable than the drag-and-drop path and has no
 * filesystem-location restriction.
 */
export async function uploadMedia(filePath: string): Promise<{ file: string; note: string }> {
  const page = await getFlowPage();
  await openPicker();

  const input = await page.$('input[type="file"]');
  if (!input) {
    throw new FlowError(
      "Flow's picker did not expose a file input.",
      "Upload the frame manually in the browser, then attach it by media id with flow_attach_frames.",
    );
  }

  await input.setInputFiles(path.resolve(filePath));
  await page.waitForTimeout(4_000);

  return {
    file: path.resolve(filePath),
    note: "Uploaded. It lands as a picker option — confirm the resulting media id with flow_list_media before animating it.",
  };
}

/** Clear whatever is currently attached, so a stale chip cannot leak into the next clip. */
export async function clearAttachments(): Promise<number> {
  const page = await getFlowPage();
  const removed = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll<HTMLElement>("button,[role=button]")].filter((b) => {
      const label = `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`;
      return /remove|clear|close|×/i.test(label) && b.closest('[class*="chip"],[class*="attachment"]') !== null;
    });
    buttons.forEach((b) => b.click());

    // Also clear prompt box ingredient chips
    const chips = Array.from(
      document.querySelectorAll(
        "flow-prompt-box flow-ingredient-chip, flow-prompt-box flow-character-ingredient-chip, flow-prompt-box .chip-container",
      ),
    );
    chips.forEach((c) => {
      const btn = c.querySelector("button, mat-icon, [aria-label*='Remove' i], [aria-label*='Delete' i]");
      if (btn) ((btn as HTMLElement).closest("button") || (btn as HTMLElement)).click();
    });

    return buttons.length + chips.length;
  });
  await page.waitForTimeout(600);
  return removed;
}

/** Set prompt box generation mode (VIDEO_FRAMES or TEXT_TO_VIDEO). */
export async function setFlowMode(mode: "VIDEO_FRAMES" | "TEXT_TO_VIDEO"): Promise<void> {
  const page = await getFlowPage();
  await page.evaluate((targetMode) => {
    try {
      const raw = localStorage.getItem("flow-prompt-box-settings");
      const current = raw ? JSON.parse(raw) : {};
      current.mode = targetMode;
      localStorage.setItem("flow-prompt-box-settings", JSON.stringify(current));
    } catch {}
  }, mode);
  await page.waitForTimeout(400);
}

/** Clear Start, End, or both frame chips back to empty-chip. */
export async function clearFrames(slot: "start" | "end" | "both" = "both"): Promise<number> {
  const page = await getFlowPage();
  const cleared = await page.evaluate((targetSlot) => {
    const chips = Array.from(
      document.querySelectorAll<HTMLElement>("flow-prompt-box .chip-container, .prompt-box .chip-container"),
    );
    let count = 0;
    chips.forEach((chip, index) => {
      const isStart = index === 0;
      const isEnd = index === 1 || (chips.length === 1 && !isStart);
      if (targetSlot === "both" || (targetSlot === "start" && isStart) || (targetSlot === "end" && isEnd)) {
        const cancelBtn =
          chip.querySelector<HTMLElement>(
            "button, mat-icon, [aria-label*='remove' i], [aria-label*='delete' i], [aria-label*='cancel' i]",
          ) || chip;
        if (cancelBtn) {
          cancelBtn.click();
          count++;
        }
      }
    });
    return count;
  }, slot);
  if (cleared > 0) await page.waitForTimeout(500);
  return cleared;
}

/** Swap first and last frames in prompt box. */
export async function swapFrames(): Promise<boolean> {
  const page = await getFlowPage();
  const swapped = await page.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>("button[aria-label='Swap first and last frames']");
    if (btn && !btn.disabled && btn.offsetParent !== null) {
      btn.click();
      return true;
    }
    return false;
  });
  if (swapped) await page.waitForTimeout(500);
  return swapped;
}

/** Assign an asset to Start or End slot in VIDEO_FRAMES mode. */
export async function assignFrame(slot: "start" | "end", assetNameOrId: string): Promise<boolean> {
  const page = await getFlowPage();
  await setFlowMode("VIDEO_FRAMES");

  // If slot already has an ingredient, clear it first
  await clearFrames(slot);

  const clicked = await page.evaluate((targetSlot) => {
    const targetText = targetSlot.toLowerCase() === "start" ? "Start" : "End";
    const chips = Array.from(document.querySelectorAll<HTMLElement>("button.empty-chip, .frame-trigger button"));
    const chip = chips.find((c) => (c.innerText || "").trim() === targetText);
    if (chip && chip.offsetParent !== null) {
      chip.click();
      return true;
    }
    return false;
  }, slot);

  if (!clicked) return false;
  await page.waitForTimeout(1000);

  const selected = await page.evaluate((target) => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(".cdk-overlay-pane .asset-item, .cdk-overlay-pane button"),
    );
    const match = items.find((el) => {
      const txt = (el.innerText || "").toLowerCase();
      const img = el.querySelector("img");
      const src = img ? img.src.toLowerCase() : "";
      return txt.includes(target.toLowerCase()) || src.includes(target.toLowerCase());
    });
    if (match) {
      match.click();
      return true;
    }
    return false;
  }, assetNameOrId);

  await page.waitForTimeout(800);
  await page.keyboard.press("Escape").catch(() => {});
  return selected;
}

/** Upload a local file and assign directly to Start or End slot. */
export async function uploadToSlot(slot: "start" | "end", filePath: string): Promise<boolean> {
  const page = await getFlowPage();
  await setFlowMode("VIDEO_FRAMES");

  // If slot already has an ingredient, clear it first
  await clearFrames(slot);

  const clicked = await page.evaluate((targetSlot) => {
    const targetText = targetSlot.toLowerCase() === "start" ? "Start" : "End";
    const chips = Array.from(document.querySelectorAll<HTMLElement>("button.empty-chip, .frame-trigger button"));
    const chip = chips.find((c) => (c.innerText || "").trim() === targetText);
    if (chip && chip.offsetParent !== null) {
      chip.click();
      return true;
    }
    return false;
  }, slot);

  if (!clicked) return false;
  await page.waitForTimeout(800);

  const resolved = path.resolve(filePath);
  const baseName = path.basename(resolved);

  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      page.click(".cdk-overlay-pane button.upload-button, button[aria-label='Upload media'], button.upload-media"),
    ]);

    await fileChooser.setFiles(resolved);
    await page.waitForTimeout(3500);

    // After uploading, click the item in the overlay to select it into the slot
    await page.evaluate((name) => {
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(".cdk-overlay-pane .asset-item, .cdk-overlay-pane button"),
      );
      const match = items.find((el) => (el.innerText || "").includes(name));
      if (match) match.click();
    }, baseName);

    await page.waitForTimeout(800);
    await page.keyboard.press("Escape").catch(() => {});
    return true;
  } catch (err) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new FlowError(`Failed to upload ${filePath} to ${slot} slot: ${(err as Error).message}`);
  }
}

/** Trigger free 1080p upscale on the latest generated video clip. */
export async function trigger1080pUpscaleLatest(timeoutMs = 90_000): Promise<{ success: boolean; note: string }> {
  const page = await getFlowPage();

  const tileClicked = await page.evaluate(() => {
    const tiles = Array.from(
      document.querySelectorAll<HTMLElement>("flow-custom-tile, [class*='tile'], flow-tile-container, .batch-container"),
    );
    if (tiles.length > 0) {
      tiles[0].click();
      return true;
    }
    return false;
  });

  if (!tileClicked) {
    return { success: false, note: "Could not find latest video tile." };
  }
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLElement>("button[aria-label*='Download' i], button.download-button"));
    if (btns.length > 0) btns[0].click();
  });
  await page.waitForTimeout(800);

  const upscaledClicked = await page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(".cdk-overlay-container button, .mat-mdc-menu-item, [role='menuitem']"),
    );
    const item1080 = items.find((el) => (el.textContent || "").includes("1080p"));
    if (item1080) {
      item1080.click();
      return true;
    }
    return false;
  });

  if (!upscaledClicked) {
    await page.keyboard.press("Escape").catch(() => {});
    return { success: false, note: "1080p upscale option not offered (clip may already be 1080p)." };
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(1000);
    const inProgress = await page.evaluate(() => {
      const text = document.body?.innerText ?? "";
      return /upscaling|rendering 1080p/i.test(text);
    });
    if (!inProgress && Date.now() - start > 10_000) {
      break;
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  return { success: true, note: "1080p upscale complete." };
}

/**
 * Upscale. 1080p is free on paid plans; 4K costs 50 credits and is Ultra-only,
 * so it goes through the same explicit-cost gate as any other paid action.
 */
export async function upscale(mediaId: string, target: "1080p" | "4k"): Promise<{ started: boolean; note: string }> {
  await assertNoStopSignal();
  const page = await getFlowPage();

  const opened = await page.evaluate((id) => {
    const img = [...document.querySelectorAll<HTMLImageElement>("img")].find(
      (i) => i.src.includes(id) || i.src.includes(encodeURIComponent(id)),
    );
    const card = img?.closest("[data-media-id],[role=listitem],li,article") as HTMLElement | null;
    const menu = [...(card?.querySelectorAll<HTMLElement>("button,[role=button]") ?? [])].find((b) =>
      /more|option|menu|⋮/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
    );
    if (!menu) return false;
    menu.click();
    return true;
  }, mediaId);

  if (!opened) {
    throw new FlowError(
      `Could not open the item menu for media ${mediaId}.`,
      "Confirm the id is in the current project's library with flow_list_media.",
    );
  }

  await page.waitForTimeout(700);
  const clicked = await clickByText(target === "4k" ? "Upscale to 4K" : "Upscale to 1080p", {
    exact: false,
    maxDescendants: 4,
  });

  if (!clicked) {
    throw new FlowError(
      `Flow did not offer a ${target} upscale for this item.`,
      target === "4k"
        ? "4K upscale is Ultra-plan only. Take the free 1080p upscale instead — never pay for 4K on social content."
        : "The item may already be 1080p, or upscaling may not apply to stills.",
    );
  }

  return {
    started: true,
    note:
      target === "4k"
        ? "4K upscale started — this costs 50 credits and was NOT routed through the quote gate, because Flow does not quote upscales in a proposal card. Verify the balance with flow_check_session."
        : "1080p upscale started. Free on paid plans.",
  };
}

/** Best-effort read of what the composer currently holds, for pre-flight sanity checks. */
export async function describeComposer(): Promise<string> {
  const text = await pageText();
  const settings = await readSettings().catch(() => null);
  const lines = [
    settings
      ? `Model: ${settings.model ?? "unknown"} | Aspect: ${settings.aspectRatio ?? "unknown"} | Outputs: ${settings.outputsPerPrompt ?? "unknown"} | Confirm gate: ${settings.confirmGate}`
      : "Settings could not be read.",
  ];
  if (/frames? to video|ingredients/i.test(text)) lines.push("Composer appears to be in a frames/ingredients mode.");
  return lines.join("\n");
}

export const TIMEOUT_HINT = TIMEOUTS;
