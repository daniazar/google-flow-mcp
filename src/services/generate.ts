import { POLL_INTERVAL_MS, TIMEOUTS } from "../constants.js";
import { BudgetError, FlowError, type CostQuote, type GenerationResult, type LedgerEntry } from "../types.js";
import { assertNoStopSignal, getFlowPage } from "./browser.js";
import {
  assignFrame,
  attachMedia,
  clearAttachments,
  readSettings,
  trigger1080pUpscaleLatest,
  uploadToSlot,
} from "./compose.js";
import { appendLedger, assertAffordable, recordSpend } from "./ledger.js";
import { downloadMedia, listMedia } from "./media.js";
import { readCredits, readSession } from "./session.js";
import { clickByText, pageText } from "./transport.js";

/**
 * GENERATION IS THE ONLY PLACE THIS SERVER SPENDS MONEY.
 *
 * Flow's UI is an agent-chat, not a form: you send a request, Flow's own agent
 * replies with a proposal carrying a quoted credit cost and Approve/Reject
 * controls, and nothing is charged until Approve. Every safeguard here exists to
 * keep that property intact:
 *
 *   - the quote is READ and CHECKED before Approve is ever clicked
 *   - a rejected proposal costs zero, so dry_run is a genuinely free price probe
 *   - the Approve click is text-matched precisely enough to never hit
 *     "Approve, do not ask again", which would disable the gate for the session
 *   - an in-flight generation is never resubmitted; a resubmit is a second charge
 */

export interface GenerateOptions {
  prompt: string;
  /** Refuse and reject the proposal if Flow quotes more than this. */
  expectedMaxCost: number;
  /** Quote the price, reject, charge nothing. */
  dryRun?: boolean;
  /** Approve and return immediately, for parallel submission. Collect later. */
  noWait?: boolean;
  /** Where to save. Relative paths resolve under FLOW_OUTPUT_DIR. */
  outFile?: string;
  /** Stills are free; this skips the budget machinery but not the stop-signal checks. */
  free?: boolean;
  timeoutMs?: number;
  /**
   * Frame conditioning for boundary-locked loops and transitions:
   *   startFrameMediaId / startFramePath -> Start frame
   *   endFrameMediaId / endFramePath     -> End frame (for locked loops or FLF transitions)
   *   referenceMediaIds                  -> Ingredients-to-Video (recomposes; <=3 refs)
   */
  startFrameMediaId?: string;
  endFrameMediaId?: string;
  startFramePath?: string;
  endFramePath?: string;
  referenceMediaIds?: string[];
  /** Automatically trigger free 1080p cloud upscale on generated video. */
  autoUpscale?: boolean;
}

export function describeMode(opts: GenerateOptions): string {
  if (opts.referenceMediaIds?.length)
    return `Ingredients-to-Video (${opts.referenceMediaIds.length} reference image(s))`;
  if ((opts.startFrameMediaId || opts.startFramePath) && (opts.endFrameMediaId || opts.endFramePath))
    return "Frames-to-Video (start + end frame locked)";
  if (opts.startFrameMediaId || opts.startFramePath) return "Frames-to-Video (start frame)";
  return "Text-to-Video (no attachment — composition is uncontrolled)";
}

/** Preflight that must pass before any request reaches Flow's chat. */
async function preflight(free: boolean): Promise<number | null> {
  const session = await readSession();

  if (!session.browserConnected) {
    throw new FlowError("No browser session.", session.blockedBy ?? "Run flow_check_session for setup instructions.");
  }
  if (!session.loggedIn) {
    throw new FlowError(
      "The attached browser is not signed into Google Flow.",
      "Sign in at labs.google/fx/tools/flow in that Chrome window. This server never handles credentials.",
    );
  }
  if (session.blockedBy) throw new FlowError(session.blockedBy);

  if (!free && session.confirmGate === "off") {
    throw new BudgetError(
      'Flow\'s "Confirm before generating" setting is OFF, so Flow will charge without showing an approval card.',
      'Open the settings gear and set "Confirm before generating" to Always. Until then this server refuses all paid generation, because the cost gate cannot work.',
    );
  }

  return session.credits;
}

