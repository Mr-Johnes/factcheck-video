import React, { useState, useEffect, useCallback, useRef } from "react";
import axios from "axios";
import VideoUploader, { ClaimMode } from "./components/VideoUploader";
import ClaimCard from "./components/ClaimCard";
import TranscriptView from "./components/TranscriptView";
import VerdictBadge from "./components/VerdictBadge";
import {
  AnalysisResult,
  PipelineStatus,
  PipelineStage,
  VerdictType,
  Verdict,
} from "./types";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const POLL_INTERVAL_MS = 2000;

// ── Stage metadata (now includes "downloading") ────────────────────────────
const STAGE_META: Record<PipelineStage, { label: string; icon: string; color: string }> = {
  downloading:      { label: "Downloading Video",    icon: "⬇️",  color: "#a78bfa" },
  extracting:       { label: "Extracting Audio",     icon: "🎵",  color: "#f59e0b" },
  transcribing:     { label: "Transcribing",         icon: "📝",  color: "#3b82f6" },
  classifying:      { label: "Classifying",          icon: "🔬",  color: "#8b5cf6" },
  extracting_claims:{ label: "Extracting Claims",    icon: "🧠",  color: "#06b6d4" },
  resolving_context:{ label: "Resolving Context",    icon: "🔗",  color: "#ec4899" },
  searching:        { label: "Searching Web",        icon: "🌐",  color: "#f97316" },
  verifying:        { label: "Synthesizing Verdicts",icon: "⚖️",  color: "#10b981" },
  done:             { label: "Complete",             icon: "✅",  color: "#4ade80" },
  error:            { label: "Error",                icon: "❌",  color: "#ef4444" },
};

// Ordered stages for the progress stepper (downloading is first when coming via URL)
const STAGE_ORDER_URL: PipelineStage[]  = ["downloading","extracting","transcribing","classifying","extracting_claims","resolving_context","searching","verifying","done"];
const STAGE_ORDER_FILE: PipelineStage[] = ["extracting","transcribing","classifying","extracting_claims","resolving_context","searching","verifying","done"];

