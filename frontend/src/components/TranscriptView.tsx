import React, { useState } from "react";
import { ClassifiedSentence } from "../types";

interface Props {
  sentences: ClassifiedSentence[];
}

const TYPE_STYLE: Record<
  ClassifiedSentence["type"],
  { bg: string; border: string; label: string; labelColor: string }
> = {
  fact:     { bg: "rgba(22,101,52,0.15)",   border: "#166534", label: "FACT",      labelColor: "#4ade80" },
  opinion:  { bg: "rgba(124,58,237,0.12)",  border: "#6d28d9", label: "OPINION",   labelColor: "#a78bfa" },
  uncertain:{ bg: "rgba(75,85,99,0.15)",    border: "#374151", label: "UNCERTAIN", labelColor: "#9ca3af" },
};

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const TranscriptView: React.FC<Props> = ({ sentences }) => {
  const [filter, setFilter] = useState<ClassifiedSentence["type"] | "all">("all");

  const filtered = filter === "all" ? sentences : sentences.filter((s) => s.type === filter);
  const counts = {
    fact:     sentences.filter((s) => s.type === "fact").length,
    opinion:  sentences.filter((s) => s.type === "opinion").length,
    uncertain:sentences.filter((s) => s.type === "uncertain").length,
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
        {(["all", "fact", "opinion", "uncertain"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: "5px 14px", borderRadius: "20px", cursor: "pointer",
              border: `1px solid ${filter === f ? "#60a5fa" : "#333"}`,
              background: filter === f ? "#1e3a5f" : "#1a1a1a",
              color: filter === f ? "#93c5fd" : "#9ca3af",
              fontSize: "12px", fontWeight: 600, textTransform: "uppercase",
              letterSpacing: "0.06em", transition: "all 0.15s",
            }}
          >
            {f === "all" ? `All (${sentences.length})`
              : f === "fact" ? `Facts (${counts.fact})`
              : f === "opinion" ? `Opinions (${counts.opinion})`
              : `Uncertain (${counts.uncertain})`}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "500px", overflowY: "auto", paddingRight: "4px" }}>
        {filtered.map((sentence, i) => {
          const s = TYPE_STYLE[sentence.type];
          return (
            <div key={i} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: "6px", padding: "10px 14px", display: "flex", gap: "12px", alignItems: "flex-start" }}>
              <div style={{ flexShrink: 0 }}>
                <span style={{ color: s.labelColor, fontSize: "10px", fontWeight: 700, letterSpacing: "0.08em", fontFamily: "monospace", display: "block", marginBottom: "4px" }}>{s.label}</span>
                <span style={{ color: "#555", fontSize: "10px", fontFamily: "monospace", display: "block" }}>{formatTime(sentence.start)}</span>
                <span style={{ color: "#444", fontSize: "10px", fontFamily: "monospace", display: "block" }}>{Math.round(sentence.confidence * 100)}%</span>
              </div>
              <p style={{ color: "#d1d5db", fontSize: "14px", lineHeight: "1.6", margin: 0, flex: 1 }}>{sentence.text}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TranscriptView;