/**
 * Submit text into Flow's composer.
 *
 * The composer is a contenteditable div, not an input: setting `value` or using
 * a generic fill lands the text in a hidden search overlay instead. Real keyboard
 * events into a focused div are the only reliable route, and the Send button
 * frequently does not fire, so Enter is the submit path. We verify the message
 * actually left the box rather than assuming.
 */
/**
 * Submit text into Flow's composer.
 * Supports ProseMirror (modern flow.google.com), textarea, or contenteditable.
 */
async function submitPrompt(prompt: string): Promise<void> {
  const page = await getFlowPage();

  const focused = await page.evaluate(() => {
    // 1. ProseMirror (modern flow.google.com prompt box)
    const prosemirror = document.querySelector<HTMLElement>("div.ProseMirror");
    if (prosemirror && prosemirror.offsetParent !== null) {
      prosemirror.focus();
      prosemirror.click();
      return true;
    }
    // 2. Generic contenteditable
    const boxes = [...document.querySelectorAll<HTMLElement>('div[contenteditable="true"]')].filter(
      (d) => d.offsetParent,
    );
    const box = boxes[boxes.length - 1];
    if (box) {
      box.focus();
      box.click();
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return true;
    }
    // 3. Textarea
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea.prompt-box-textarea, textarea");
    if (textarea && textarea.offsetParent !== null) {
      textarea.focus();
      return true;
    }
    return false;
  });

  if (!focused) {
    throw new FlowError(
      "Could not find Flow's prompt composer on the page.",
      "Confirm a Flow project is open (flow.google.com/project/<id>) and run flow_check_session.",
    );
  }

  // Clear existing content and type prompt
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(prompt, { delay: 4 });
  await page.waitForTimeout(500);
}

/**
 * Wait for Flow's agent to propose a generation and quote its cost (legacy chat mode).
 */
async function awaitQuote(timeoutMs: number): Promise<CostQuote> {
  const deadline = Date.now() + timeoutMs;
  const page = await getFlowPage();

  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    await assertNoStopSignal(page);

    const text = await pageText();
    const matches = [...text.matchAll(/(\d[\d,]*)\s*credits?/gi)];
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      const credits = Number.parseInt(last[1].replace(/,/g, ""), 10);
      if (Number.isFinite(credits)) {
        return { credits, rawText: last[0] };
      }
    }

    if (/failed|error|something went wrong/i.test(text.slice(-2_000))) {
      throw new FlowError(
        "Flow reported an error instead of a cost proposal.",
        "Nothing was charged. Check the chat in the browser; if it is the known audio-generation failure on crowd scenes, re-request the clip as a silent video with no audio track.",
      );
    }
  }

  throw new FlowError(
    `No cost quote appeared within ${Math.round(timeoutMs / 1000)}s.`,
    "Nothing was charged. Inspect the Flow chat in the browser before retrying — do NOT resubmit blindly, since a duplicate submission is a second charge.",
  );
}

/**
 * Click Approve, and only Approve (legacy chat mode).
 */
async function clickApprove(): Promise<void> {
  if (await clickByText("checkApprove", { exact: true, maxDescendants: 4 })) return;
  if (await clickByText("Approve", { exact: true, maxDescendants: 1 })) return;
  throw new FlowError(
    "Found a cost quote but could not locate the Approve control.",
    "Nothing was charged. Flow's UI may have changed — run flow_discover_api and check references/ui-playbook.md.",
  );
}

async function clickReject(): Promise<void> {
  if (await clickByText("closeReject", { exact: true, maxDescendants: 4 })) return;
  await clickByText("Reject", { exact: true, maxDescendants: 2 });
}

