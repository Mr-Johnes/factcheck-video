import React, { useCallback, useRef, useState } from "react";

export type ClaimMode = "facts_and_opinions" | "facts_only";

const PLATFORM_META: Record<string, { label: string; color: string; icon: string }> = {
  youtube:   { label: "YouTube",    color: "#ff0000", icon: "▶" },
  tiktok:    { label: "TikTok",     color: "#69c9d0", icon: "♪" },
  instagram: { label: "Instagram",  color: "#e1306c", icon: "◈" },
  twitter:   { label: "Twitter/X",  color: "#1d9bf0", icon: "𝕏" },
  facebook:  { label: "Facebook",   color: "#1877f2", icon: "f" },
  vimeo:     { label: "Vimeo",      color: "#1ab7ea", icon: "▶" },
  reddit:    { label: "Reddit",     color: "#ff4500", icon: "●" },
  twitch:    { label: "Twitch",     color: "#9147ff", icon: "▶" },
  default:   { label: "Video",      color: "#60a5fa", icon: "🎬" },
};

function detectPlatform(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("tiktok.com"))    return "tiktok";
  if (u.includes("instagram.com")) return "instagram";
  if (u.includes("twitter.com") || u.includes("x.com")) return "twitter";
  if (u.includes("facebook.com") || u.includes("fb.watch")) return "facebook";
  if (u.includes("vimeo.com"))     return "vimeo";
  if (u.includes("reddit.com"))    return "reddit";
  if (u.includes("twitch.tv"))     return "twitch";
  return "default";
}

interface Props {
  onUploadFile: (file: File, mode: ClaimMode) => void;
  onSubmitUrl:  (url: string, mode: ClaimMode) => void;
  isLoading:    boolean;
}