// ── Small helper components ────────────────────────────────────────────────
function StatCard({ label, value, color, icon }: { label: string; value: number; color: string; icon: string }) {
  return (
    <div style={{ background: "#111", border: "1px solid #222", borderTop: `3px solid ${color}`, borderRadius: "8px", padding: "16px 20px", minWidth: "110px", flex: "1 1 110px" }}>
      <div style={{ fontSize: "22px", marginBottom: "4px" }}>{icon}</div>
      <div style={{ fontSize: "28px", fontWeight: 800, color, fontVariantNumeric: "tabular-nums", lineHeight: 1, marginBottom: "4px" }}>{value}</div>
      <div style={{ fontSize: "11px", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function ProgressBar({ progress, color }: { progress: number; color: string }) {
  return (
    <div style={{ width: "100%", height: "6px", background: "#1f1f1f", borderRadius: "3px", overflow: "hidden", marginTop: "12px" }}>
      <div style={{ width: `${progress}%`, height: "100%", background: color, borderRadius: "3px", transition: "width 0.5s ease", boxShadow: `0 0 8px ${color}88` }} />
    </div>
  );
}

function FilterButton({ label, count, active, onClick, color }: { label: string; count: number; active: boolean; onClick: () => void; color: string }) {
  return (
    <button onClick={onClick} style={{ padding: "6px 16px", borderRadius: "20px", border: `1px solid ${active ? color : "#333"}`, background: active ? `${color}22` : "#111", color: active ? color : "#6b7280", fontSize: "12px", fontWeight: 700, cursor: "pointer", letterSpacing: "0.06em", textTransform: "uppercase", transition: "all 0.15s", fontFamily: "inherit" }}>
      {label} ({count})
    </button>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
type AppView = "upload" | "processing" | "results";
type VerdictFilter = VerdictType | "ALL";

export default function App() {
  const [view, setView]               = useState<AppView>("upload");
  const [videoId, setVideoId]         = useState<string | null>(null);
  const [status, setStatus]           = useState<PipelineStatus | null>(null);
  const [result, setResult]           = useState<AnalysisResult | null>(null);
  const [partialVerdicts, setPartial] = useState<Verdict[]>([]);
  const [activeTab, setActiveTab]     = useState<"verdicts" | "transcript">("verdicts");
  const [verdictFilter, setVFilter]   = useState<VerdictFilter>("ALL");
  const [isUploading, setIsUploading] = useState(false);
  const [isUrlMode, setIsUrlMode]     = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Submit: file upload ──────────────────────────────────────────────
  const handleUploadFile = useCallback(async (file: File, mode: ClaimMode) => {
    setIsUploading(true);
    setIsUrlMode(false);
    setPartial([]);
    setResult(null);
    const formData = new FormData();
    formData.append("video", file);
    formData.append("claimMode", mode);
    try {
      const { data } = await axios.post<{ videoId: string }>(
        `${API_BASE}/api/analyze`,
        formData,
        { headers: { "Content-Type": "multipart/form-data" } }
      );
      setVideoId(data.videoId);
      setView("processing");
    } catch {
      alert("Upload failed. Is the backend running?");
    } finally {
      setIsUploading(false);
    }
  }, []);

  // ── Submit: URL ──────────────────────────────────────────────────────
  const handleSubmitUrl = useCallback(async (url: string, mode: ClaimMode) => {
    setIsUploading(true);
    setIsUrlMode(true);
    setPartial([]);
    setResult(null);
    try {
      const { data } = await axios.post<{ videoId: string }>(
        `${API_BASE}/api/analyze-url`,
        { url, claimMode: mode },
        { headers: { "Content-Type": "application/json" } }
      );
      setVideoId(data.videoId);
      setView("processing");
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : "Request failed";
      alert(`Failed to start URL analysis: ${msg}`);
    } finally {
      setIsUploading(false);
    }
  }, []);

  // ── Poll for status + partial verdicts ──────────────────────────────
  useEffect(() => {
    if (!videoId || (view !== "processing" && view !== "results")) return;

    const poll = async () => {
      try {
        const { data: s } = await axios.get<PipelineStatus>(`${API_BASE}/api/status/${videoId}`);
        setStatus(s);

        // During verdict synthesis — fetch partial verdicts and stream cards in
        if (s.stage === "verifying") {
          try {
            const { data: pv } = await axios.get<{
              verdicts: Verdict[];
              totalClaims: number;
              done: boolean;
            }>(`${API_BASE}/api/verdicts/${videoId}`);
            if (pv.verdicts.length > 0) {
              setPartial(pv.verdicts);
              setView("results");
            }
          } catch { /* non-fatal */ }
        }

        if (s.stage === "done") {
          clearInterval(pollRef.current!);
          const { data: r } = await axios.get<AnalysisResult>(`${API_BASE}/api/result/${videoId}`);
          setResult(r);
          setPartial([]);
          setView("results");
        } else if (s.stage === "error") {
          clearInterval(pollRef.current!);
        }
      } catch { /* ignore poll errors */ }
    };

    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [videoId]);

  // ── Derived display values ───────────────────────────────────────────
  const isStillVerifying = status?.stage === "verifying" && !result;
  const liveVerdicts     = result?.verdicts ?? partialVerdicts;

  const liveSummary = result?.summary ?? {
    totalSentences:     0,
    factCount:          0,
    opinionCount:       0,
    trueCount:          partialVerdicts.filter((v) => v.verdict === "TRUE").length,
    falseCount:         partialVerdicts.filter((v) => v.verdict === "FALSE").length,
    unverifiableCount:  partialVerdicts.filter((v) => v.verdict === "UNVERIFIABLE").length,
    partiallyTrueCount: partialVerdicts.filter((v) => v.verdict === "PARTIALLY_TRUE").length,
  };

  const filteredVerdicts = verdictFilter === "ALL"
    ? liveVerdicts
    : liveVerdicts.filter((v) => v.verdict === verdictFilter);

  const verifyingMatch = status?.message?.match(/\((\d+) \/ (\d+) complete\)/);
  const verifiedSoFar  = verifyingMatch ? parseInt(verifyingMatch[1]) : liveVerdicts.length;
  const verifyingTotal = verifyingMatch ? parseInt(verifyingMatch[2]) : liveVerdicts.length;

  const stageMeta  = status ? STAGE_META[status.stage] : null;
  const stageOrder = isUrlMode ? STAGE_ORDER_URL : STAGE_ORDER_FILE;

  // ════════════════════════════════════════════════════════════════════
  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#e0e0e0", fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif" }}>

      {/* ── Nav ── */}
      <header style={{ borderBottom: "1px solid #1a1a1a", padding: "0 40px", display: "flex", alignItems: "center", justifyContent: "space-between", height: "60px", position: "sticky", top: 0, background: "#080808", zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontSize: "20px" }}>🔍</span>
          <span style={{ fontWeight: 800, fontSize: "16px", letterSpacing: "-0.02em", color: "#f0f0f0" }}>
            FactCheck<span style={{ color: "#60a5fa" }}>Video</span>
          </span>
        </div>
        {(view === "processing" || view === "results") && (
          <button
            onClick={async () => {
              // Fire cancel at the backend — stops the pipeline immediately.
              // We do it fire-and-forget; UI resets regardless of response.
              if (videoId) {
                axios.post(`${API_BASE}/api/cancel/${videoId}`).catch(() => {});
              }
              if (pollRef.current) clearInterval(pollRef.current);
              setView("upload");
              setVideoId(null);
              setStatus(null);
              setResult(null);
              setPartial([]);
              setIsUrlMode(false);
            }}
            style={{ padding: "6px 16px", borderRadius: "6px", border: "1px solid #333", background: "#111", color: "#9ca3af", fontSize: "13px", cursor: "pointer", fontFamily: "inherit" }}>
            ← New Analysis
          </button>
        )}
      </header>

      {/* ════════════════ UPLOAD VIEW ════════════════ */}
      {view === "upload" && (
        <main style={{ maxWidth: "660px", margin: "70px auto", padding: "0 24px" }}>
          <div style={{ textAlign: "center", marginBottom: "40px" }}>
            <h1 style={{ fontSize: "40px", fontWeight: 900, letterSpacing: "-0.04em", color: "#f9fafb", marginBottom: "10px", lineHeight: 1.1 }}>
              Video Fact Checker
            </h1>
            <p style={{ color: "#6b7280", fontSize: "15px", lineHeight: 1.6 }}>
              Upload an MP4 or paste a link from YouTube, TikTok, Instagram and more.<br />
              We'll extract claims, verify them, and tell you what's true.
            </p>
          </div>

          <VideoUploader
            onUploadFile={handleUploadFile}
            onSubmitUrl={handleSubmitUrl}
            isLoading={isUploading}
          />

          {/* Pipeline steps */}
          <div style={{ marginTop: "40px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
            {[
              { icon: "⬇️", label: "Download",       sub: "yt-dlp"          },
              { icon: "🎵", label: "Audio Extract",   sub: "FFmpeg → MP3"    },
              { icon: "📝", label: "Transcribe",      sub: "Local Whisper"   },
              { icon: "🔬", label: "NLP Classify",    sub: "spaCy + FLAIR"   },
              { icon: "🌐", label: "Web Search",      sub: "Serper.dev + DuckDuckGo"      },
              { icon: "⚖️", label: "Verdict",         sub: "Local LLM"       },
            ].map((step) => (
              <div key={step.label} style={{ background: "#0d0d0d", border: "1px solid #1f1f1f", borderRadius: "8px", padding: "14px", textAlign: "center" }}>
                <div style={{ fontSize: "20px", marginBottom: "6px" }}>{step.icon}</div>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#d1d5db", marginBottom: "2px" }}>{step.label}</div>
                <div style={{ fontSize: "11px", color: "#4b5563" }}>{step.sub}</div>
              </div>
            ))}
          </div>
        </main>
      )}

      {/* ════════════════ PROCESSING VIEW ════════════════ */}
      {view === "processing" && (
        <main style={{ maxWidth: "560px", margin: "80px auto", padding: "0 24px", textAlign: "center" }}>
          <div style={{ fontSize: "56px", marginBottom: "20px" }}>{stageMeta?.icon ?? "⏳"}</div>
          <h2 style={{ fontSize: "24px", fontWeight: 800, color: "#f9fafb", marginBottom: "8px", letterSpacing: "-0.02em" }}>
            {stageMeta?.label ?? "Processing..."}
          </h2>
          <p style={{ color: "#6b7280", fontSize: "14px" }}>{status?.message ?? "Starting..."}</p>

          <ProgressBar progress={status?.progress ?? 0} color={stageMeta?.color ?? "#60a5fa"} />
          <p style={{ color: "#374151", fontSize: "12px", marginTop: "8px", fontVariantNumeric: "tabular-nums" }}>
            {status?.progress ?? 0}% complete
          </p>

          {/* Stage stepper */}
          <div style={{ marginTop: "36px", display: "flex", flexDirection: "column", gap: "6px", textAlign: "left" }}>
            {stageOrder.map((stage) => {
              const meta        = STAGE_META[stage];
              const currentIdx  = stageOrder.indexOf(status?.stage ?? stageOrder[0]);
              const thisIdx     = stageOrder.indexOf(stage);
              const isDone      = thisIdx < currentIdx;
              const isCurrent   = thisIdx === currentIdx;
              return (
                <div key={stage} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "9px 14px", borderRadius: "8px", background: isCurrent ? "#111827" : "transparent", border: isCurrent ? `1px solid ${meta.color}44` : "1px solid transparent", opacity: isDone ? 0.45 : 1 }}>
                  <span style={{ fontSize: "17px", width: "22px", textAlign: "center" }}>{isDone ? "✓" : isCurrent ? meta.icon : "○"}</span>
                  <span style={{ fontSize: "13px", color: isCurrent ? meta.color : isDone ? "#4b5563" : "#374151", fontWeight: isCurrent ? 700 : 400 }}>{meta.label}</span>
                </div>
              );
            })}
          </div>

          {status?.stage === "error" && (
            <div style={{ marginTop: "24px", background: "#1a0d0d", border: "1px solid #7f1d1d", borderRadius: "8px", padding: "16px", color: "#f87171", fontSize: "14px" }}>
              ❌ {status.message}
            </div>
          )}
        </main>
      )}

      {/* ════════════════ RESULTS VIEW ════════════════ */}
      {view === "results" && (
        <main style={{ maxWidth: "1100px", margin: "0 auto", padding: "32px 24px" }}>

          <style>{`@keyframes fcv-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

          {/* Source banner — only when result is fully loaded */}
          {result?.sourceUrl && (
            <div style={{ background: "#0d1117", border: "1px solid #1f2937", borderRadius: "8px", padding: "14px 18px", marginBottom: "24px", display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: "200px" }}>
                <p style={{ color: "#9ca3af", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 3px" }}>Source</p>
                <p style={{ color: "#e0e0e0", fontSize: "14px", fontWeight: 600, margin: 0 }}>{result.sourceTitle ?? "Unknown title"}</p>
              </div>
              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                {result.sourcePlatform && (
                  <span style={{ background: "#111", border: "1px solid #333", color: "#a78bfa", fontSize: "11px", fontWeight: 700, padding: "3px 12px", borderRadius: "20px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {result.sourcePlatform}
                  </span>
                )}
                <a href={result.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "#60a5fa", fontSize: "12px" }}>Open original ↗</a>
              </div>
            </div>
          )}

          {/* Live verifying banner */}
          {isStillVerifying && (
            <div style={{ display: "flex", alignItems: "center", gap: "12px", background: "#0a1a14", border: "1px solid #10b98144", borderRadius: "8px", padding: "13px 18px", marginBottom: "20px" }}>
              <span style={{ fontSize: "18px", display: "inline-block", animation: "fcv-spin 1.4s linear infinite" }}>⚖️</span>
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#10b981" }}>
                  Synthesizing verdicts — {verifiedSoFar} of {verifyingTotal} complete
                </p>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#4b5563" }}>
                  Results appear as each verdict is generated. The page updates automatically.
                </p>
              </div>
              <div style={{ width: "120px", height: "5px", background: "#1f2937", borderRadius: "3px", flexShrink: 0 }}>
                <div style={{ width: `${verifyingTotal > 0 ? (verifiedSoFar / verifyingTotal) * 100 : 0}%`, height: "100%", background: "#10b981", borderRadius: "3px", transition: "width 0.5s ease" }} />
              </div>
            </div>
          )}

          {/* Stats */}
          <h2 style={{ fontSize: "26px", fontWeight: 900, letterSpacing: "-0.03em", color: "#f9fafb", marginBottom: "18px" }}>
            Analysis Results
            {isStillVerifying && <span style={{ fontSize: "14px", fontWeight: 400, color: "#4b5563", marginLeft: "12px" }}>— more incoming</span>}
          </h2>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "28px" }}>
            <StatCard label="Sentences"    value={liveSummary.totalSentences}    color="#60a5fa" icon="📄" />
            <StatCard label="Facts"        value={liveSummary.factCount}          color="#34d399" icon="📊" />
            <StatCard label="Opinions"     value={liveSummary.opinionCount}       color="#a78bfa" icon="💭" />
            <StatCard label="Checked"      value={liveVerdicts.length}            color="#fb923c" icon="🔍" />
            <StatCard label="True"         value={liveSummary.trueCount}          color="#4ade80" icon="✓"  />
            <StatCard label="False"        value={liveSummary.falseCount}         color="#f87171" icon="✗"  />
            <StatCard label="Partial"      value={liveSummary.partiallyTrueCount} color="#fb923c" icon="◐"  />
            <StatCard label="Unverifiable" value={liveSummary.unverifiableCount}  color="#a78bfa" icon="?"  />
          </div>

          {/* Tabs — transcript locked until pipeline done */}
          <div style={{ display: "flex", gap: "4px", borderBottom: "1px solid #1f1f1f", marginBottom: "24px" }}>
            <button onClick={() => setActiveTab("verdicts")}
              style={{ padding: "10px 24px", border: "none", background: "none", color: activeTab === "verdicts" ? "#60a5fa" : "#6b7280", fontWeight: activeTab === "verdicts" ? 700 : 400, fontSize: "14px", cursor: "pointer", borderBottom: activeTab === "verdicts" ? "2px solid #60a5fa" : "2px solid transparent", transition: "all 0.15s", fontFamily: "inherit" }}>
              ⚖️ Fact Verdicts ({liveVerdicts.length}{isStillVerifying ? "…" : ""})
            </button>
            <button
              onClick={() => { if (!isStillVerifying) setActiveTab("transcript"); }}
              style={{ padding: "10px 24px", border: "none", background: "none", color: isStillVerifying ? "#2d2d2d" : activeTab === "transcript" ? "#60a5fa" : "#6b7280", fontWeight: activeTab === "transcript" ? 700 : 400, fontSize: "14px", cursor: isStillVerifying ? "not-allowed" : "pointer", borderBottom: activeTab === "transcript" ? "2px solid #60a5fa" : "2px solid transparent", transition: "all 0.15s", fontFamily: "inherit" }}>
              📝 Transcript {isStillVerifying ? "(available when done)" : `(${result?.classifiedSentences.length ?? 0})`}
            </button>
          </div>
          {/* Verdicts tab */}
          {activeTab === "verdicts" && (
            <div>
              {liveVerdicts.length > 0 && (
                <div style={{ display: "flex", gap: "8px", marginBottom: "20px", flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ color: "#6b7280", fontSize: "12px", marginRight: "4px" }}>Filter:</span>
                  <FilterButton label="All"          count={liveVerdicts.length}               active={verdictFilter === "ALL"}            onClick={() => setVFilter("ALL")}            color="#60a5fa" />
                  <FilterButton label="True"         count={liveSummary.trueCount}             active={verdictFilter === "TRUE"}           onClick={() => setVFilter("TRUE")}           color="#4ade80" />
                  <FilterButton label="False"        count={liveSummary.falseCount}            active={verdictFilter === "FALSE"}          onClick={() => setVFilter("FALSE")}          color="#f87171" />
                  <FilterButton label="Partial"      count={liveSummary.partiallyTrueCount}    active={verdictFilter === "PARTIALLY_TRUE"} onClick={() => setVFilter("PARTIALLY_TRUE")} color="#fb923c" />
                  <FilterButton label="Unverifiable" count={liveSummary.unverifiableCount}     active={verdictFilter === "UNVERIFIABLE"}   onClick={() => setVFilter("UNVERIFIABLE")}   color="#a78bfa" />
                </div>
              )}
              {liveVerdicts.length === 0 ? (
                <div style={{ textAlign: "center", padding: "60px 0", color: "#374151" }}>
                  <div style={{ fontSize: "36px", marginBottom: "12px", animation: "fcv-spin 1.4s linear infinite", display: "inline-block" }}>⚖️</div>
                  <p style={{ fontSize: "14px", color: "#4b5563" }}>Waiting for first verdict…</p>
                </div>
              ) : filteredVerdicts.length === 0 ? (
                <div style={{ textAlign: "center", padding: "60px", color: "#4b5563", fontSize: "14px" }}>No verdicts match this filter yet.</div>
              ) : (
                filteredVerdicts.map((v, i) => <ClaimCard key={i} verdict={v} index={i} />)
              )}
            </div>
          )}

          {/* Transcript tab — only available after pipeline fully completes */}
          {activeTab === "transcript" && result && (
            <TranscriptView sentences={result.classifiedSentences} />
          )}
        </main>
      )}
    </div>
  );
}