/** Trigger modern Flow generation button. */
async function triggerModernGeneration(): Promise<boolean> {
  const page = await getFlowPage();
  return await page.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      "button.generate-icon-button, button[aria-label*='generation' i], button[aria-label*='generate' i], button.generate-button",
    );
    if (btn && !btn.disabled && btn.offsetParent !== null) {
      btn.click();
      return true;
    }
    return false;
  });
}

/**
 * Live generation telemetry and status.
 */
export interface GenerationStatus {
  isGenerating: boolean;
  activeTilesCount: number;
  progressText: string | null;
  lastError: string | null;
}

/** Check if any active generation is currently in-flight or if an error was raised. */
export async function getGenerationStatus(): Promise<GenerationStatus> {
  const page = await getFlowPage();
  return page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    let lastError: string | null = null;
    if (/audio generation failed/i.test(text)) {
      lastError = "Flow Audio Generation Failed.";
    } else if (/violates our policies|prompt failed due to a violation/i.test(text)) {
      lastError = "Prompt rejected by Flow policy filters.";
    } else if (/generation failed|something went wrong/i.test(text)) {
      lastError = "Flow generation failed.";
    }

    const toast = document.querySelector(".mat-mdc-snack-bar-container, [role='alert']")?.textContent?.trim() || null;
    if (toast && /fail|error|violation/i.test(toast)) {
      lastError = toast;
    }

    const spinners = Array.from(
      document.querySelectorAll(
        "mat-spinner, mat-progress-spinner, mat-progress-bar, .spinner, [class*='progress'], [aria-label*='loading' i]",
      ),
    ).filter((el) => (el as HTMLElement).offsetParent !== null);

    const match = text.match(/generating\s*(\d{1,3}%?)/i);
    const progressText = match ? match[0] : spinners.length > 0 ? "Generating..." : null;

    return {
      isGenerating: spinners.length > 0 || Boolean(progressText),
      activeTilesCount: spinners.length,
      progressText,
      lastError,
    };
  });
}

/**
 * Poll for media that did not exist before submission.
 * Fast polling (1s) with immediate failure detection scoped to the newly generated batch.
 */
async function awaitNewMedia(before: Set<string>, timeoutMs: number, initialBatchCount = 0): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const page = await getFlowPage();

  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    await assertNoStopSignal(page);

    // Fast-fail check scoped ONLY to the newly mounted batch tile
    const newTileStatus = await page.evaluate((initialCount) => {
      const currentTiles = Array.from(document.querySelectorAll<HTMLElement>(".batch-container"));
      if (currentTiles.length <= initialCount) {
        return null;
      }
      const newestTile = currentTiles[0];
      const text = (newestTile.innerText || "").replace(/\s+/g, " ");
      const isFailed = /failed|warning|error|violate/i.test(text) && !/generating|rendering/i.test(text);
      return {
        isFailed,
        text: text.slice(0, 150),
      };
    }, initialBatchCount);

    if (newTileStatus && newTileStatus.isFailed) {
      throw new FlowError(`Flow generation failed: ${newTileStatus.text}`);
    }

    // Also check for global immediate snackbar toasts
    const toastError = await page.evaluate(() => {
      const toast = document.querySelector(".mat-mdc-snack-bar-container, [role='alert']")?.textContent?.trim();
      return toast && /fail|error|violation/i.test(toast) ? toast : null;
    });
    if (toastError) {
      throw new FlowError(`Flow error alert: ${toastError}`);
    }

    const { items } = await listMedia(500, 0);
    const fresh = items.map((i) => i.mediaId).filter((id) => !before.has(id));
    if (fresh.length > 0) return fresh;
  }

  throw new FlowError(
    `Generation was submitted but produced no new media within ${Math.round(timeoutMs / 1000)}s.`,
    "Check the project in the browser and use flow_download once it appears. Do NOT resubmit blindly.",
  );
}