const VideoUploader: React.FC<Props> = ({ onUploadFile, onSubmitUrl, isLoading }) => {
  const [tab, setTab]           = useState<"file" | "url">("file");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [claimMode, setClaimMode] = useState<ClaimMode>("facts_and_opinions");
  const inputRef = useRef<HTMLInputElement>(null);

  const detectedPlatform = urlInput ? detectPlatform(urlInput) : "default";
  const platformMeta     = PLATFORM_META[detectedPlatform];

  // ── File handlers ────────────────────────────────────────────────────────
  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith(".mp4") && file.type !== "video/mp4") {
      alert("Please upload an MP4 file.");
      return;
    }
    setFileName(file.name);
    onUploadFile(file, claimMode);
  }, [onUploadFile, claimMode]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // ── URL handlers ─────────────────────────────────────────────────────────
  const handleUrlSubmit = useCallback(() => {
    setUrlError(null);
    const trimmed = urlInput.trim();
    if (!trimmed) { setUrlError("Please paste a video URL."); return; }
    try { new URL(trimmed); }
    catch { setUrlError("That doesn't look like a valid URL."); return; }
    onSubmitUrl(trimmed, claimMode);
  }, [urlInput, onSubmitUrl, claimMode]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleUrlSubmit();
  }, [handleUrlSubmit]);

  // ── Shared styles ─────────────────────────────────────────────────────────
  const tabBtn = (active: boolean) => ({
    flex: 1, padding: "10px", border: "none",
    borderBottom: `2px solid ${active ? "#60a5fa" : "transparent"}`,
    background: "none", color: active ? "#60a5fa" : "#6b7280",
    fontWeight: active ? 700 : 400, fontSize: "14px",
    cursor: "pointer", transition: "all 0.15s", fontFamily: "inherit",
  } as React.CSSProperties);

  const modeBtn = (mode: ClaimMode) => ({
    flex: 1,
    padding: "10px 16px",
    border: `1px solid ${claimMode === mode ? (mode === "facts_and_opinions" ? "#a78bfa" : "#60a5fa") : "#2d2d2d"}`,
    borderRadius: "8px",
    background: claimMode === mode
      ? mode === "facts_and_opinions" ? "#1a1030" : "#0d1a30"
      : "#111",
    color: claimMode === mode
      ? mode === "facts_and_opinions" ? "#a78bfa" : "#60a5fa"
      : "#4b5563",
    fontWeight: claimMode === mode ? 700 : 500,
    fontSize: "13px",
    cursor: isLoading ? "not-allowed" : "pointer",
    transition: "all 0.15s",
    fontFamily: "inherit",
    textAlign: "center" as const,
    lineHeight: 1.4,
  } as React.CSSProperties);

  // ── Claim mode toggle (shared between both tabs) ───────────────────────────
  const ClaimModeToggle = () => (
    <div style={{ padding: "16px 20px", borderTop: "1px solid #1f1f1f", background: "#0a0a0a" }}>
      <p style={{ fontSize: "11px", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, margin: "0 0 10px" }}>
        What to verify
      </p>
      <div style={{ display: "flex", gap: "10px" }}>
        <button
          style={modeBtn("facts_and_opinions")}
          onClick={() => !isLoading && setClaimMode("facts_and_opinions")}
          disabled={isLoading}
        >
          <span style={{ fontSize: "16px", display: "block", marginBottom: "3px" }}>💬 + 📊</span>
          Opinions &amp; Facts
          <span style={{ display: "block", fontSize: "10px", color: "inherit", opacity: 0.7, fontWeight: 400, marginTop: "2px" }}>
            Verifies all claim types
          </span>
        </button>
        <button
          style={modeBtn("facts_only")}
          onClick={() => !isLoading && setClaimMode("facts_only")}
          disabled={isLoading}
        >
          <span style={{ fontSize: "16px", display: "block", marginBottom: "3px" }}>📊</span>
          Facts Only
          <span style={{ display: "block", fontSize: "10px", color: "inherit", opacity: 0.7, fontWeight: 400, marginTop: "2px" }}>
            Skips opinion sentences
          </span>
        </button>
      </div>
      {claimMode === "facts_only" && (
        <p style={{ fontSize: "11px", color: "#4b5563", marginTop: "8px", lineHeight: 1.5 }}>
          Opinion-framed sentences will be classified but not sent for verification, reducing processing time.
        </p>
      )}
    </div>
  );

  return (
    <div style={{ background: "#0d0d0d", border: "1px solid #222", borderRadius: "12px", overflow: "hidden" }}>

      {/* ── Tab switcher ── */}
      <div style={{ display: "flex", borderBottom: "1px solid #1f1f1f" }}>
        <button style={tabBtn(tab === "file")} onClick={() => setTab("file")} disabled={isLoading}>
          📁 Upload File
        </button>
        <button style={tabBtn(tab === "url")} onClick={() => setTab("url")} disabled={isLoading}>
          🔗 Paste URL
        </button>
      </div>

      {/* ── File tab ── */}
      {tab === "file" && (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => !isLoading && inputRef.current?.click()}
            style={{ padding: "48px 40px", textAlign: "center", cursor: isLoading ? "not-allowed" : "pointer", background: dragging ? "rgba(96,165,250,0.05)" : "transparent", transition: "background 0.2s" }}
          >
            <input ref={inputRef} type="file" accept="video/mp4,.mp4" onChange={onFileChange} style={{ display: "none" }} disabled={isLoading} />
            <div style={{ fontSize: "44px", marginBottom: "14px" }}>🎬</div>
            {fileName ? (
              <p style={{ color: "#60a5fa", fontSize: "16px", fontWeight: 600 }}>{fileName}</p>
            ) : (
              <>
                <p style={{ color: "#e0e0e0", fontSize: "17px", fontWeight: 600, marginBottom: "6px" }}>Drop your MP4 here</p>
                <p style={{ color: "#555", fontSize: "13px" }}>or click to browse · Max 500 MB</p>
              </>
            )}
            {isLoading && <p style={{ color: "#fb923c", fontSize: "13px", marginTop: "12px" }}>Processing...</p>}
          </div>
          <ClaimModeToggle />
        </>
      )}

      {/* ── URL tab ── */}
      {tab === "url" && (
        <>
          <div style={{ padding: "32px 28px 24px" }}>
            <p style={{ color: "#9ca3af", fontSize: "13px", marginBottom: "20px", lineHeight: "1.5" }}>
              Paste a link from YouTube, TikTok, Instagram, Twitter/X, Facebook, Vimeo, Reddit, Twitch, and{" "}
              <a href="https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md" target="_blank" rel="noreferrer" style={{ color: "#60a5fa" }}>1000+ more sites</a>.
            </p>

            {/* URL input row */}
            <div style={{ display: "flex", gap: "10px", alignItems: "stretch" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "44px", flexShrink: 0, background: "#111", border: "1px solid #2d2d2d", borderRadius: "8px", fontSize: "18px", color: platformMeta.color, fontWeight: 800, fontFamily: "monospace" }}>
                {platformMeta.icon}
              </div>
              <input
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); setUrlError(null); }}
                onKeyDown={onKeyDown}
                disabled={isLoading}
                style={{ flex: 1, background: "#111", border: `1px solid ${urlError ? "#ef4444" : "#2d2d2d"}`, borderRadius: "8px", padding: "10px 14px", color: "#e0e0e0", fontSize: "14px", fontFamily: "monospace", outline: "none", transition: "border-color 0.15s" }}
              />
              <button
                onClick={handleUrlSubmit}
                disabled={isLoading || !urlInput.trim()}
                style={{ padding: "10px 22px", background: isLoading || !urlInput.trim() ? "#1f1f1f" : "#1e3a5f", border: `1px solid ${isLoading || !urlInput.trim() ? "#2d2d2d" : "#2563eb"}`, borderRadius: "8px", color: isLoading || !urlInput.trim() ? "#4b5563" : "#93c5fd", fontWeight: 700, fontSize: "14px", cursor: isLoading || !urlInput.trim() ? "not-allowed" : "pointer", whiteSpace: "nowrap", transition: "all 0.15s", fontFamily: "inherit" }}
              >
                {isLoading ? "Working..." : "Analyse →"}
              </button>
            </div>

            {urlError && (
              <p style={{ color: "#f87171", fontSize: "12px", marginTop: "8px" }}>{urlError}</p>
            )}

            {urlInput && !urlError && (
              <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ color: "#4b5563", fontSize: "12px" }}>Detected:</span>
                <span style={{ background: "#111", border: `1px solid ${platformMeta.color}44`, color: platformMeta.color, fontSize: "11px", fontWeight: 700, padding: "2px 10px", borderRadius: "20px", letterSpacing: "0.06em" }}>
                  {platformMeta.label}
                </span>
              </div>
            )}

            <div style={{ marginTop: "20px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {Object.entries(PLATFORM_META)
                .filter(([k]) => k !== "default")
                .map(([key, meta]) => (
                  <span key={key} style={{ color: meta.color, fontSize: "11px", background: "#111", border: "1px solid #222", padding: "3px 10px", borderRadius: "20px", opacity: 0.7 }}>
                    {meta.label}
                  </span>
                ))}
              <span style={{ color: "#4b5563", fontSize: "11px", padding: "3px 10px" }}>+ many more</span>
            </div>
          </div>
          <ClaimModeToggle />
        </>
      )}
    </div>
  );
};

export default VideoUploader;