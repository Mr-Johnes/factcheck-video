import React, { useState } from "react";
import { Verdict } from "../types";
import VerdictBadge from "./VerdictBadge";

interface Props {
  verdict: Verdict;
  index: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const ClaimCard: React.FC<Props> = ({ verdict, index }) => {
  const [expanded, setExpanded] = useState(false);

  const borderColor =
    verdict.verdict === "TRUE"           ? "#166534" :
    verdict.verdict === "FALSE"          ? "#991b1b" :
    verdict.verdict === "PARTIALLY_TRUE" ? "#9a3412" : "#4c1d95";

  return (
    <div style={{ background: "#111111", border: `1px solid ${borderColor}`, borderLeft: `4px solid ${borderColor}`, borderRadius: "8px", marginBottom: "16px", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "16px 20px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px" }} onClick={() => setExpanded(!expanded)}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
            <span style={{ color: "#555", fontSize: "12px", fontFamily: "monospace", background: "#1a1a1a", padding: "2px 6px", borderRadius: "4px" }}>#{index + 1}</span>
            <span style={{ color: "#555", fontSize: "12px", fontFamily: "monospace" }}>{formatTime(verdict.claim.start)} — {formatTime(verdict.claim.end)}</span>
            {/* Green topic chips come from the context window (fastcoref stage) */}
            {verdict.claim.topicSummary &&
              verdict.claim.topicSummary.split(", ").slice(0, 2).map((e) => (
                <span key={"ctx-" + e} style={{ background: "#0d1f0d", color: "#86efac", fontSize: "11px", padding: "1px 7px", borderRadius: "3px", border: "1px solid #166534" }}>📍{e}</span>
              ))
            }
            {/* Purple entity chips from the claim itself */}
            {verdict.claim.entities
              .filter((e) => !verdict.claim.topicSummary?.includes(e))
              .slice(0, 2)
              .map((e) => (
                <span key={e} style={{ background: "#1e1e2e", color: "#818cf8", fontSize: "11px", padding: "1px 7px", borderRadius: "3px", border: "1px solid #312e81" }}>{e}</span>
              ))
            }
            {verdict.claim.sentenceType && (
              <span style={{
                fontSize: "10px", fontWeight: 700, padding: "1px 8px", borderRadius: "3px",
                letterSpacing: "0.07em", textTransform: "uppercase",
                background: verdict.claim.sentenceType === "opinion"  ? "#2d1f0d" :
                            verdict.claim.sentenceType === "fact"     ? "#0d2d1a" : "#1a1a2d",
                color:      verdict.claim.sentenceType === "opinion"  ? "#fb923c" :
                            verdict.claim.sentenceType === "fact"     ? "#4ade80" : "#a78bfa",
                border:     `1px solid ${
                              verdict.claim.sentenceType === "opinion"  ? "#9a3412" :
                              verdict.claim.sentenceType === "fact"     ? "#166534" : "#4c1d95"}`,
              }}>
                {verdict.claim.sentenceType === "opinion" ? "🗣 Opinion" :
                 verdict.claim.sentenceType === "fact"    ? "📊 Fact" : "❓ Uncertain"}
              </span>
            )}
          </div>
          <p style={{ color: "#e0e0e0", fontSize: "15px", lineHeight: "1.5", margin: "0 0 10px", fontFamily: "'Georgia', serif" }}>"{verdict.claim.originalText}"</p>
          {/* Show resolved claim with RESOLVED badge when fastcoref changed it */}
          {verdict.claim.resolvedClaim &&
          verdict.claim.resolvedClaim !== verdict.claim.structuredClaim ? (
            <p style={{ color: "#9ca3af", fontSize: "13px", margin: 0, fontStyle: "italic" }}>
              <span style={{ color: "#ec4899", fontSize: "10px", fontWeight: 700,
                letterSpacing: "0.06em", marginRight: "6px", fontFamily: "monospace" }}>
                🔗 RESOLVED
              </span>
              {verdict.claim.resolvedClaim}
            </p>
          ) : (
            <p style={{ color: "#9ca3af", fontSize: "13px", margin: 0, fontStyle: "italic" }}>Claim: {verdict.claim.structuredClaim}</p>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px", flexShrink: 0 }}>
          <VerdictBadge verdict={verdict.verdict} confidence={verdict.confidence} />
          <span style={{ color: "#555", fontSize: "12px" }}>{expanded ? "▲ Less" : "▼ More"}</span>
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div style={{ borderTop: "1px solid #222", padding: "16px 20px" }}>
          <div style={{ marginBottom: "16px" }}>
            <h4 style={{ color: "#6b7280", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 6px" }}>ANALYSIS</h4>
            <p style={{ color: "#d1d5db", fontSize: "14px", lineHeight: "1.6", margin: 0 }}>{verdict.explanation}</p>
          </div>

          {/* Context window panel — shows what the speaker was discussing */}
          {verdict.claim.contextText && (
            <div style={{ marginBottom: "16px" }}>
              <h4 style={{ color: "#6b7280", fontSize: "11px", textTransform: "uppercase",
                letterSpacing: "0.1em", margin: "0 0 6px" }}>
                🔗 CONTEXT — preceding {Math.round((verdict.claim.start || 0) < 90
                  ? verdict.claim.start || 0 : 90)}s
              </h4>
              <p style={{ color: "#6b7280", fontSize: "12px", lineHeight: "1.6",
                margin: "0 0 8px", borderLeft: "2px solid #1f2937",
                paddingLeft: "10px", fontStyle: "italic" }}>
                {verdict.claim.contextText.slice(-500)}
              </p>
              {verdict.claim.enrichedQuery && (
                <p style={{ color: "#374151", fontSize: "11px", margin: 0 }}>
                  Search used:{" "}
                  <span style={{ color: "#60a5fa", fontFamily: "monospace" }}>
                    &ldquo;{verdict.claim.enrichedQuery}&rdquo;
                  </span>
                </p>
              )}
            </div>
          )}

          {verdict.correctedFact && (
            <div style={{ background: "#1a0d0d", border: "1px solid #7f1d1d", borderRadius: "6px", padding: "12px 14px", marginBottom: "16px" }}>
              <h4 style={{ color: "#ef4444", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 6px" }}>✗ CORRECTION</h4>
              <p style={{ color: "#fca5a5", fontSize: "14px", margin: 0 }}>{verdict.correctedFact}</p>
            </div>
          )}

          {verdict.evidence.length > 0 && (
            <div>
              <h4 style={{ color: "#6b7280", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 10px" }}>SOURCES ({verdict.evidence.length})</h4>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {verdict.evidence.map((ev, i) => (
                  <div key={i} style={{ background: "#1a1a1a", border: "1px solid #2d2d2d", borderRadius: "6px", padding: "10px 14px" }}>
                    <a href={ev.url} target="_blank" rel="noreferrer" style={{ color: "#60a5fa", fontSize: "13px", fontWeight: 600, textDecoration: "none", display: "block", marginBottom: "4px" }}>{ev.title} ↗</a>
                    <p style={{ color: "#9ca3af", fontSize: "12px", margin: "0 0 4px", lineHeight: "1.5" }}>{ev.snippet}</p>
                    <span style={{ color: "#4b5563", fontSize: "11px", fontFamily: "monospace" }}>{new URL(ev.url).hostname}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {verdict.evidence.length === 0 && (
            <p style={{ color: "#4b5563", fontSize: "13px", fontStyle: "italic" }}>No web sources found for this claim.</p>
          )}
        </div>
      )}
    </div>
  );
};

export default ClaimCard;