#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { config } from "./config.js";
import { ABSOLUTE_COST_CEILING, CREDIT_COSTS, RETRY_BUDGET_MULTIPLIER } from "./constants.js";
import { listApps, openApp } from "./services/apps.js";
import { closeBrowser } from "./services/browser.js";
import {
  assignFrame,
  clearAttachments,
  clearFrames,
  readSettings,
  setFlowMode,
  setSetting,
  swapFrames,
  trigger1080pUpscaleLatest,
  uploadMedia,
  uploadToSlot,
  upscale,
} from "./services/compose.js";
import { discoverApi, formatReport, verifyHttpTier } from "./services/discovery.js";
import { collect, generate, getGenerationStatus } from "./services/generate.js";
import { deleteMedia, downloadMedia, getLatestMedia, listMedia } from "./services/media.js";
import { readBudget, readLedger, resetSpend, setCeiling } from "./services/ledger.js";
import { createProject, listProjects, openProject } from "./services/project.js";
import { addClipsToScene, createScene, exportScene } from "./services/scene.js";
import { describeSession, readSession } from "./services/session.js";
import { loadApiMap } from "./services/transport.js";
import { FlowError } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_DIR = path.resolve(here, "..", "references");

const server = new McpServer({ name: "google-flow-mcp-server", version: "0.1.0" });