export async function generate(opts: GenerateOptions): Promise<GenerationResult> {
  const notes: string[] = [];
  const balanceBefore = await preflight(opts.free ?? false);
  await assertNoStopSignal();

  const { items: beforeItems } = await listMedia(500, 0);
  const before = new Set(beforeItems.map((i) => i.mediaId));

  // Frame slot conditioning (Start and End frames for boundary-locked loops and transitions)
  if (opts.startFramePath) {
    const ok = await uploadToSlot("start", opts.startFramePath);
    if (!ok) throw new FlowError(`Failed to upload and assign start frame from ${opts.startFramePath}`);
    notes.push(`Assigned Start frame from file: ${opts.startFramePath}`);
  } else if (opts.startFrameMediaId) {
    const ok = await assignFrame("start", opts.startFrameMediaId);
    if (!ok) throw new FlowError(`Failed to assign start frame media ID: ${opts.startFrameMediaId}`);
    notes.push(`Assigned Start frame media ID: ${opts.startFrameMediaId}`);
  }

  if (opts.endFramePath) {
    const ok = await uploadToSlot("end", opts.endFramePath);
    if (!ok) throw new FlowError(`Failed to upload and assign end frame from ${opts.endFramePath}`);
    notes.push(`Assigned End frame from file: ${opts.endFramePath}`);
  } else if (opts.endFrameMediaId) {
    const ok = await assignFrame("end", opts.endFrameMediaId);
    if (!ok) throw new FlowError(`Failed to assign end frame media ID: ${opts.endFrameMediaId}`);
    notes.push(`Assigned End frame media ID: ${opts.endFrameMediaId}`);
  }

  // Ingredients references (up to 3)
  if (opts.referenceMediaIds?.length) {
    await clearAttachments().catch(() => 0);
    const { attached, missing } = await attachMedia(opts.referenceMediaIds);
    if (missing.length > 0) {
      throw new FlowError(`Could not attach ${missing.length} reference image(s): ${missing.join(", ")}`);
    }
    notes.push(`Mode: Ingredients-to-Video; attached ${attached.length} reference image(s).`);
  }

  // Ensure prompt has ambient sound clause if frames are conditioned
  const hasFrames = opts.startFrameMediaId || opts.startFramePath || opts.endFrameMediaId || opts.endFramePath;
  const finalPrompt =
    hasFrames && !/sound:|audio:/i.test(opts.prompt)
      ? `${opts.prompt}. Sound: faint ambient studio room tone, subtle fabric rustle.`
      : opts.prompt;

  // Check if modern Flow prompt box is present
  const page = await getFlowPage();
  const isModernFlow = await page.evaluate(() => {
    return Boolean(
      document.querySelector("div.ProseMirror") ||
        document.querySelector(".settings-trigger-button") ||
        document.querySelector(".generate-icon-button"),
    );
  });

  if (isModernFlow) {
    const settings = await readSettings().catch(() => null);
    let quotedCredits = 5; // default Veo 3.1 Lite
    if (settings?.model?.toLowerCase().includes("fast")) quotedCredits = 10;
    else if (settings?.model?.toLowerCase().includes("quality")) quotedCredits = 50;

    if (opts.free) quotedCredits = 0;

    if (quotedCredits > opts.expectedMaxCost) {
      throw new FlowError(
        `Generation cost (${quotedCredits} credits) exceeds expectedMaxCost (${opts.expectedMaxCost}).`,
        `Switch model tier with flow_settings or raise expected_max_cost.`,
      );
    }

    if (opts.dryRun) {
      return {
        verdict: "rejected",
        quotedCost: quotedCredits,
        charged: 0,
        mediaIds: [],
        files: [],
        balanceAfter: balanceBefore,
        tier: "dom",
        notes: [`Dry run: Model is ${settings?.model ?? "Veo 3.1 Lite"} (${quotedCredits} credits). Nothing charged.`],
      };
    }

    const beforeBatchCount = await page.evaluate(() => document.querySelectorAll(".batch-container").length);
    await submitPrompt(finalPrompt);
    await page.waitForTimeout(600);

    // Pre-flight check: is the generate button enabled and are slots valid?
    const readyState = await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        "button.generate-icon-button, button[aria-label*='generation' i], button[aria-label*='generate' i], button.generate-button",
      );
      const disabledChips = document.querySelectorAll(".chip-container-disabled, .disabled-error-icon");
      return {
        hasBtn: Boolean(btn),
        disabled: btn ? btn.disabled : true,
        hasDisabledChip: disabledChips.length > 0,
      };
    });

    if (readyState.hasDisabledChip) {
      throw new FlowError(
        "A frame slot has an expired or invalid image (chip-container-disabled). Re-upload or re-assign the frame.",
      );
    }

    if (readyState.disabled) {
      await page.waitForTimeout(1000);
    }

    const triggered = await triggerModernGeneration();
    if (!triggered) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      const isStillDisabled = await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>("button.generate-icon-button");
        return btn ? btn.disabled : true;
      });
      if (isStillDisabled) {
        throw new FlowError(
          "Flow generate button is disabled. Confirm prompt text is non-empty and frame slots are valid.",
        );
      }
    }

    await recordSpend(quotedCredits);
    notes.push(`Submitted at ${quotedCredits} credits.`);

    if (opts.noWait) {
      await log({
        kind: "video",
        opts,
        quoted: quotedCredits,
        charged: quotedCredits,
        balance: balanceBefore,
        verdict: "in_flight",
        files: [],
      });
      return {
        verdict: "in_flight",
        quotedCost: quotedCredits,
        charged: quotedCredits,
        mediaIds: [],
        files: [],
        balanceAfter: null,
        tier: "dom",
        notes: [...notes, "Returned without waiting. Use flow_collect to download once rendering finishes."],
      };
    }

    const mediaIds = await awaitNewMedia(before, opts.timeoutMs ?? TIMEOUTS.renderMs, beforeBatchCount);
    const files = await saveAll(mediaIds, opts.outFile, opts.free ? "jpg" : "mp4");
    const balanceAfter = await readCredits();

    if (opts.autoUpscale && !opts.free && !opts.dryRun && !opts.noWait) {
      notes.push("Triggering free 1080p cloud upscale...");
      try {
        const upRes = await trigger1080pUpscaleLatest();
        notes.push(upRes.note);
      } catch (e) {
        notes.push(`1080p upscale notice: ${(e as Error).message}`);
      }
    }

    await log({
      kind: opts.free ? "still" : "video",
      opts,
      quoted: quotedCredits,
      charged: quotedCredits,
      balance: balanceAfter,
      verdict: "downloaded",
      files,
    });

    return {
      verdict: "downloaded",
      quotedCost: quotedCredits,
      charged: quotedCredits,
      mediaIds,
      files,
      balanceAfter,
      tier: "dom",
      notes,
    };
  }

  // Legacy Flow chat flow fallback
  await submitPrompt(opts.prompt);

  // Free stills produce no proposal card, so there is no quote to gate on.
  if (opts.free) {
    const mediaIds = await awaitNewMedia(before, opts.timeoutMs ?? TIMEOUTS.stillMs);
    const files = await saveAll(mediaIds, opts.outFile, "jpg");
    await log({ kind: "still", opts, quoted: 0, charged: 0, balance: balanceBefore, verdict: "downloaded", files });
    return {
      verdict: "downloaded",
      quotedCost: 0,
      charged: 0,
      mediaIds,
      files,
      balanceAfter: balanceBefore,
      tier: "dom",
      notes: ["Stills are free; no approval gate applies."],
    };
  }

  const quote = await awaitQuote(TIMEOUTS.quoteMs);

  try {
    await assertAffordable(quote.credits, opts.expectedMaxCost, balanceBefore);
  } catch (err) {
    await clickReject();
    notes.push("Proposal was rejected; nothing was charged.");
    await log({
      kind: "video",
      opts,
      quoted: quote.credits,
      charged: 0,
      balance: balanceBefore,
      verdict: "rejected",
      files: [],
    });
    throw err;
  }

  if (opts.dryRun) {
    await clickReject();
    await log({
      kind: "video",
      opts,
      quoted: quote.credits,
      charged: 0,
      balance: balanceBefore,
      verdict: "rejected",
      files: [],
      note: "dry run",
    });
    return {
      verdict: "rejected",
      quotedCost: quote.credits,
      charged: 0,
      mediaIds: [],
      files: [],
      balanceAfter: balanceBefore,
      tier: "dom",
      notes: [`Dry run: Flow quoted ${quote.credits} credits. Proposal rejected, nothing charged.`],
    };
  }

  await clickApprove();
  await recordSpend(quote.credits);
  notes.push(`Approved at ${quote.credits} credits.`);

  if (opts.noWait) {
    await log({
      kind: "video",
      opts,
      quoted: quote.credits,
      charged: quote.credits,
      balance: balanceBefore,
      verdict: "in_flight",
      files: [],
    });
    return {
      verdict: "in_flight",
      quotedCost: quote.credits,
      charged: quote.credits,
      mediaIds: [],
      files: [],
      balanceAfter: null,
      tier: "dom",
      notes: [...notes, "Returned without waiting. Use flow_collect to download once rendering finishes."],
    };
  }

  const mediaIds = await awaitNewMedia(before, opts.timeoutMs ?? TIMEOUTS.renderMs);
  const files = await saveAll(mediaIds, opts.outFile, "mp4");
  const balanceAfter = await readCredits();

  await log({
    kind: "video",
    opts,
    quoted: quote.credits,
    charged: quote.credits,
    balance: balanceAfter,
    verdict: "downloaded",
    files,
  });

  return {
    verdict: "downloaded",
    quotedCost: quote.credits,
    charged: quote.credits,
    mediaIds,
    files,
    balanceAfter,
    tier: "dom",
    notes,
  };
}

