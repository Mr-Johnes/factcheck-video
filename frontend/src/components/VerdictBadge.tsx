import React from "react";
import { VerdictType } from "../types";

interface Props {
  verdict: VerdictType;
  confidence?: number;
  size?: "sm" | "md" | "lg";
}

const VERDICT_CONFIG: Record<VerdictType, { label: string; bg: string; text: string; border: string; icon: string }> = {
  TRUE:           { label: "TRUE",           bg: "#0d2d1a", text: "#4ade80", border: "#166534", icon: "✓" },
  FALSE:          { label: "FALSE",          bg: "#2d0d0d", text: "#f87171", border: "#991b1b", icon: "✗" },
  PARTIALLY_TRUE: { label: "PARTIALLY TRUE", bg: "#2d1f0d", text: "#fb923c", border: "#9a3412", icon: "◐" },
  UNVERIFIABLE:   { label: "UNVERIFIABLE",   bg: "#1a1a2d", text: "#a78bfa", border: "#4c1d95", icon: "?" },
};

const VerdictBadge: React.FC<Props> = ({ verdict, confidence, size = "md" }) => {
  const config = VERDICT_CONFIG[verdict];
  const padding   = size === "sm" ? "2px 8px"  : size === "lg" ? "8px 20px"  : "4px 14px";
  const fontSize  = size === "sm" ? "10px"      : size === "lg" ? "15px"      : "12px";
  const iconSize  = size === "sm" ? "11px"      : "14px";

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding, borderRadius: "4px", background: config.bg, color: config.text, border: `1px solid ${config.border}`, fontSize, fontWeight: 700, letterSpacing: "0.08em", fontFamily: "'Courier New', monospace", whiteSpace: "nowrap" }}>
      <span style={{ fontSize: iconSize }}>{config.icon}</span>
      {config.label}
      {confidence !== undefined && (
        <span style={{ opacity: 0.7, fontWeight: 400, marginLeft: "2px" }}>{confidence}%</span>
      )}
    </span>
  );
};

export default VerdictBadge;