/** Errors reach the agent as actionable text, never as a protocol failure. */
function ok(text: string, structured?: Record<string, unknown>) {
  return structured
    ? { content: [{ type: "text" as const, text }], structuredContent: structured }
    : { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown) {
  const message = err instanceof FlowError ? err.message : `Unexpected error: ${(err as Error).message}`;
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const responseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("markdown for reading, json for programmatic use");

// ---------------------------------------------------------------- session ---

server.registerTool(
  "flow_check_session",
  {
    title: "Check Flow session",
    description:
      "Report whether Google Flow is reachable and safe to spend credits in: browser attached, signed in, credit balance, active project, and — critically — whether Flow's 'Confirm before generating' gate is on. Call this first in any Flow session. Never charges.",
    inputSchema: { response_format: responseFormat },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ response_format }) => {
    try {
      const state = await readSession();
      return ok(response_format === "json" ? JSON.stringify(state, null, 2) : describeSession(state), { ...state });
    } catch (err) {
      return fail(err);
    }
  },
);

// -------------------------------------------------------------- discovery ---

server.registerTool(
  "flow_discover_api",
  {
    title: "Discover Flow's internal API",
    description:
      "Record which tRPC endpoints Flow's own frontend calls while the app is exercised, and write a reusable API map. Observation only — it submits nothing and charges nothing. Run this after any Flow redeploy, or when another tool reports a 404 on a procedure. Only endpoint shapes are stored; no prompts, media, or tokens.",
    inputSchema: {
      duration_seconds: z.number().int().min(10).max(600).default(60).describe("How long to observe traffic"),
      navigate: z.boolean().default(true).describe("Reload the page to replay app bootstrap traffic"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ duration_seconds, navigate }) => {
    try {
      const report = await discoverApi(duration_seconds * 1000, navigate);
      return ok(formatReport(report), { requestsSeen: report.requestsSeen, endpoints: report.endpoints.length });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_verify_http_tier",
  {
    title: "Promote endpoints to direct HTTP",
    description:
      "Test whether discovered read-only GET endpoints work from Node with the browser's cookies alone, so later calls can skip the page entirely (faster, parallelisable). Mutations are never tested, because replaying one could generate and charge.",
    inputSchema: {
      procedures: z.array(z.string()).min(1).max(20).describe("Procedure names from flow_discover_api"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ procedures }) => {
    try {
      const results = await verifyHttpTier(procedures);
      const lines = Object.entries(results).map(([p, okFlag]) => `${okFlag ? "PROMOTED" : "page-only"}  ${p}`);
      return ok(lines.join("\n"), { results });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_api_map",
  {
    title: "Read the learned API map",
    description:
      "Return the tRPC endpoints previously learned by flow_discover_api, with their input/output key shapes and transport tier.",
    inputSchema: { response_format: responseFormat },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ response_format }) => {
    try {
      const map = await loadApiMap();
      const endpoints = Object.values(map.endpoints);
      if (endpoints.length === 0) {
        return ok("No endpoints learned yet. Run flow_discover_api first.");
      }
      if (response_format === "json") return ok(JSON.stringify(map, null, 2), { count: endpoints.length });
      const lines = endpoints.map(
        (e) => `${e.method.padEnd(4)} ${e.procedure}${e.httpSafe ? "  [http-safe]" : ""}  (seen ${e.sampleCount}x)`,
      );
      return ok(`Learned ${endpoints.length} endpoints, last updated ${map.discoveredAt}:\n\n${lines.join("\n")}`, {
        count: endpoints.length,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------------- generation ---

server.registerTool(
  "flow_generate_still",
  {
    title: "Generate still images (free)",
    description:
      "Generate still images in Flow. Stills cost ZERO credits, so this is the sandbox where composition should be iterated until right — always compose in stills before spending anything on video. Downloads the results and returns local file paths.",
    inputSchema: {
      prompt: z.string().min(10).max(4000).describe("Full composition prompt: subject, setting, light, lens, grade"),
      out_file: z.string().optional().describe("Output filename; relative paths resolve under FLOW_OUTPUT_DIR"),
      timeout_seconds: z.number().int().min(30).max(600).default(180),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ prompt, out_file, timeout_seconds }) => {
    try {
      const result = await generate({
        prompt,
        expectedMaxCost: 0,
        free: true,
        outFile: out_file,
        timeoutMs: timeout_seconds * 1000,
      });
      return ok(`Generated ${result.files.length} still(s) at zero cost:\n${result.files.join("\n")}`, {
        files: result.files,
        mediaIds: result.mediaIds,
        charged: 0,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_estimate_cost",
  {
    title: "Price a generation without paying",
    description:
      "Submit a request to Flow, read the quoted credit cost from its proposal, then REJECT it. Costs exactly zero — a rejected proposal is never charged. Use this to confirm the project's model tier before committing to a batch.",
    inputSchema: {
      prompt: z.string().min(10).max(4000).describe("The prompt you intend to run"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ prompt }) => {
    try {
      const result = await generate({ prompt, expectedMaxCost: ABSOLUTE_COST_CEILING, dryRun: true });
      return ok(
        `Flow quoted ${result.quotedCost} credits. Proposal rejected — nothing charged.\n` +
          `Reference: Veo 3.1 Lite 10, Fast 20, Quality 100. A quote far above the intended tier means the project settings are wrong.`,
        { quotedCost: result.quotedCost, charged: 0 },
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_generate_video",
  {
    title: "Generate video (SPENDS CREDITS)",
    description:
      "Generate a video clip in Flow. THIS SPENDS REAL CREDITS. The cost quoted by Flow is read and checked against expected_max_cost and the run budget BEFORE approval; if it exceeds either, the proposal is rejected and nothing is charged. The generation MODE is set by what you attach: start_frame_media_id gives Frames-to-Video (preserves the approved composition — the normal path), reference_media_ids gives Ingredients-to-Video (recomposes from up to 3 references), and attaching nothing gives Text-to-Video (least control). Compose in free stills first and animate an approved still rather than generating blind. Never call this twice for the same clip while one is in flight — a resubmit is a second charge. Model tier and aspect ratio are per-project settings; set them with flow_settings, not here.",
    inputSchema: {
      prompt: z
        .string()
        .min(10)
        .max(4000)
        .describe(
          "Motion prompt. With a start frame, describe ONLY movement, camera and ambient sound — the frame owns the composition",
        ),
      expected_max_cost: z
        .number()
        .int()
        .min(1)
        .max(ABSOLUTE_COST_CEILING)
        .describe("Reject the proposal if Flow quotes more than this. Veo 3.1 Fast is 20, Lite is 10"),
      start_frame_media_id: z
        .string()
        .optional()
        .describe("Library media id to use as the start frame (Frames-to-Video)"),
      end_frame_media_id: z.string().optional().describe("Optional end frame, for an interpolation target"),
      reference_media_ids: z
        .array(z.string())
        .max(3)
        .optional()
        .describe("Up to 3 reference images for Ingredients-to-Video. Recomposes the shot rather than preserving it"),
      out_file: z.string().optional().describe("Output filename; relative paths resolve under FLOW_OUTPUT_DIR"),
      no_wait: z
        .boolean()
        .default(false)
        .describe("Approve and return immediately, for parallel batches. Collect later with flow_collect"),
      timeout_seconds: z.number().int().min(60).max(900).default(480),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({
    prompt,
    expected_max_cost,
    start_frame_media_id,
    end_frame_media_id,
    reference_media_ids,
    out_file,
    no_wait,
    timeout_seconds,
  }) => {
    try {
      const result = await generate({
        prompt,
        expectedMaxCost: expected_max_cost,
        startFrameMediaId: start_frame_media_id,
        endFrameMediaId: end_frame_media_id,
        referenceMediaIds: reference_media_ids,
        outFile: out_file,
        noWait: no_wait,
        timeoutMs: timeout_seconds * 1000,
      });
      const summary =
        result.verdict === "in_flight"
          ? `Approved at ${result.charged} credits and returned without waiting. Use flow_collect to download.`
          : `Charged ${result.charged} credits. Saved:\n${result.files.join("\n")}\nBalance after: ${result.balanceAfter ?? "unknown"}`;
      return ok(`${summary}\n\n${result.notes.join("\n")}`, {
        verdict: result.verdict,
        quotedCost: result.quotedCost,
        charged: result.charged,
        files: result.files,
        mediaIds: result.mediaIds,
        balanceAfter: result.balanceAfter,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_generate_loop",
  {
    title: "Generate boundary-locked motion loop (M1 -> M1)",
    description:
      "Generate a mathematically seamless boundary-locked loop video in Veo 3.1. Clamps the exact same frame image to BOTH the Start and End frame slots. Automatically appends ambient room tone to prevent Veo audio synthesis failure, submits at 5 credits, and automatically upscales to 1080p for free if auto_upscale=true.",
    inputSchema: {
      prompt: z
        .string()
        .min(10)
        .max(4000)
        .describe("Kinematic motion prompt describing movement while locked to starting pose"),
      frame_path: z.string().optional().describe("Local image path to lock as Start and End boundary"),
      frame_media_id: z.string().optional().describe("Library media ID or name to lock as Start and End boundary"),
      expected_max_cost: z.number().int().min(1).max(ABSOLUTE_COST_CEILING).default(5).describe("Veo 3.1 Lite is 5 credits"),
      dry_run: z.boolean().default(false).describe("Quote the price and verify slots/readiness, but do not charge or submit"),
      auto_upscale: z.boolean().default(true).describe("Automatically trigger free 1080p cloud upscale upon render completion"),
      out_file: z.string().optional().describe("Output filename under FLOW_OUTPUT_DIR"),
      timeout_seconds: z.number().int().min(60).max(900).default(480),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ prompt, frame_path, frame_media_id, expected_max_cost, dry_run, auto_upscale, out_file, timeout_seconds }) => {
    try {
      const result = await generate({
        prompt,
        expectedMaxCost: expected_max_cost,
        dryRun: dry_run,
        startFramePath: frame_path,
        endFramePath: frame_path,
        startFrameMediaId: frame_media_id,
        endFrameMediaId: frame_media_id,
        autoUpscale: auto_upscale,
        outFile: out_file,
        timeoutMs: timeout_seconds * 1000,
      });
      return ok(
        `Generated boundary-locked loop (${result.charged} credits):\n${result.files.join("\n")}\n\n${result.notes.join("\n")}`,
        { ...result },
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_generate_transition",
  {
    title: "Generate First-Last Frame kinematic transition (M1 -> M2)",
    description:
      "Generate a kinematic transition between two distinct poses in Veo 3.1. Slots start_frame into Start chip and end_frame into End chip. Automatically appends ambient room tone to prevent Veo audio errors, executes at 5 credits, and upscales to 1080p if auto_upscale=true.",
    inputSchema: {
      prompt: z
        .string()
        .min(10)
        .max(4000)
        .describe("Kinematic transition prompt describing motion trajectory from Start to End pose"),
      start_frame_path: z.string().optional().describe("Local image path for Start pose"),
      start_frame_media_id: z.string().optional().describe("Library media ID for Start pose"),
      end_frame_path: z.string().optional().describe("Local image path for End pose"),
      end_frame_media_id: z.string().optional().describe("Library media ID for End pose"),
      expected_max_cost: z.number().int().min(1).max(ABSOLUTE_COST_CEILING).default(5),
      dry_run: z.boolean().default(false).describe("Quote the price and verify slots/readiness, but do not charge or submit"),
      auto_upscale: z.boolean().default(true).describe("Automatically trigger free 1080p cloud upscale"),
      out_file: z.string().optional().describe("Output filename under FLOW_OUTPUT_DIR"),
      timeout_seconds: z.number().int().min(60).max(900).default(480),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({
    prompt,
    start_frame_path,
    start_frame_media_id,
    end_frame_path,
    end_frame_media_id,
    expected_max_cost,
    dry_run,
    auto_upscale,
    out_file,
    timeout_seconds,
  }) => {
    try {
      const result = await generate({
        prompt,
        expectedMaxCost: expected_max_cost,
        dryRun: dry_run,
        startFramePath: start_frame_path,
        startFrameMediaId: start_frame_media_id,
        endFramePath: end_frame_path,
        endFrameMediaId: end_frame_media_id,
        autoUpscale: auto_upscale,
        outFile: out_file,
        timeoutMs: timeout_seconds * 1000,
      });
      return ok(
        `Generated transition (${result.charged} credits):\n${result.files.join("\n")}\n\n${result.notes.join("\n")}`,
        { ...result },
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_set_mode",
  {
    title: "Set Flow generation mode",
    description: "Toggle prompt box mode between VIDEO_FRAMES (Start/End frame chips) and TEXT_TO_VIDEO.",
    inputSchema: {
      mode: z.enum(["VIDEO_FRAMES", "TEXT_TO_VIDEO"]).describe("Target prompt box mode"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ mode }) => {
    try {
      await setFlowMode(mode);
      return ok(`Set Flow prompt box mode to ${mode}.`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_upload_frame",
  {
    title: "Upload local image to frame slot",
    description: "Upload a local image file directly to the Start or End frame slot in Google Flow.",
    inputSchema: {
      slot: z.enum(["start", "end"]).describe("Target frame slot"),
      file_path: z.string().describe("Local path to the image file"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ slot, file_path }) => {
    try {
      const success = await uploadToSlot(slot, file_path);
      return ok(success ? `Successfully uploaded ${file_path} to ${slot} slot.` : `Failed to upload to ${slot} slot.`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_assign_frame",
  {
    title: "Assign library asset to frame slot",
    description: "Assign an existing asset from the project library to the Start or End frame slot by name or media ID.",
    inputSchema: {
      slot: z.enum(["start", "end"]).describe("Target frame slot"),
      asset_name_or_id: z.string().describe("Name or media ID of the asset in the project library"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ slot, asset_name_or_id }) => {
    try {
      const success = await assignFrame(slot, asset_name_or_id);
      return ok(
        success
          ? `Successfully assigned ${asset_name_or_id} to ${slot} slot.`
          : `Asset ${asset_name_or_id} not found in library.`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_swap_frames",
  {
    title: "Swap first and last frames",
    description: "Swap the Start and End frames in the Flow prompt box.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async () => {
    try {
      const swapped = await swapFrames();
      return ok(swapped ? "Swapped first and last frames." : "Could not find swap button.");
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_clear_frames",
  {
    title: "Clear frame slots",
    description: "Clear Start, End, or both frame slots in the Flow prompt box.",
    inputSchema: {
      slot: z.enum(["start", "end", "both"]).default("both").describe("Which slot to clear"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ slot }) => {
    try {
      const count = await clearFrames(slot);
      return ok(`Cleared ${count} frame chip(s).`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_get_generation_status",
  {
    title: "Get live generation status",
    description:
      "Check if generations are actively running in Flow, view progress percentage, or inspect any immediate error alerts.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const status = await getGenerationStatus();
      return ok(JSON.stringify(status, null, 2), status as any);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_get_latest_video",
  {
    title: "Get latest project video",
    description:
      "Fetch metadata, media ID, signed CDN URL, and thumbnail for the most recent video in the active Flow project.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const item = await getLatestMedia("video");
      if (!item) return ok("No videos found in the current project library.");
      return ok(
        `Latest video: ${item.mediaId}\nName: ${item.name ?? "unnamed"}\nCDN URL: ${item.thumbnailUrl}`,
        item as any,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_upscale_latest",
  {
    title: "Upscale latest project video to 1080p",
    description:
      "Trigger Google Flow's free cloud 1080p upscale on the newest video in the active project and download the result.",
    inputSchema: {
      timeout_seconds: z.number().int().min(30).max(300).default(90),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ timeout_seconds }) => {
    try {
      const result = await trigger1080pUpscaleLatest(timeout_seconds * 1000);
      return ok(result.note, result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_collect",
  {
    title: "Collect clips submitted with no_wait",
    description:
      "Wait for media that is not in the supplied known_media_ids list to appear in the project library, then download it. Use after submitting a parallel batch with flow_generate_video(no_wait=true). Charges nothing — the credits were already committed at approval.",
    inputSchema: {
      known_media_ids: z.array(z.string()).describe("Media ids that existed BEFORE the batch was submitted"),
      out_dir: z.string().optional().describe("Subdirectory under FLOW_OUTPUT_DIR"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ known_media_ids, out_dir }) => {
    try {
      const result = await collect(known_media_ids, out_dir);
      return ok(`Collected ${result.files.length} file(s):\n${result.files.join("\n")}`, result);
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------------------ media ---

server.registerTool(
  "flow_list_media",
  {
    title: "List project library media",
    description:
      "List media in the currently open Flow project, with ids usable by flow_download and flow_delete_media. Never charges.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      response_format: responseFormat,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ limit, offset, response_format }) => {
    try {
      const { items, total } = await listMedia(limit, offset);
      const payload = {
        total,
        count: items.length,
        offset,
        items,
        has_more: offset + items.length < total,
        next_offset: offset + items.length,
      };
      if (response_format === "json") return ok(JSON.stringify(payload, null, 2), payload);
      const lines = items.map((i) => `${i.kind.padEnd(6)} ${i.mediaId}${i.name ? `  (${i.name})` : ""}`);
      return ok(`${total} item(s), showing ${items.length} from offset ${offset}:\n\n${lines.join("\n")}`, payload);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_download",
  {
    title: "Download media to disk",
    description:
      "Resolve a Flow media id to its signed CDN url and write the bytes to disk, verifying the file is genuinely image or video data. Use this rather than Flow's Download button, which frequently writes nothing in an automated profile. Never charges.",
    inputSchema: {
      media_id: z.string().min(4).describe("Media id from flow_list_media"),
      out_file: z.string().describe("Output filename; relative paths resolve under FLOW_OUTPUT_DIR"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ media_id, out_file }) => {
    try {
      const saved = await downloadMedia(media_id, out_file);
      return ok(`Saved ${saved.kind} (${saved.bytes.toLocaleString()} bytes) to ${saved.file}`, saved);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_delete_media",
  {
    title: "Delete media from the project library",
    description:
      "Permanently remove media from the Flow project library. Deletion cannot be undone and a deleted clip cannot be reliably re-added to a scene, so only delete what has been explicitly ruled out.",
    inputSchema: {
      media_ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Exact ids to delete. There is deliberately no delete-all"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ media_ids }) => {
    try {
      const result = await deleteMedia(media_ids);
      return ok(
        `Deleted ${result.deleted.length}; failed ${result.failed.length}${result.failed.length ? `: ${result.failed.join(", ")}` : ""}`,
        result,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------------------ scene ---

server.registerTool(
  "flow_export_scene",
  {
    title: "Export the open Scenebuilder scene",
    description:
      "Export the currently open Scenebuilder scene to an MP4 on disk. Stitching clips is FREE — only Scenebuilder's 'Extend' costs credits, and this tool never uses it. Captures the export job's video payload directly, since Flow's export never writes a file itself.",
    inputSchema: {
      out_file: z.string().describe("Output .mp4 path; relative paths resolve under FLOW_OUTPUT_DIR"),
      timeout_seconds: z.number().int().min(30).max(900).default(300),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ out_file, timeout_seconds }) => {
    try {
      const saved = await exportScene(out_file, timeout_seconds * 1000);
      return ok(
        `Exported scene (${saved.bytes.toLocaleString()} bytes) to ${saved.file}. Stitching is free; nothing charged.`,
        saved,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

// ----------------------------------------------------------------- budget ---

server.registerTool(
  "flow_budget",
  {
    title: "Read or set the credit budget",
    description:
      "Read the run's credit ceiling and spend, or change them. The ceiling is enforced before every approval: a generation that would exceed it is rejected and never charged. Raise it only on explicit instruction from whoever owns the account.",
    inputSchema: {
      action: z.enum(["get", "set_ceiling", "reset_spend"]).default("get"),
      ceiling: z
        .number()
        .int()
        .min(0)
        .nullable()
        .optional()
        .describe("New ceiling in credits; null removes it. Only for set_ceiling"),
      response_format: responseFormat,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ action, ceiling, response_format }) => {
    try {
      let budget = await readBudget();
      if (action === "set_ceiling") budget = await setCeiling(ceiling ?? null);
      if (action === "reset_spend") budget = await resetSpend();

      if (response_format === "json") return ok(JSON.stringify(budget, null, 2), { ...budget });
      const remaining = budget.ceiling === null ? "unlimited" : `${budget.ceiling - budget.spent}`;
      return ok(
        `Ceiling: ${budget.ceiling ?? "none"}\nSpent this run: ${budget.spent}\nRemaining: ${remaining}\nSince: ${budget.startedAt}\n\n` +
          `Planning reference — budget ${RETRY_BUDGET_MULTIPLIER} takes per needed clip (Veo first-try acceptance is roughly 70%). ` +
          `Veo 3.1 Lite ${CREDIT_COSTS["veo-3.1-lite"]} cr, Fast ${CREDIT_COSTS["veo-3.1-fast"]} cr, Quality ${CREDIT_COSTS["veo-3.1-quality"]} cr.`,
        { ...budget },
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_ledger",
  {
    title: "Read the spend ledger",
    description:
      "Return the append-only log of every generation this server attempted: prompt, quoted cost, actual charge, verdict, and files. The audit trail for credit spend.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(25),
      response_format: responseFormat,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ limit, response_format }) => {
    try {
      const entries = await readLedger(limit);
      if (entries.length === 0) return ok("Ledger is empty — no generations recorded yet.");
      if (response_format === "json") return ok(JSON.stringify(entries, null, 2), { count: entries.length });
      const totalCharged = entries.reduce((sum, e) => sum + e.charged, 0);
      const lines = entries.map(
        (e) =>
          `${e.ts.slice(0, 19)}  ${e.kind.padEnd(6)} ${String(e.charged).padStart(3)} cr  ${e.verdict.padEnd(11)} ${e.prompt?.slice(0, 60) ?? ""}`,
      );
      return ok(`Last ${entries.length} entries (${totalCharged} credits charged):\n\n${lines.join("\n")}`, {
        count: entries.length,
        totalCharged,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// --------------------------------------------------- settings & composer ---

server.registerTool(
  "flow_settings",
  {
    title: "Read or change project generation settings",
    description:
      "Read or change Flow's per-PROJECT generation settings: model tier, aspect ratio, and outputs per prompt. These are project globals, not per-generation arguments — set once, they persist across chat turns. Changing the tier is free and is the highest-leverage cost control there is: moving a project from Veo Quality to Fast turns every subsequent clip from 100 credits into 20. Re-read this after switching projects.",
    inputSchema: {
      action: z.enum(["get", "set"]).default("get"),
      model: z.string().optional().describe('Exact option label, e.g. "Veo 3.1 Fast". Only for action=set'),
      aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional().describe("Only for action=set"),
      outputs_per_prompt: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe("Keep at 1 — outputs multiply cost linearly"),
      duration_seconds: z
        .number()
        .int()
        .min(4)
        .max(10)
        .optional()
        .describe("Clip length. A cost lever on Gemini Omni Flash, which charges 15/20/25/30 credits by duration"),
      response_format: responseFormat,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ action, model, aspect_ratio, outputs_per_prompt, duration_seconds, response_format }) => {
    try {
      let settings = await readSettings();
      if (action === "set") {
        if (model) settings = await setSetting("model", model);
        if (aspect_ratio) settings = await setSetting("aspectRatio", aspect_ratio);
        if (outputs_per_prompt) settings = await setSetting("outputsPerPrompt", String(outputs_per_prompt));
        if (duration_seconds) settings = await setSetting("durationSeconds", `${duration_seconds}s`);
      }
      if (response_format === "json") return ok(JSON.stringify(settings, null, 2), { ...settings });
      return ok(
        `Model: ${settings.model ?? "unknown"}\nAspect: ${settings.aspectRatio ?? "unknown"}\n` +
          `Outputs per prompt: ${settings.outputsPerPrompt ?? "unknown"}\nDuration: ${settings.durationSeconds ?? "unknown"}s\n` +
          `Confirm gate: ${settings.confirmGate}\n\n` +
          `Costs: Lite 10 cr, Fast 20 cr, Quality 100 cr. Outputs multiply cost linearly — keep this at 1 unless told otherwise.`,
        { ...settings },
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_upload_media",
  {
    title: "Upload a local image into Flow",
    description:
      "Upload a local image file into the Flow project so it can be used as a start frame or reference. Free. After upload, confirm the resulting media id with flow_list_media before animating it.",
    inputSchema: { file_path: z.string().describe("Absolute path to a local image file") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ file_path }) => {
    try {
      const result = await uploadMedia(file_path);
      return ok(`Uploaded ${result.file}.\n${result.note}`, { ...result });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_upscale",
  {
    title: "Upscale a clip",
    description:
      "Upscale a generated clip. 1080p is FREE on paid plans and should always be taken at download. 4K costs 50 credits, is Ultra-plan only, and is rarely worth it for social content. NOTE: Flow does not show an approval card for upscales, so a 4K upscale bypasses the quote gate — it is charged directly and verified against the balance afterwards.",
    inputSchema: {
      media_id: z.string().describe("Media id from flow_list_media"),
      target: z.enum(["1080p", "4k"]).default("1080p"),
      acknowledge_4k_cost: z
        .boolean()
        .default(false)
        .describe("Required to be true for target=4k, which costs 50 credits unquoted"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ media_id, target, acknowledge_4k_cost }) => {
    try {
      if (target === "4k" && !acknowledge_4k_cost) {
        return fail(
          new FlowError(
            "Refusing a 4K upscale without acknowledge_4k_cost=true.",
            "4K costs 50 credits and Flow does not quote it in an approval card, so the usual gate cannot protect you. Take the free 1080p upscale unless someone explicitly authorised the spend.",
          ),
        );
      }
      const result = await upscale(media_id, target);
      return ok(result.note, { ...result });
    } catch (err) {
      return fail(err);
    }
  },
);

// --------------------------------------------------------------- projects ---

server.registerTool(
  "flow_list_projects",
  {
    title: "List Flow projects",
    description:
      "List Flow projects visible on the current page, with their ids. Free. Settings and media libraries are per-project, so knowing the id matters.",
    inputSchema: { response_format: responseFormat },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ response_format }) => {
    try {
      const projects = await listProjects();
      if (projects.length === 0)
        return ok("No project links visible. Navigate to labs.google/fx/tools/flow in the attached browser.");
      if (response_format === "json") return ok(JSON.stringify(projects, null, 2), { count: projects.length });
      return ok(projects.map((p) => `${p.projectId}  ${p.name ?? "(unnamed)"}`).join("\n"), { count: projects.length });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_open_project",
  {
    title: "Open a Flow project",
    description:
      "Switch the browser to a Flow project by id. Free. Settings are per-project, so re-read flow_settings after switching rather than assuming the model tier carried over.",
    inputSchema: { project_id: z.string().describe("Project id from flow_list_projects") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ project_id }) => {
    try {
      const project = await openProject(project_id);
      return ok(`Opened project ${project.projectId}. Re-read flow_settings — model tier and aspect are per-project.`, {
        ...project,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_create_project",
  {
    title: "Create a Flow project",
    description:
      "Create a new Flow project. Free. Worth doing per batch: Flow's chat anchors hard on people and settings from earlier images in the same project chat, and a fresh project is the cleanest way to break that carry-over.",
    inputSchema: { name: z.string().optional().describe("Optional project name") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ name }) => {
    try {
      const project = await createProject(name);
      return ok(`Created project ${project.projectId}${name ? ` ("${name}")` : ""}.`, { ...project });
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------- scene assembly ---

server.registerTool(
  "flow_create_scene",
  {
    title: "Create a Scenebuilder scene",
    description:
      "Create a new Scenebuilder scene for stitching clips. FREE. Flow's chat agent cannot do this — it is a UI-only surface.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async () => {
    try {
      const scene = await createScene();
      return ok(
        `Created scene ${scene.sceneId}. Add clips with flow_add_clips_to_scene, then export with flow_export_scene. Stitching is free.`,
        { ...scene },
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_add_clips_to_scene",
  {
    title: "Add clips to the open scene",
    description:
      "Add library clips, in order, to the currently open Scenebuilder scene. FREE — stitching costs nothing. This never touches Scenebuilder's 'Extend', which does cost 40 credits.",
    inputSchema: {
      media_ids: z.array(z.string()).min(1).max(30).describe("Clip media ids, in the order they should appear"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ media_ids }) => {
    try {
      const result = await addClipsToScene(media_ids);
      const text = `Added ${result.added.length} clip(s)${result.failed.length ? `; failed: ${result.failed.join(", ")}` : ""}. Nothing charged.`;
      return ok(text, { ...result });
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------- tools marketplace ---

server.registerTool(
  "flow_list_apps",
  {
    title: "List Flow's Tools marketplace apps",
    description:
      "List the mini-apps in the current project's Tools gallery (Type Overlays, Transition Machine, Stringout Creator, Video Resizer, Shader Effects, Image Editor, Mask Magic, Storyboard Studio, and any custom tools). Listing is free. WARNING: the gallery quotes no prices and some apps call Veo internally, so running one can charge an unquoted amount.",
    inputSchema: { response_format: responseFormat },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ response_format }) => {
    try {
      const apps = await listApps();
      if (apps.length === 0) return ok("No apps detected. Open a project and navigate to its Tools tab.");
      if (response_format === "json") return ok(JSON.stringify(apps, null, 2), { count: apps.length });
      const lines = apps.map((a) => `${a.name}${a.description ? ` — ${a.description.slice(0, 80)}` : ""}`);
      return ok(
        `${apps.length} app(s):\n${lines.join("\n")}\n\nNone of these quote a cost. Prefer local ffmpeg for concatenation and resizing; reserve Flow apps for things you cannot reproduce locally.`,
        { count: apps.length },
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "flow_open_app",
  {
    title: "Open a Flow Tools app",
    description:
      "Open one of Flow's Tools-gallery apps and hand control back to a human. Requires acknowledge_unknown_cost=true because the gallery quotes no prices and some apps call Veo internally. This deliberately does NOT drive the app's own form — each app has a bespoke UI, and blind-clicking through an unknown form that may call Veo is how an unbounded charge happens. Credit balance is measured before and after.",
    inputSchema: {
      app_name: z.string().describe("App name from flow_list_apps"),
      acknowledge_unknown_cost: z
        .boolean()
        .default(false)
        .describe("Must be true — the cost of any Flow app is unquoted and unknown"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ app_name, acknowledge_unknown_cost }) => {
    try {
      const result = await openApp(app_name, acknowledge_unknown_cost);
      const spend = result.measuredSpend === null ? "unknown" : `${result.measuredSpend}`;
      return ok(
        `${result.note}\n\nBalance before: ${result.balanceBefore ?? "unknown"}, after opening: ${result.balanceAfter ?? "unknown"} (delta ${spend}).`,
        {
          ...result,
        },
      );
    } catch (err) {
      return fail(err);
    }
  },
);

// -------------------------------------------------------------- resources ---

const REFERENCES: { file: string; name: string; description: string }[] = [
  { file: "economics.md", name: "flow-economics", description: "Credit cost table and budget planning template" },
  {
    file: "prompting.md",
    name: "flow-prompting",
    description: "How to prompt Veo: the stills-first two-prompt split and failure countermeasures",
  },
  {
    file: "ui-playbook.md",
    name: "flow-ui-playbook",
    description: "Verified click paths, quirks, and workarounds for Flow's UI",
  },
];

for (const ref of REFERENCES) {
  server.registerResource(
    ref.name,
    `flow://reference/${ref.file}`,
    { title: ref.name, description: ref.description, mimeType: "text/markdown" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: await fs
            .readFile(path.join(REFERENCE_DIR, ref.file), "utf8")
            .catch(() => `Reference ${ref.file} not found.`),
        },
      ],
    }),
  );
}

// ------------------------------------------------------------------- boot ---

async function main(): Promise<void> {
  await fs.mkdir(config.stateDir, { recursive: true });
  await fs.mkdir(config.outputDir, { recursive: true });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport owns stdout; all logging must go to stderr.
  process.stderr.write(`google-flow-mcp-server ready (state: ${config.stateDir}, output: ${config.outputDir})\n`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await closeBrowser();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
