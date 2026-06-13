import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { extractAudio, getVideoDuration } from "../services/extractor";
import {
  AnalysisResult,
  ClassifiedSentence,
  ExtractedClaim,
  SearchEvidence,
  Verdict,
  PipelineStatus,
  TranscriptSegment,
} from "../types";

const router = Router();
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const PY = process.env.NLP_SERVICE_URL ?? "http://localhost:5001";

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Multer ────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "video/mp4" || file.originalname.endsWith(".mp4")) cb(null, true);
    else cb(new Error("Only MP4 files are accepted"));
  },
});

// ── In-memory stores ──────────────────────────────────────────────────────
const statusStore         = new Map<string, PipelineStatus>();
const resultStore         = new Map<string, AnalysisResult>();
const partialVerdictStore = new Map<string, Verdict[]>();
const claimCountStore     = new Map<string, number>();
const cancelStore         = new Map<string, AbortController>(); // cancel handle per pipeline

function updateStatus(videoId: string, status: PipelineStatus): void {
  statusStore.set(videoId, status);
  console.log(`[Pipeline:${videoId}] ${status.stage} — ${status.message}`);
}

/** Call this to abort a running pipeline. Safe to call even if none is running. */
function cancelPipeline(videoId: string): void {
  const ctrl = cancelStore.get(videoId);
  if (ctrl) {
    ctrl.abort();
    cancelStore.delete(videoId);
    console.log(`[Pipeline:${videoId}] Cancelled by user`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
// ROUTE: POST /api/analyze  (file upload)
// ═════════════════════════════════════════════════════════════════════════
router.post(
  "/analyze",
  upload.single("video"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No video file provided" });
      return;
    }
    const videoId   = uuidv4();
    const claimMode = (req.body.claimMode as string) === "facts_only" ? "facts_only" : "facts_and_opinions";
    const ctrl      = new AbortController();
    cancelStore.set(videoId, ctrl);
    updateStatus(videoId, { stage: "extracting", progress: 0, message: "Starting pipeline..." });
    res.json({ videoId });
    runPipeline(videoId, req.file.path, {}, claimMode, ctrl.signal).catch((err) => {
      if (err.name === "CanceledError" || err.code === "ERR_CANCELED" || ctrl.signal.aborted) {
        console.log(`[Pipeline:${videoId}] Stopped cleanly after cancel`);
        return;
      }
      console.error(`[Pipeline:${videoId}] Fatal:`, err.message);
      updateStatus(videoId, { stage: "error", progress: 0, message: err.message ?? "Unknown error" });
    }).finally(() => cancelStore.delete(videoId));
  }
);

// ═════════════════════════════════════════════════════════════════════════
// ROUTE: POST /api/analyze-url  (URL input)
// ═════════════════════════════════════════════════════════════════════════
router.post("/analyze-url", async (req: Request, res: Response) => {
  const { url, claimMode: rawMode } = req.body as { url?: string; claimMode?: string };
  if (!url?.trim()) {
    res.status(400).json({ error: "Missing 'url' in request body" });
    return;
  }
  try { new URL(url.trim()); }
  catch { res.status(400).json({ error: "Invalid URL format" }); return; }

  const videoId   = uuidv4();
  const claimMode = rawMode === "facts_only" ? "facts_only" : "facts_and_opinions";
  const ctrl      = new AbortController();
  cancelStore.set(videoId, ctrl);
  updateStatus(videoId, { stage: "downloading", progress: 2, message: "Fetching video from URL..." });
  res.json({ videoId });

  runUrlPipeline(videoId, url.trim(), claimMode, ctrl.signal).catch((err) => {
    if (err.name === "CanceledError" || err.code === "ERR_CANCELED" || ctrl.signal.aborted) {
      console.log(`[Pipeline:${videoId}] Stopped cleanly after cancel`);
      return;
    }
    console.error(`[Pipeline:${videoId}] Fatal:`, err.message);
    updateStatus(videoId, { stage: "error", progress: 0, message: err.message ?? "Unknown error" });
  }).finally(() => cancelStore.delete(videoId));
});

// ── GET /api/status/:videoId ──────────────────────────────────────────────
router.get("/status/:videoId", (req: Request, res: Response) => {
  const s = statusStore.get(req.params.videoId);
  if (!s) { res.status(404).json({ error: "Video ID not found" }); return; }
  res.json(s);
});

// ── GET /api/result/:videoId ──────────────────────────────────────────────
router.get("/result/:videoId", (req: Request, res: Response) => {
  const r = resultStore.get(req.params.videoId);
  if (!r) { res.status(404).json({ error: "Result not ready or not found" }); return; }
  res.json(r);
});

// ── GET /api/verdicts/:videoId ────────────────────────────────────────────
router.get("/verdicts/:videoId", (req: Request, res: Response) => {
  const verdicts    = partialVerdictStore.get(req.params.videoId) ?? [];
  const totalClaims = claimCountStore.get(req.params.videoId) ?? 0;
  const status      = statusStore.get(req.params.videoId);
  const done        = status?.stage === "done" || status?.stage === "error";
  res.json({ verdicts, totalClaims, done });
});

// ── POST /api/cancel/:videoId ─────────────────────────────────────────────
// Called by the frontend when the user clicks "New Analysis" while a pipeline
// is still running. Aborts every pending axios call and sleep in the pipeline.
router.post("/cancel/:videoId", (req: Request, res: Response) => {
  const { videoId } = req.params;
  cancelPipeline(videoId);
  // Mark it cancelled in the status store so any stray poll gets a clean signal
  const current = statusStore.get(videoId);
  if (current && current.stage !== "done" && current.stage !== "error") {
    updateStatus(videoId, { stage: "error", progress: 0, message: "Cancelled by user." });
  }
  res.json({ ok: true });
});


// ═════════════════════════════════════════════════════════════════════════
// URL PIPELINE
// ═════════════════════════════════════════════════════════════════════════
async function runUrlPipeline(videoId: string, url: string, claimMode: string, signal: AbortSignal): Promise<void> {
  let mp4Path: string | null = null;
  try {
    updateStatus(videoId, { stage: "downloading", progress: 5, message: "Downloading with yt-dlp..." });

    const dlResp = await axios.post<{
      mp4_path: string; title: string; duration: number; platform: string; error?: string;
    }>(`${PY}/download`, { url, video_id: videoId }, { timeout: 300_000, signal });

    if (dlResp.data.error) throw new Error(dlResp.data.error);

    mp4Path = dlResp.data.mp4_path;
    const { title, duration: dlDuration, platform } = dlResp.data;
    console.log(`[Pipeline:${videoId}] Downloaded: "${title}" (${dlDuration}s) from ${platform}`);

    updateStatus(videoId, {
      stage: "downloading", progress: 18,
      message: `Downloaded "${title}" from ${platform}. Starting analysis...`,
    });

    await runPipeline(videoId, mp4Path, { sourceUrl: url, sourceTitle: title, sourcePlatform: platform }, claimMode, signal);

  } catch (err) {
    if (mp4Path && fs.existsSync(mp4Path)) {
      try { fs.unlinkSync(mp4Path); } catch { /* non-fatal */ }
    }
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// SHARED PIPELINE ORCHESTRATOR
// ═════════════════════════════════════════════════════════════════════════
interface SourceMeta {
  sourceUrl?: string;
  sourceTitle?: string;
  sourcePlatform?: string;
}

async function runPipeline(
  videoId: string,
  mp4Path: string,
  sourceMeta: SourceMeta = {},
  claimMode: string = "facts_and_opinions",
  signal: AbortSignal = new AbortController().signal
): Promise<void> {

  // Helper: abortable sleep — rejects immediately if signal fires mid-wait
  const abortableSleep = (ms: number) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });

  // ── Stage 1: FFmpeg audio extraction ────────────────────────────────
  if (signal.aborted) return;
  updateStatus(videoId, { stage: "extracting", progress: 20, message: "Extracting audio from video..." });
  const duration = await getVideoDuration(mp4Path);
  const mp3Path  = await extractAudio(mp4Path, UPLOAD_DIR);

  // ── Stage 2: Transcribe (local Whisper) ─────────────────────────────
  if (signal.aborted) return;
  updateStatus(videoId, { stage: "transcribing", progress: 30, message: "Transcribing with local Whisper..." });
  const transcribeResp = await axios.post<{
    segments: TranscriptSegment[];
    language: string;
  }>(
    `${PY}/transcribe`,
    { mp3_path: mp3Path },
    { timeout: 600_000, signal }
  );
  const rawSegments: TranscriptSegment[] = transcribeResp.data.segments;

  // ── Stage 3: Classify sentences (spaCy + FLAIR + RE) ────────────────
  if (signal.aborted) return;
  updateStatus(videoId, { stage: "classifying", progress: 42, message: "Classifying facts vs. opinions..." });
  const classifyResp = await axios.post<{ results: ClassifiedSentence[] }>(
    `${PY}/classify`,
    { segments: rawSegments },
    { timeout: 120_000, signal }
  );
  const classifiedSentences: ClassifiedSentence[] = classifyResp.data.results;

  // ── Stage 4: Extract verifiable claims (spaCy dep parser) ────────────
  if (signal.aborted) return;
  updateStatus(videoId, { stage: "extracting_claims", progress: 53, message: "Extracting verifiable claims..." });
  const allSentences = classifiedSentences.filter(
    (s) => s.type === "fact" || s.type === "uncertain" || s.type === "opinion"
  );
  const claimResp = await axios.post<{ claims: ExtractedClaim[] }>(
    `${PY}/extract_claims`,
    { sentences: allSentences, claim_mode: claimMode },
    { timeout: 60_000, signal }
  );
  let claims: ExtractedClaim[] = claimResp.data.claims;

  // ── Stage 4.5: Context Resolution (fastcoref) ────────────────────────
  if (signal.aborted) return;
  updateStatus(videoId, {
    stage: "resolving_context",
    progress: 64,
    message: "Resolving references and building context windows...",
  });
  try {
    const ctxResp = await axios.post<{ enrichedClaims: ExtractedClaim[] }>(
      `${PY}/resolve_context`,
      { claims, segments: rawSegments },
      { timeout: 240_000, signal }
    );
    claims = ctxResp.data.enrichedClaims;
    console.log(`[Pipeline:${videoId}] Context resolved — ${claims.length} enriched claims`);
  } catch (err) {
    if ((err as any).name === "CanceledError" || (err as any).code === "ERR_CANCELED") throw err;
    console.warn(
      `[Pipeline:${videoId}] Context resolution failed, using raw claims:`,
      (err as Error).message
    );
  }

  // ── Release VRAM so Ollama gets the full 8 GB ─────────────────────────
  if (signal.aborted) return;
  try {
    const vramResp = await axios.post<{ freed_mb: number; cuda_available: boolean }>(
      `${PY}/release_vram`,
      {},
      { timeout: 10_000, signal }
    );
    if (vramResp.data.cuda_available) {
      console.log(`[Pipeline:${videoId}] VRAM released — ${vramResp.data.freed_mb} MB freed for Ollama`);
    }
  } catch (err) {
    if ((err as any).name === "CanceledError" || (err as any).code === "ERR_CANCELED") throw err;
    console.warn(`[Pipeline:${videoId}] VRAM release skipped`);
  }

  // ── Stage 5: Web Search (Serper / DuckDuckGo fallback) ───────────────
  // ── Stages 5 + 6: Web Search → Verdict (interleaved) ────────────────
  //
  // Previously: search ALL claims first (~6 min), then verify ALL (~9 min).
  // Now: search and verdict run as a producer-consumer pipeline.
  //
  //   Search worker  — fires SEARCH_CONCURRENCY requests concurrently,
  //                    rate-limited by SEARCH_DELAY_MS between each.
  //                    As each result arrives it is pushed into a queue.
  //
  //   Verdict worker — drains the queue one claim at a time (Ollama is
  //                    sequential). While Ollama is running on claim N,
  //                    the search worker is already fetching claim N+1.
  //
  // Net effect: the first verdict card appears on screen ~10 seconds after
  // this stage starts instead of ~15 minutes later.
  // ─────────────────────────────────────────────────────────────────────
  if (signal.aborted) return;

  // Transition status — single merged stage from the user's perspective
  updateStatus(videoId, {
    stage: "searching",
    progress: 72,
    message: `Searching and verifying ${claims.length} claims...`,
  });

  // Seed the partial store so /api/verdicts returns immediately
  partialVerdictStore.set(videoId, []);
  claimCountStore.set(videoId, claims.length);

  const verdicts: Verdict[] = [];
  let searchedCount  = 0;
  let verifiedCount  = 0;

  // Queue of { claim, evidence } pairs ready for Ollama
  const verdictQueue: Array<{ claim: ExtractedClaim; evidence: SearchEvidence[] }> = [];
  let searchDone     = false;   // set true when last claim is enqueued

  // ── Helper: run verdict for one claim ──────────────────────────────
  const runVerdict = async (claim: ExtractedClaim, evidence: SearchEvidence[]): Promise<Verdict> => {
    try {
      const r = await axios.post<{
        verdict: Verdict["verdict"];
        confidence: number;
        explanation: string;
        correctedFact?: string | null;
      }>(
        `${PY}/verdict`,
        { claim, evidence },
        { timeout: 180_000, signal }
      );
      return {
        claim,
        verdict:       r.data.verdict,
        confidence:    r.data.confidence,
        explanation:   r.data.explanation,
        evidence,
        correctedFact: r.data.correctedFact ?? undefined,
      } as Verdict;
    } catch (err) {
      if ((err as any).name === "CanceledError" || (err as any).code === "ERR_CANCELED") throw err;
      return {
        claim,
        verdict:     "UNVERIFIABLE" as const,
        confidence:  0,
        explanation: "Verdict service unavailable.",
        evidence,
      } as Verdict;
    }
  };

  // ── Verdict consumer — runs in its own async loop ──────────────────
  // Drains verdictQueue sequentially. While it is awaiting Ollama, the
  // search producer is already running in parallel filling the queue.
  const verdictWorker = (async () => {
    while (true) {
      if (signal.aborted) return;

      // If queue has an item, process it immediately
      if (verdictQueue.length > 0) {
        const { claim, evidence } = verdictQueue.shift()!;
        const verdict = await runVerdict(claim, evidence);
        verdicts.push(verdict);
        verifiedCount++;

        // Push to partial store so frontend shows the card right away
        partialVerdictStore.set(videoId, [...verdicts]);

        // Progress spans 72–100 across both search and verify
        const pct = Math.round(72 + (verifiedCount / claims.length) * 28);
        updateStatus(videoId, {
          stage: "verifying",
          progress: pct,
          message: `Searching & verifying... (${verifiedCount} / ${claims.length} complete)`,
        });

      } else if (searchDone) {
        // Queue empty and search finished — we're done
        break;
      } else {
        // Queue empty but search still running — yield for 200ms and check again
        await abortableSleep(200);
      }
    }
  })();

  // ── Search producer — runs concurrently with the verdict consumer ──
  // Sends one search request at a time (to respect Serper rate limits)
  // and pushes results straight onto the queue.
  const SEARCH_DELAY_MS = 1200; // ~50 req/min — well within Serper free tier

  for (let i = 0; i < claims.length; i++) {
    if (signal.aborted) { searchDone = true; break; }

    const claim = claims[i];
    let evidence: SearchEvidence[] = [];

    try {
      const r = await axios.post<{ evidence: SearchEvidence[] }>(
        `${PY}/search`,
        {
          claim:           claim.resolvedClaim ?? claim.structuredClaim,
          entities:        claim.entities ?? [],
          contextEntities: claim.contextEntities ?? [],
          enrichedQuery:   claim.enrichedQuery ?? "",
        },
        { timeout: 30_000, signal }
      );
      evidence = r.data.evidence ?? [];
    } catch (err) {
      if ((err as any).name === "CanceledError" || (err as any).code === "ERR_CANCELED") {
        searchDone = true;
        throw err;
      }
      // Search failed for this claim — push empty evidence so verdict still runs
      evidence = [];
    }

    searchedCount++;
    verdictQueue.push({ claim, evidence });

    // Update status to show search progress while verdict worker catches up
    const pct = Math.round(72 + (verifiedCount / claims.length) * 28);
    updateStatus(videoId, {
      stage: "searching",
      progress: pct,
      message: `Searching & verifying... (${verifiedCount} / ${claims.length} complete, ${searchedCount} searched)`,
    });

    // Rate-limit delay between search requests (skip after last claim)
    if (i < claims.length - 1) await abortableSleep(SEARCH_DELAY_MS);
  }

  searchDone = true;

  // Wait for the verdict worker to drain the remaining queue
  await verdictWorker;

  if (signal.aborted) return;

  // ── Build summary ─────────────────────────────────────────────────────
  if (signal.aborted) return;
  const summary = {
    totalSentences:     classifiedSentences.length,
    factCount:          classifiedSentences.filter((s) => s.type === "fact").length,
    opinionCount:       classifiedSentences.filter((s) => s.type === "opinion").length,
    trueCount:          verdicts.filter((v) => v.verdict === "TRUE").length,
    falseCount:         verdicts.filter((v) => v.verdict === "FALSE").length,
    unverifiableCount:  verdicts.filter((v) => v.verdict === "UNVERIFIABLE").length,
    partiallyTrueCount: verdicts.filter((v) => v.verdict === "PARTIALLY_TRUE").length,
  };

  const result: AnalysisResult = {
    videoId,
    duration,
    ...sourceMeta,
    transcript: rawSegments,
    classifiedSentences,
    claims,
    verdicts,
    summary,
  };

  resultStore.set(videoId, result);
  updateStatus(videoId, { stage: "done", progress: 100, message: "Analysis complete!" });

  partialVerdictStore.delete(videoId);
  claimCountStore.delete(videoId);

  try { fs.unlinkSync(mp4Path); fs.unlinkSync(mp3Path); } catch { /* non-fatal */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default router;