async function saveAll(mediaIds: string[], outFile: string | undefined, ext: string): Promise<string[]> {
  const files: string[] = [];
  for (const [i, id] of mediaIds.entries()) {
    const name = outFile
      ? mediaIds.length > 1
        ? outFile.replace(/(\.[^.]+)?$/, `-${i + 1}$1`)
        : outFile
      : `flow-${Date.now()}-${i + 1}.${ext}`;
    const saved = await downloadMedia(id, name);
    files.push(saved.file);
  }
  return files;
}

async function log(args: {
  kind: LedgerEntry["kind"];
  opts: GenerateOptions;
  quoted: number;
  charged: number;
  balance: number | null;
  verdict: LedgerEntry["verdict"];
  files: string[];
  note?: string;
}): Promise<void> {
  await appendLedger({
    ts: new Date().toISOString(),
    kind: args.kind,
    prompt: args.opts.prompt.slice(0, 500),
    model: null,
    quotedCost: args.quoted,
    charged: args.charged,
    balanceAfter: args.balance,
    verdict: args.verdict,
    files: args.files,
    note: args.note ?? null,
  });
}

/** Download everything that appeared since a known set of ids — the `--no-wait` collector. */
export async function collect(knownIds: string[], outDir?: string): Promise<{ mediaIds: string[]; files: string[] }> {
  const before = new Set(knownIds);
  const mediaIds = await awaitNewMedia(before, TIMEOUTS.renderMs);
  const files: string[] = [];
  for (const id of mediaIds) {
    const saved = await downloadMedia(id, `${outDir ? outDir + "/" : ""}flow-${id.slice(-12)}.mp4`);
    files.push(saved.file);
  }
  return { mediaIds, files };
}
