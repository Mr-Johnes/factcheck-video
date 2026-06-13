"""
FactCheckVideo — Python Microservice (Fully Local, Zero API Cost)
=================================================================
Pipeline stages handled here:

  POST /transcribe        — faster-whisper (local Whisper model)
  POST /classify          — spaCy + FLAIR + RE rules (fact/opinion/uncertain)
  POST /extract_claims    — spaCy dependency parser (verifiable claim detection)
  POST /resolve_context   — fastcoref coreference + context window builder
  POST /search            — Serper.dev (Google results) with DDG fallback
  POST /download          — yt-dlp (YouTube, TikTok, Instagram, etc.)
  POST /verdict           — Ollama local LLM
  GET  /health            — component status

Requirements: see requirements.txt
Ollama must be running separately: https://ollama.com
"""

from flask import Flask, request, jsonify
import torch  # needed for torch.cuda.empty_cache() between pipeline stages
from dataclasses import dataclass, asdict
from typing import List, Literal, Optional, Dict, Any
import logging
import re
import json
import time
import random
import requests as req_lib
import os
import uuid
import subprocess

# ── faster-whisper ─────────────────────────────────────────────────────────
try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False
    logging.warning("faster-whisper not installed")

# ── spaCy ──────────────────────────────────────────────────────────────────
try:
    import spacy
    nlp = spacy.load("en_core_web_sm")
    SPACY_AVAILABLE = True
    logging.info("spaCy loaded: en_core_web_sm")
except Exception as e:
    SPACY_AVAILABLE = False
    nlp = None
    logging.warning(f"spaCy not available: {e}")

# ── FLAIR ──────────────────────────────────────────────────────────────────
# flair 0.14+ uses flair.nn.Classifier as the unified loading API.
try:
    from flair.data import Sentence as FlairSentence
    from flair.nn import Classifier as FlairClassifier
    flair_classifier = FlairClassifier.load("sentiment")
    FLAIR_AVAILABLE = True
    logging.info("FLAIR sentiment classifier loaded")
except Exception as e:
    FLAIR_AVAILABLE = False
    flair_classifier = None
    logging.warning(f"FLAIR not available: {e}")

# ── DuckDuckGo ─────────────────────────────────────────────────────────────
try:
    from duckduckgo_search import DDGS
    DDG_AVAILABLE = True
    logging.info("DuckDuckGo search available")
except ImportError:
    DDG_AVAILABLE = False
    logging.warning("duckduckgo_search not installed")

# ── yt-dlp ─────────────────────────────────────────────────────────────────
try:
    import yt_dlp
    YTDLP_AVAILABLE = True
    logging.info("yt-dlp available")
except ImportError:
    YTDLP_AVAILABLE = False
    logging.warning("yt-dlp not installed — URL downloads unavailable")

# ── Load .env file (if present) ────────────────────────────────────────────
# python-dotenv reads backend/python/.env and injects into os.environ.
# This keeps secrets out of the codebase. If the package isn't installed
# or the file doesn't exist, the app still works — env vars set in the
# shell (export SERPER_API_KEY=...) are used instead.
try:
    from dotenv import load_dotenv
    # Walk up from this file's directory to find .env
    _env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    load_dotenv(_env_path)
    logging.info(f"[Config] Loaded .env from {_env_path}")
except ImportError:
    logging.info("[Config] python-dotenv not installed — using shell environment variables only")

# ── Serper.dev config ──────────────────────────────────────────────────────
# Serper returns real Google results as structured JSON, 1-2s response time.
# Free tier: 2,500 queries, no credit card required — sign up at serper.dev
#
# Set SERPER_API_KEY in backend/python/.env (see .env.example).
# If the key is missing, falls back to DuckDuckGo automatically.
SERPER_API_KEY  = os.environ.get("SERPER_API_KEY", "")
SERPER_ENDPOINT = "https://google.serper.dev/search"
SERPER_AVAILABLE = bool(SERPER_API_KEY)
if SERPER_AVAILABLE:
    logging.info("Serper.dev search available (Google results)")
else:
    logging.warning(
        "[Search] SERPER_API_KEY not set — will use DuckDuckGo. "
        "Add your key to backend/python/.env to use Serper."
    )

# ── fastcoref ──────────────────────────────────────────────────────────────
# fastcoref is a modern, actively-maintained coreference resolver that works
# with Python 3.12 and spaCy v3. It resolves pronoun/reference chains across
# the full transcript so vague claims like "the riots were orchestrated" get
# resolved to "the January 6 Capitol riots were orchestrated" before searching.
#
# Two models are available:
#   FCoref      — fast, ~500 MB,  good accuracy  (default)
#   LingMessCoref — slow, ~1.5 GB, state-of-the-art accuracy
#
# The model downloads automatically on first use and caches in ~/.cache/huggingface/.
FASTCOREF_AVAILABLE = False
fastcoref_model = None

try:
    from fastcoref import FCoref, spacy_component  # noqa: F401 — registers the pipe
    FASTCOREF_AVAILABLE = True
    logging.info("fastcoref imported successfully")
except ImportError:
    logging.warning("fastcoref not installed. Run: pip install fastcoref transformers")

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

# ── Whisper model singleton ────────────────────────────────────────────────
# Model sizes:  tiny(~75MB)  base(~145MB)  small(~465MB)  medium(~1.5GB)  large-v3(~3GB)
# On RTX 4060 8GB VRAM:
#   "small"   — ~2–3 min for a 1-hour video, excellent accuracy  ← recommended
#   "medium"  — ~4–5 min for a 1-hour video, very good accuracy
#   "large-v3"— ~8–10 min for a 1-hour video, best accuracy (fits in 8GB VRAM)
# compute_type="float16" is optimal for CUDA — full GPU tensor cores, no accuracy loss.
WHISPER_MODEL_SIZE = "small"   # upgrade from "base" — much better accuracy on GPU
whisper_model: Optional[Any] = None

def get_whisper_model():
    global whisper_model
    if whisper_model is None and WHISPER_AVAILABLE:
        logging.info(f"Loading Whisper '{WHISPER_MODEL_SIZE}' model on CUDA (float16)...")
        whisper_model = WhisperModel(
            WHISPER_MODEL_SIZE,
            device="cuda",
            compute_type="float16",  # full fp16 — fastest on RTX 4060, no accuracy loss
        )
        logging.info("Whisper model ready on GPU")
    return whisper_model

# ── fastcoref singleton loader ────────────────────────────────────────────
CONTEXT_WINDOW_SECONDS = 90   # how many seconds of preceding transcript to include

def get_fastcoref_model():
    """
    Loads the FCoref model once and keeps it in memory.
    The model auto-downloads to ~/.cache/huggingface/ on first call (~500 MB).
    Subsequent calls return the cached in-memory model immediately.
    """
    global fastcoref_model
    if fastcoref_model is None and FASTCOREF_AVAILABLE:
        try:
            logging.info("[FastCoref] Loading FCoref model on CUDA (downloads ~500MB on first run)...")
            fastcoref_model = FCoref(device="cuda")
            logging.info("[FastCoref] Model ready on GPU")
        except Exception as e:
            logging.error(f"[FastCoref] Failed to load model: {e}")
    return fastcoref_model


# ── Ollama config ──────────────────────────────────────────────────────────
OLLAMA_BASE_URL = "http://localhost:11434"
# Change to whatever you pulled: "llama3.2", "mistral", "phi3", "gemma2", etc.
OLLAMA_MODEL = "llama3"

def _get_ollama_model() -> str:
    """Auto-detects the available model, falling back gracefully."""
    try:
        r = req_lib.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3)
        if r.status_code != 200:
            return OLLAMA_MODEL
        models = [m["name"] for m in r.json().get("models", [])]
        if not models:
            return OLLAMA_MODEL
        for m in models:
            if m.split(":")[0] == OLLAMA_MODEL or m == OLLAMA_MODEL:
                logging.info(f"[Ollama] Using model: {m}")
                return m
        logging.warning(f"[Ollama] '{OLLAMA_MODEL}' not found. Available: {models}. Using: {models[0]}")
        return models[0]
    except Exception:
        return OLLAMA_MODEL


# =============================================================================
# STAGE 1 — TRANSCRIPTION (faster-whisper)
# =============================================================================

def _merge_into_sentences(segments: list) -> list:
    """
    Merges consecutive short Whisper segments into sentence-length units.

    Splitting rules (first match wins):
      1. Terminal punctuation at end of accumulated text (.  !  ?)
      2. Accumulated text reaches MAX_CHARS (150) — hard cap, one sentence max
      3. Time gap between consecutive segments exceeds GAP_SECONDS (1.5s) —
         Whisper VAD pauses almost always correspond to sentence boundaries
         in natural speech even when punctuation is absent

    150 chars at ~5 chars/word = ~30 words per segment, which is one
    comfortable spoken sentence. The old limit of 300 was accumulating
    2–3 sentences per unit and is the root cause of the over-long claims.
    """
    MAX_CHARS   = 150
    GAP_SECONDS = 1.5

    merged  = []
    current = None

    for seg in segments:
        if current is None:
            current = dict(seg)
            continue

        time_gap = seg.get("start", 0.0) - current.get("end", 0.0)
        combined = current["text"] + " " + seg["text"]

        # Rule 1: terminal punctuation on what we have so far → close now
        if re.search(r"[.!?]$", current["text"].strip()):
            merged.append(current)
            current = dict(seg)
            continue

        # Rule 2: adding this segment would exceed the char cap → close first
        if len(combined) > MAX_CHARS:
            merged.append(current)
            current = dict(seg)
            continue

        # Rule 3: significant pause between segments → treat as sentence boundary
        if time_gap > GAP_SECONDS:
            merged.append(current)
            current = dict(seg)
            continue

        # Otherwise accumulate
        current["text"] = combined
        current["end"]  = seg["end"]

    if current:
        merged.append(current)

    return merged


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """
    Input:  { "mp3_path": "/absolute/path/to/audio.mp3" }
    Output: { "segments": [{ "text": "...", "start": 0.0, "end": 3.2 }], "language": "en" }
    """
    data = request.get_json()
    if not data or "mp3_path" not in data:
        return jsonify({"error": "Missing 'mp3_path'"}), 400

    mp3_path = data["mp3_path"]
    model = get_whisper_model()
    if not model:
        return jsonify({"error": "faster-whisper not available"}), 503

    logging.info(f"[Transcribe] Starting: {mp3_path}")
    t0 = time.time()

    try:
        segments_iter, info = model.transcribe(
            mp3_path,
            beam_size=5,
            language="en",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
        )
        raw = [
            {"text": s.text.strip(), "start": round(s.start, 2), "end": round(s.end, 2)}
            for s in segments_iter if s.text.strip()
        ]
        merged = _merge_into_sentences(raw)
        logging.info(f"[Transcribe] Done in {round(time.time()-t0,1)}s — {len(merged)} sentences")
        return jsonify({"segments": merged, "language": info.language})

    except FileNotFoundError:
        return jsonify({"error": f"File not found: {mp3_path}"}), 400
    except Exception as e:
        logging.exception("[Transcribe] Error")
        return jsonify({"error": str(e)}), 500


# =============================================================================
# STAGE 2 — CLASSIFICATION (spaCy + FLAIR + RE rules)
# =============================================================================

OPINION_RE = [re.compile(p, re.IGNORECASE) for p in [
    r"\b(i think|i believe|i feel|in my opinion|i consider|personally|i would say)\b",
    r"\b(should|shouldn't|must|ought to|needs to)\b",
    r"\b(best|worst|greatest|terrible|amazing|horrible|excellent|awful|fantastic|dreadful)\b",
    r"\b(clearly|obviously|certainly|undoubtedly|surely|definitely)\b.*\b(wrong|right|bad|good)\b",
    r"\b(love|hate|prefer|disagree|agree|support|oppose)\b",
    r"\b(in my view|from my perspective|as far as i'm concerned|to my mind)\b",
    r"\b(arguably)\b",
    r"\b(seems|appears|looks like|feels like)\b",
    r"\b(beautiful|ugly|wonderful|disgusting|impressive|disappointing)\b",
]]

FACT_RE = [re.compile(p, re.IGNORECASE) for p in [
    r"\b(according to|based on|research shows|studies show|data indicates|statistics show)\b",
    r"\b(was born|died|founded|established|discovered|invented|created)\b",
    r"\b(is located|is situated|is the capital)\b",
    r"\b(19|20)\d{2}\b",
    r"\b\d+(\.\d+)?\s?(percent|%|million|billion|thousand|km|kg|miles|pounds|dollars)\b",
    r"\b(officially|legally|scientifically|historically|medically)\b",
    r"\b(the study|the report|the survey|the census|the data)\b",
]]


@dataclass
class ClassifiedSentence:
    text: str
    start: float
    end: float
    type: Literal["fact", "opinion", "uncertain"]
    confidence: float
    entities: List[str]
    rule_signals: List[str]


def _classify_one(text: str, start: float, end: float) -> ClassifiedSentence:
    opinion_score = 0.0
    fact_score = 0.0
    signals = []

    op_hits = [p.pattern for p in OPINION_RE if p.search(text)]
    fa_hits = [p.pattern for p in FACT_RE if p.search(text)]
    opinion_score += len(op_hits) * 2.0
    fact_score    += len(fa_hits) * 2.0
    signals += [f"RE:opinion:{h[:30]}" for h in op_hits]
    signals += [f"RE:fact:{h[:30]}"    for h in fa_hits]

    entities = []
    if nlp:
        doc = nlp(text)
        entities = [ent.text for ent in doc.ents]
        if doc.ents:
            fact_score += 1.5
            signals.append("spaCy:named_entity")
        subj_adjs = [t for t in doc if t.pos_ == "ADJ" and t.dep_ in ("amod","attr","acomp")]
        modals    = [t for t in doc if t.tag_ == "MD"]
        opinion_score += len(subj_adjs) * 0.8
        opinion_score += len(modals)    * 0.5
        if subj_adjs: signals.append(f"spaCy:subj_adj({len(subj_adjs)})")
        if modals:    signals.append(f"spaCy:modal({len(modals)})")

    if flair_classifier:
        try:
            fs = FlairSentence(text)
            flair_classifier.predict(fs)
            # Try 'class' first (standard flair label type), fall back to first label
            lbl = fs.get_label("class") if fs.labels else None
            if lbl is None and fs.labels:
                lbl = fs.labels[0]
            if lbl and lbl.value in ("POSITIVE","NEGATIVE") and lbl.score > 0.8:
                opinion_score += 1.5
                signals.append(f"FLAIR:sentiment({lbl.score:.2f})")
            elif lbl.score < 0.4:
                fact_score += 0.5
                signals.append(f"FLAIR:neutral({lbl.score:.2f})")
        except Exception:
            pass

    total = opinion_score + fact_score
    if total == 0:
        label_out, conf = "uncertain", 0.5
    elif opinion_score > fact_score * 1.2:
        label_out = "opinion"
        conf = min(0.99, opinion_score / (total + 1e-9))
    elif fact_score > opinion_score * 1.2:
        label_out = "fact"
        conf = min(0.99, fact_score / (total + 1e-9))
    else:
        label_out, conf = "uncertain", 0.5

    return ClassifiedSentence(
        text=text, start=start, end=end,
        type=label_out, confidence=round(conf, 3),
        entities=entities, rule_signals=signals,
    )


@app.route("/classify", methods=["POST"])
def classify():
    """
    Input:  { "segments": [{ "text": "...", "start": 0.0, "end": 3.5 }] }
    Output: { "results": [ClassifiedSentence, ...] }
    """
    data = request.get_json()
    if not data or "segments" not in data:
        return jsonify({"error": "Missing 'segments'"}), 400

    results = [
        asdict(_classify_one(
            seg.get("text","").strip(),
            seg.get("start", 0.0),
            seg.get("end", 0.0)
        ))
        for seg in data["segments"] if seg.get("text","").strip()
    ]
    return jsonify({"results": results})


# =============================================================================
# STAGE 2.5 — CONTEXT RESOLUTION (fastcoref + context window)
# =============================================================================
#
# This stage runs between classify and extract_claims (orchestrated by Node).
# It does three things for every claim:
#
# 1. COREFERENCE RESOLUTION (fastcoref / FCoref)
#    Runs the full transcript as one document through fastcoref.
#    FCoref returns clusters — groups of spans that all refer to the same entity.
#    For each cluster, the most informative mention (longest, or one with a
#    named entity) is selected as the "canonical" form.
#    All other mentions in the chain that are pronouns or vague noun phrases
#    ("they", "the riots", "the incident") are replaced with the canonical form
#    in the claim text, producing resolvedClaim.
#
# 2. CONTEXT WINDOW
#    For each claim at timestamp T, gathers the 90 seconds of preceding
#    transcript text. spaCy NER extracts named entities from this window.
#    These become contextEntities — the "topic" the speaker was discussing.
#
# 3. ENTITY GROUNDING
#    If the claim's subject is a vague reference ("the riots", "they", "it")
#    AND the context has concrete named entities, the subject is prepended with
#    those entities to produce an enriched claim suitable for web searching.
#    "The riots were orchestrated" + ["January 6", "Capitol"] becomes
#    "January 6 Capitol riots were orchestrated".
#    enrichedQuery is the final DuckDuckGo query built from this enriched claim.
#
# =============================================================================

def _get_cluster_canonical(cluster_spans: list, full_text: str) -> str:
    """
    Given a list of (start_char, end_char) spans from a fastcoref cluster,
    returns the text of the most informative mention:
      - Prefers spans containing spaCy named entities
      - Among ties, prefers the longest span
    """
    if not cluster_spans:
        return ""

    best_text = ""
    best_score = -1

    for (start, end) in cluster_spans:
        span_text = full_text[start:end]
        # Score: entity presence boosts by 10, then length
        has_entity = 0
        if nlp:
            doc = nlp(span_text)
            has_entity = 10 if any(ent.label_ in {
                "PERSON", "ORG", "GPE", "EVENT", "DATE", "LOC", "FAC", "NORP", "LAW"
            } for ent in doc.ents) else 0
        score = has_entity + len(span_text)
        if score > best_score:
            best_score = score
            best_text = span_text

    return best_text


def _apply_coref_clusters(claim_text: str, clusters: list,
                          full_text: str, claim_char_offset: int) -> str:
    """
    Applies coreference clusters to a single claim.

    For each cluster whose canonical mention appears BEFORE the claim in the
    transcript (i.e., was established earlier in conversation), replaces any
    vague mentions found in the claim text with the canonical form.

    Only replaces pronouns and known vague noun phrases — does not touch
    proper nouns that are already informative.
    """
    # Noun phrases we consider "vague" and worth replacing
    VAGUE_RE = re.compile(
        r"^(it|they|them|he|she|him|her|we|us|this|that|these|those|"
        r"the riots?|the protests?|the attack|the shooting|the incident|"
        r"the event|the situation|the case|the matter|the issue|"
        r"the conflict|the war|the crisis|the scandal|the election|"
        r"the vote|the decision|the policy|the law|the bill|the act|"
        r"the deal|the agreement|the movement|the group|the company|"
        r"the government|the administration|the organization)",
        re.IGNORECASE
    )

    result = claim_text
    for cluster in clusters:
        # cluster is a list of (start_char, end_char) tuples
        canonical = _get_cluster_canonical(cluster, full_text)
        if not canonical or len(canonical) < 3:
            continue

        # Only use mentions that appeared before this claim in the transcript
        prior_mentions = [(s, e) for (s, e) in cluster if e <= claim_char_offset]
        if not prior_mentions:
            continue

        # Find vague mentions in the claim that match any span in this cluster
        for (span_start, span_end) in cluster:
            span_text = full_text[span_start:span_end]
            # Only replace if the span text is vague AND appears in the claim
            if VAGUE_RE.match(span_text.strip()) and span_text.lower() != canonical.lower():
                result = re.sub(
                    re.escape(span_text),
                    canonical,
                    result,
                    flags=re.IGNORECASE,
                    count=1
                )

    return result.strip()


def _build_context_window(segments: list, claim_start: float) -> dict:
    """
    Gathers transcript segments from (claim_start - CONTEXT_WINDOW_SECONDS)
    to claim_start, extracts named entities via spaCy NER, and returns:
      contextText:     the preceding prose
      contextEntities: deduplicated named entities from the context
      topicSummary:    top 3 priority entities joined as a string
    """
    window_start = max(0.0, claim_start - CONTEXT_WINDOW_SECONDS)
    window_segs  = [
        s for s in segments
        if s.get("end", 0) >= window_start and s.get("start", 0) < claim_start
    ]
    context_text = " ".join(s.get("text", "") for s in window_segs).strip()

    context_entities: list = []
    topic_summary = ""

    if nlp and context_text:
        ctx_doc = nlp(context_text)
        priority_labels = {"PERSON", "ORG", "GPE", "EVENT", "DATE", "LOC",
                           "FAC", "NORP", "LAW"}
        seen = set()
        priority, other = [], []
        for ent in ctx_doc.ents:
            key = ent.text.lower()
            if key in seen:
                continue
            seen.add(key)
            (priority if ent.label_ in priority_labels else other).append(ent.text)

        context_entities = priority + other
        topic_summary    = ", ".join(priority[:3])

    return {
        "contextText":     context_text,
        "contextEntities": context_entities,
        "topicSummary":    topic_summary,
    }


def _ground_vague_subject(structured_claim: str, context_entities: list) -> str:
    """
    If the claim begins with a vague subject AND context provides concrete
    named entities, prepend those entities to ground the subject.

    "The riots were orchestrated" + ["January 6","Capitol"]
    → "January 6 Capitol riots were orchestrated"
    """
    if not context_entities:
        return structured_claim

    VAGUE_SUBJECT = re.compile(
        r"^(the riots?|the protests?|the attack|the shooting|the incident|"
        r"the event|the conflict|the war|the crisis|the situation|the case|"
        r"the scandal|the election|the vote|the decision|the policy|the law|"
        r"the bill|the act|the deal|the agreement|the movement|the group|"
        r"they|it|this|that|these|those)",
        re.IGNORECASE
    )

    if VAGUE_SUBJECT.match(structured_claim.strip()):
        grounding = " ".join(context_entities[:2])
        enriched = VAGUE_SUBJECT.sub(
            lambda m: f"{grounding} {m.group(0).lower()}",
            structured_claim.strip(),
            count=1
        )
        return enriched.strip()

    return structured_claim


@app.route("/resolve_context", methods=["POST"])
def resolve_context():
    """
    Input:
    {
      "claims":   [ExtractedClaim, ...],
      "segments": [TranscriptSegment, ...]   <- full transcript with timestamps
    }

    Output:
    {
      "enrichedClaims": [
        {
          ...original claim fields...,
          "resolvedClaim":    "January 6 Capitol riots were orchestrated",
          "contextText":      "...90 seconds of preceding transcript...",
          "contextEntities":  ["January 6", "Capitol", "Donald Trump"],
          "topicSummary":     "January 6, Capitol, Donald Trump",
          "enrichedQuery":    "January 6 Capitol riots orchestrated"
        }
      ]
    }

    Performance design:
      - fastcoref runs ONCE on the full transcript (capped at 50k chars to
        prevent it stalling on very long videos).
      - spaCy NER runs ONCE per unique context window text via nlp.pipe()
        batch processing — NOT once per claim. This is the main fix for the
        120s timeout: previously nlp() was called serially for every claim.
      - All per-claim work after that is pure Python (dict lookups, string ops).
    """
    data = request.get_json()
    if not data or "claims" not in data or "segments" not in data:
        return jsonify({"error": "Missing 'claims' or 'segments'"}), 400

    claims   = data["claims"]
    segments = data["segments"]

    if not claims:
        return jsonify({"enrichedClaims": []})

    # ── Build full transcript text with character-offset tracking ──────────
    text_parts: list  = []
    seg_offsets: list = []   # (char_start, seg_time_start)
    char_pos          = 0

    for seg in segments:
        seg_text = seg.get("text", "")
        seg_offsets.append((char_pos, seg.get("start", 0.0)))
        text_parts.append(seg_text)
        char_pos += len(seg_text) + 1   # +1 for the joining space

    full_text = " ".join(text_parts)

    # Cap fastcoref input — it handles ~50k chars comfortably on 8 GB VRAM;
    # beyond that inference time grows non-linearly and risks the timeout.
    # Coreference across the truncated portion degrades gracefully since
    # we still resolve everything within the first ~45 minutes of speech.
    COREF_CHAR_LIMIT = 50_000
    coref_text = full_text[:COREF_CHAR_LIMIT]

    # ── Run fastcoref ONCE on the (capped) transcript ─────────────────────
    coref_clusters: list = []
    model = get_fastcoref_model()
    if model and coref_text.strip():
        try:
            logging.info(
                f"[ResolveContext] fastcoref on {len(coref_text)} chars "
                f"({'truncated' if len(full_text) > COREF_CHAR_LIMIT else 'full'})"
            )
            preds = model.predict(texts=[coref_text])
            raw_clusters = preds[0].get_clusters(as_strings=False)
            coref_clusters = [list(cluster) for cluster in raw_clusters]
            logging.info(f"[ResolveContext] {len(coref_clusters)} coref clusters")
        except Exception as e:
            logging.warning(f"[ResolveContext] fastcoref error: {e} — skipping coref")

    # ── Build timestamp → char-offset lookup (binary-search style) ────────
    # seg_offsets is already sorted by char_pos asc (= time asc).
    # For each claim timestamp we want the largest seg_time <= claim_start.
    def timestamp_to_char_offset(claim_start: float) -> int:
        result = 0
        for (char_start, seg_time) in seg_offsets:
            if seg_time <= claim_start:
                result = char_start
            else:
                break
        return result

    # ── Collect unique context window texts for batch spaCy NER ───────────
    # _build_context_window_text() returns just the raw text string without
    # running NLP — we gather all unique texts first then batch-process them.
    def collect_context_text(claim_start: float) -> str:
        window_start = max(0.0, claim_start - CONTEXT_WINDOW_SECONDS)
        window_segs  = [
            s for s in segments
            if s.get("end", 0) >= window_start and s.get("start", 0) < claim_start
        ]
        return " ".join(s.get("text", "") for s in window_segs).strip()

    # Map from context_text → NER result, built once via nlp.pipe()
    claim_context_texts = [collect_context_text(c.get("start", 0.0)) for c in claims]
    unique_texts        = list(dict.fromkeys(t for t in claim_context_texts if t))

    ner_cache: dict = {}   # context_text → {"contextEntities": [...], "topicSummary": "..."}
    if nlp and unique_texts:
        priority_labels = {"PERSON", "ORG", "GPE", "EVENT", "DATE", "LOC",
                           "FAC", "NORP", "LAW"}
        logging.info(
            f"[ResolveContext] spaCy NER on {len(unique_texts)} unique context windows "
            f"(batch, not per-claim)"
        )
        # nlp.pipe processes all texts in a single batched pass — far faster
        # than calling nlp() individually for each claim's context window.
        for text, doc in zip(unique_texts, nlp.pipe(unique_texts, batch_size=32)):
            seen      = set()
            priority  = []
            other     = []
            for ent in doc.ents:
                key = ent.text.lower()
                if key in seen:
                    continue
                seen.add(key)
                (priority if ent.label_ in priority_labels else other).append(ent.text)
            ner_cache[text] = {
                "contextEntities": priority + other,
                "topicSummary":    ", ".join(priority[:3]),
            }

    # ── Enrich each claim (pure Python after this point) ──────────────────
    enriched_claims = []

    for claim, ctx_text in zip(claims, claim_context_texts):
        claim_start       = claim.get("start", 0.0)
        claim_char_offset = timestamp_to_char_offset(claim_start)

        # 1. Coreference resolution
        structured = claim.get("structuredClaim") or claim.get("originalText", "")
        resolved   = _apply_coref_clusters(
            structured, coref_clusters, coref_text, claim_char_offset
        )

        # 2. Context entities from cache (no spaCy call here)
        ner_result      = ner_cache.get(ctx_text, {"contextEntities": [], "topicSummary": ""})
        context_entities = ner_result["contextEntities"]
        topic_summary    = ner_result["topicSummary"]

        # 3. Vague-subject grounding
        enriched_structured = _ground_vague_subject(resolved, context_entities)

        # 4. Build enriched search query
        all_entities   = list(dict.fromkeys(
            claim.get("entities", []) + context_entities
        ))
        enriched_query = _build_search_query(enriched_structured, all_entities)

        enriched_claims.append({
            **claim,
            "resolvedClaim":   enriched_structured,
            "contextText":     ctx_text,
            "contextEntities": context_entities,
            "topicSummary":    topic_summary,
            "enrichedQuery":   enriched_query,
        })

    logging.info(f"[ResolveContext] Enriched {len(enriched_claims)} claims")
    return jsonify({"enrichedClaims": enriched_claims})


# =============================================================================
# STAGE 3 — CLAIM EXTRACTION (spaCy dependency parser)
# =============================================================================

@app.route("/extract_claims", methods=["POST"])
def extract_claims():
    """
    Input:  { "sentences": [ClassifiedSentence, ...], "claim_mode": "facts_and_opinions" | "facts_only" }
            Receives facts, uncertain, AND opinion sentences from the orchestrator.
            When claim_mode is "facts_only", opinion-typed sentences are dropped
            before structural filtering so they never enter the search/verdict stages.
    Output: { "claims": [ExtractedClaim, ...] }
    """
    data = request.get_json()
    if not data or "sentences" not in data:
        return jsonify({"error": "Missing 'sentences'"}), 400
    if not nlp:
        return jsonify({"error": "spaCy not available"}), 503

    # "facts_only" drops opinion-typed sentences before any further processing.
    # "facts_and_opinions" (default) keeps everything and lets the LLM handle
    # opinion framing via the dedicated prompt pathway.
    claim_mode = data.get("claim_mode", "facts_and_opinions")
    facts_only = claim_mode == "facts_only"

    SKIP_PATTERNS = re.compile(
        r"^(yeah|yes|no|okay|ok|right|sure|absolutely|exactly|definitely|"
        r"of course|i agree|i disagree|thank you|thanks|hello|hi|bye|"
        r"welcome back|stay tuned|subscribe|like and subscribe|"
        r"you know what i mean|what do you think)[.!,]?$",
        re.IGNORECASE
    )

    claims = []
    skipped_opinions = 0
    for sent in data["sentences"]:
        text = sent.get("text","").strip()
        if not text:
            continue
        if SKIP_PATTERNS.match(text):
            continue

        # Drop opinion sentences when the user chose Facts Only mode
        if facts_only and sent.get("type") == "opinion":
            skipped_opinions += 1
            continue

        doc = nlp(text)

        has_subject = any(t.dep_ in ("nsubj","nsubjpass","csubj") for t in doc)
        has_verb    = any(t.pos_ in ("VERB","AUX") for t in doc)
        word_count  = len([t for t in doc if not t.is_punct and not t.is_space])

        if not (has_subject and has_verb):
            continue
        if word_count < 4:
            continue
        # Reject over-long segments — anything above 60 words is almost certainly
        # multiple sentences merged together by the transcriber, not a single
        # verifiable claim. Searching a 100-word paragraph produces useless queries.
        if word_count > 60:
            continue
        if text.strip().endswith("?"):
            continue

        entities   = [ent.text for ent in doc.ents]
        has_entity = len(entities) > 0
        has_number = any(t.like_num or t.pos_ == "NUM" for t in doc)

        # Normalise to 3rd-person neutral
        structured = re.sub(r"\bI\b", "the speaker", text)
        structured = re.sub(r"\bmy\b",  "their", structured, flags=re.IGNORECASE)
        structured = re.sub(r"\bwe\b",  "they",  structured, flags=re.IGNORECASE)
        structured = re.sub(r"\bour\b", "their", structured, flags=re.IGNORECASE)
        structured = re.sub(
            r"\s+(right|you know|okay|so|well|i mean|basically)[,.]?$",
            "", structured.strip(), flags=re.IGNORECASE
        ).strip()

        sentence_type = sent.get("type","uncertain")

        claims.append({
            "originalText":    text,
            "structuredClaim": structured,
            "start":           sent.get("start", 0.0),
            "end":             sent.get("end", 0.0),
            "entities":        entities,
            "hasNamedEntity":  has_entity,
            "hasNumber":       has_number,
            "sentenceType":    sentence_type,
        })

    logging.info(
        f"[ExtractClaims] {len(claims)} claims from {len(data['sentences'])} sentences "
        f"(mode={claim_mode}, "
        f"facts: {sum(1 for c in claims if c['sentenceType']=='fact')}, "
        f"opinions: {sum(1 for c in claims if c['sentenceType']=='opinion')}, "
        f"uncertain: {sum(1 for c in claims if c['sentenceType']=='uncertain')}, "
        f"skipped_opinions: {skipped_opinions})"
    )
    return jsonify({"claims": claims})


# =============================================================================
# STAGE 4 — WEB SEARCH (Serper.dev / DuckDuckGo fallback)
# =============================================================================

AUTHORITATIVE_DOMAINS = [
    "wikipedia.org", ".gov", ".edu", "reuters.com", "bbc.com", "apnews.com",
    "nature.com", "science.org", "pubmed.ncbi", "snopes.com", "factcheck.org",
    "politifact.com", "theguardian.com", "nytimes.com", "washingtonpost.com",
]


def _relevance_score(url: str, title: str, snippet: str,
                     entities: list, position: int) -> float:
    score = 10.0 - position * 1.5
    text = f"{title} {snippet}".lower()
    for entity in entities:
        if entity.lower() in text:
            score += 2.0
    for domain in AUTHORITATIVE_DOMAINS:
        if domain in url.lower():
            score += 3.0
            break
    return round(score, 2)


def _build_search_query(claim: str, entities: list) -> str:
    """
    Builds a precise, fact-checking-optimised Google search query for Serper.

    Philosophy (Serper has no ratelimit — use full queries):
      Google handles natural language well. A full, specific claim phrase
      surfaced as a query returns far more relevant fact-checking sources
      than a 2-word entity fragment.

    Strategy (in priority order):
      1. Named entities + the verb phrase from the claim → most precise
         e.g. "Pokemon Prismatic Evolutions release date 2026"
      2. Full cleaned claim with filler stripped → covers everything else
         e.g. "there were 500 Pokemon in the original game"
      3. Append "fact check" when the claim is opinion-framed, to surface
         fact-checking sites (Snopes, PolitiFact, FactCheck.org) directly.

    Cap at 120 chars — Google handles long queries fine, but beyond ~120
    chars additional words are often ignored anyway.
    """
    FILLER = re.compile(
        r"\b(um|uh|like|you know|i mean|basically|literally|actually|"
        r"right|okay|so|the speaker|i think|i believe|i feel|"
        r"in my opinion|personally|you see|look|listen|honestly)\b",
        re.IGNORECASE
    )
    # Strip filler words and normalise whitespace
    cleaned = FILLER.sub("", claim).strip()
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()

    # Detect opinion framing — append "fact check" to route to fact-checking sites
    OPINION_SIGNALS = re.compile(
        r"\b(should|must|need to|have to|ought to|always|never|everyone|"
        r"nobody|best|worst|greatest|most|least|totally|completely|"
        r"obviously|clearly|definitely|certainly)\b",
        re.IGNORECASE
    )
    append_fact_check = bool(OPINION_SIGNALS.search(cleaned))

    if entities:
        # Strategy 1: entities + key verb/number phrase from the claim
        # Use up to 4 entities for Serper (Google handles more terms well)
        entity_part = " ".join(entities[:4])

        # Extract the most searchable fragment from the claim:
        # numbers, years, percentages, and strong action verbs
        key_words = re.findall(
            r"\b(\d{4}|\d+(?:\.\d+)?\s?(?:percent|%|million|billion|"
            r"thousand|hundred)|founded|born|died|created|located|invented|"
            r"established|won|built|orchestrated|caused|linked|responsible|"
            r"released|launched|announced|confirmed|banned|arrested|"
            r"defeated|discovered|killed|injured|signed|passed|failed|"
            r"increased|decreased|reached|exceeded|broke|set|holds|"
            r"owns|controls|runs|leads|beats|loses|costs|worth|sold|"
            r"released|premiered|broadcast|aired|published|reported)\b",
            cleaned, re.IGNORECASE
        )
        if key_words:
            # Entity + key action/number = most precise possible query
            verb_part = " ".join(dict.fromkeys(key_words[:2]))  # deduplicated
            query = f"{entity_part} {verb_part}"
        else:
            # No key verb found — use entity + a short noun phrase from claim
            # Strip the entities themselves from cleaned to get the predicate
            predicate = cleaned
            for ent in entities[:4]:
                predicate = re.sub(re.escape(ent), "", predicate,
                                   flags=re.IGNORECASE)
            predicate = re.sub(r"\s{2,}", " ", predicate).strip()
            # Take up to 6 predicate words
            pred_words = predicate.split()[:6]
            query = f"{entity_part} {' '.join(pred_words)}".strip()
    else:
        # Strategy 2: no entities — use the full cleaned claim
        # This handles generic claims like "the economy is failing"
        query = cleaned

    # Append fact check signal for opinion-framed claims
    if append_fact_check and "fact check" not in query.lower():
        query = f"{query} fact check"

    query = query.strip()

    # Final cap — 120 chars is the sweet spot for Google precision
    if len(query) > 120:
        # Try to break at a word boundary
        truncated = query[:120]
        last_space = truncated.rfind(" ")
        query = truncated[:last_space] if last_space > 60 else truncated

    return query or claim[:120]


@app.route("/search", methods=["POST"])
def search():
    """
    Input:  {
              "claim":          "structured claim text",
              "entities":       ["entity1", ...],
              "contextEntities":["entity1", ...],
              "enrichedQuery":  "pre-built enriched query"
            }
    Output: { "evidence": [{ "url", "title", "snippet", "relevanceScore" }, ...],
              "provider":  "serper" | "duckduckgo" }

    Search priority:
      1. Serper.dev  — real Google results, fast, reliable (if SERPER_API_KEY is set)
      2. DuckDuckGo  — fallback if Serper key missing or request fails
    """
    data = request.get_json()
    if not data or "claim" not in data:
        return jsonify({"error": "Missing 'claim'"}), 400

    enriched_query   = data.get("enrichedQuery", "")
    claim            = data.get("claim", "")
    entities         = data.get("entities", [])
    context_entities = data.get("contextEntities", [])
    all_entities     = list(dict.fromkeys(entities + context_entities))

    # Serper handles long queries well — use the full enriched query
    # (was capped at 50 for DDG, no longer needed)
    query = enriched_query if enriched_query else _build_search_query(claim, all_entities)
    # Still apply the 120-char cap for sanity
    if len(query) > 120:
        query = query[:query.rfind(' ', 0, 120)] or query[:120]
    logging.info(f"[Search] Query: '{query}'")

    # ── Serper.dev (primary) ───────────────────────────────────────────────
    if SERPER_AVAILABLE:
        try:
            resp = req_lib.post(
                SERPER_ENDPOINT,
                headers={
                    "X-API-KEY":    SERPER_API_KEY,
                    "Content-Type": "application/json",
                },
                json={"q": query, "num": 8},
                timeout=15,
            )
            resp.raise_for_status()
            raw = resp.json().get("organic", [])

            results = []
            for i, r in enumerate(raw):
                url     = r.get("link", "")
                title   = r.get("title", "")
                snippet = r.get("snippet", "")
                results.append({
                    "url":            url,
                    "title":          title,
                    "snippet":        snippet,
                    "relevanceScore": _relevance_score(url, title, snippet, all_entities, i),
                })

            results.sort(key=lambda x: x["relevanceScore"], reverse=True)
            logging.info(f"[Search] Serper: {len(results)} results")
            return jsonify({"evidence": results[:5], "provider": "serper"})

        except Exception as e:
            logging.warning(f"[Search] Serper error: {e} — falling back to DuckDuckGo")

    # ── DuckDuckGo (fallback) ──────────────────────────────────────────────
    if not DDG_AVAILABLE:
        return jsonify({"evidence": [], "warning": "No search provider available"}), 503

    try:
        results = []
        with DDGS() as ddgs:
            for i, r in enumerate(ddgs.text(query, max_results=6)):
                url     = r.get("href", "")
                title   = r.get("title", "")
                snippet = r.get("body", "")
                results.append({
                    "url":            url,
                    "title":          title,
                    "snippet":        snippet,
                    "relevanceScore": _relevance_score(url, title, snippet, all_entities, i),
                })

        results.sort(key=lambda x: x["relevanceScore"], reverse=True)
        logging.info(f"[Search] DDG fallback: {len(results)} results")
        return jsonify({"evidence": results[:3], "provider": "duckduckgo"})

    except Exception as e:
        logging.warning(f"[Search] DDG error: {e}")
        return jsonify({"evidence": [], "warning": str(e)})


# =============================================================================
# VRAM MANAGEMENT — called by Node orchestrator between heavy stages
# =============================================================================

@app.route("/release_vram", methods=["POST"])
def release_vram():
    """
    Releases CUDA memory held by Whisper and fastcoref so Ollama can use the
    full 8 GB VRAM during verdict synthesis.

    Called by the Node pipeline after the resolve_context stage completes
    and before the first /verdict call. Without this, Whisper (~500 MB) and
    fastcoref (~500 MB) stay resident in VRAM and force Ollama to split the
    llama3 model between GPU and CPU RAM, which is dramatically slower.

    The models are NOT unloaded from Python memory — they stay loaded and
    will reclaim VRAM instantly when needed again on the next request.
    Only the CUDA cache (unused allocated blocks) is freed.
    """
    freed_mb = 0
    if torch.cuda.is_available():
        before = torch.cuda.memory_allocated() / 1024 / 1024
        torch.cuda.empty_cache()          # release unoccupied cached blocks
        torch.cuda.synchronize()          # wait for all CUDA ops to finish
        after  = torch.cuda.memory_allocated() / 1024 / 1024
        freed_mb = round(before - after, 1)
        logging.info(f"[VRAM] Released {freed_mb} MB — "
                     f"{round(after, 1)} MB still allocated")
    else:
        logging.info("[VRAM] CUDA not available — nothing to release")

    return jsonify({
        "freed_mb":      freed_mb,
        "cuda_available": torch.cuda.is_available(),
    })


# =============================================================================
# STAGE 5 — VERDICT SYNTHESIS (Ollama)
# =============================================================================

@app.route("/verdict", methods=["POST"])
def verdict():
    """
    Input:  {
              "claim":    EnrichedClaim,      <- now includes contextText
              "evidence": [SearchEvidence, ...]
            }
    Output: { "verdict", "confidence", "explanation", "correctedFact" }
    """
    data = request.get_json()
    if not data or "claim" not in data:
        return jsonify({"error": "Missing 'claim'"}), 400

    claim    = data["claim"]
    evidence = data.get("evidence", [])

    evidence_text = (
        "No web evidence was found for this claim."
        if not evidence else
        "\n\n".join(
            f"[Source {i+1}] {e.get('title','')}\n"
            f"URL: {e.get('url','')}\n"
            f"Snippet: {e.get('snippet','')}"
            for i, e in enumerate(evidence)
        )
    )

    # Pull the context window — this is the key new addition to the prompt.
    # The LLM now knows WHAT the speaker was discussing before making the claim.
    context_text  = claim.get("contextText", "").strip()
    topic_summary = claim.get("topicSummary", "").strip()
    sentence_type = claim.get("sentenceType", "uncertain")

    # Build the context block for the prompt
    if context_text:
        context_block = (
            f"TOPIC CONTEXT (what the speaker was discussing before this statement):\n"
            f"{context_text[-800:]}\n\n"   # last 800 chars = most relevant
            f"KEY ENTITIES IN CONTEXT: {topic_summary or 'none identified'}\n"
        )
    else:
        context_block = "TOPIC CONTEXT: Not available.\n"

    if sentence_type == "opinion":
        claim_framing = (
            "The speaker expressed this as a personal opinion or belief. "
            "Check whether the UNDERLYING FACTUAL PREMISE is supported or "
            "contradicted by evidence. Do not say 'this is just an opinion' — "
            "evaluate the factual basis."
        )
    else:
        claim_framing = "The speaker stated this as a fact. Check its accuracy."

    # Use the resolved/enriched claim for evaluation, not the raw original
    claim_to_check = (
        claim.get("resolvedClaim") or
        claim.get("structuredClaim") or
        claim.get("originalText", "")
    )

    prompt = f"""You are a professional fact-checker with access to context about what the speaker was discussing.

STATEMENT TYPE: {sentence_type.upper()}
FRAMING: {claim_framing}

{context_block}
CLAIM TO VERIFY: "{claim_to_check}"
ORIGINAL QUOTE: "{claim.get('originalText', '')}"

EVIDENCE FROM WEB SEARCH:
{evidence_text}

Use the TOPIC CONTEXT to understand what the speaker was referring to before evaluating the claim.
For example, if the context mentions "January 6 Capitol riot" and the claim says "the riots were orchestrated",
evaluate the specific claim that the January 6 Capitol riot was orchestrated.

Respond with ONLY a JSON object (no markdown, no text outside the JSON):
{{
  "verdict": "TRUE" or "FALSE" or "PARTIALLY_TRUE" or "UNVERIFIABLE",
  "confidence": <integer 0-100>,
  "explanation": "<2-3 sentences. Reference the context and cite sources by number.>",
  "correctedFact": "<accurate version if FALSE or PARTIALLY_TRUE, else null>"
}}

Verdict guide:
- TRUE: evidence clearly supports the claim in context
- FALSE: evidence clearly contradicts it
- PARTIALLY_TRUE: some truth but exaggerated, missing context, or outdated
- UNVERIFIABLE: no usable evidence, or claim is purely subjective with no factual premise"""

    model = _get_ollama_model()
    # Free CUDA cache before calling Ollama — gives it maximum VRAM headroom.
    # This is a no-op if release_vram was already called by the orchestrator.
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    logging.info(f"[Verdict] Ollama ({model}): '{claim_to_check[:60]}'")

    try:
        resp = req_lib.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model":   model,
                "stream":  False,
                "options": {"temperature": 0.1, "num_predict": 450},
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a professional fact-checker. "
                            "Always respond with ONLY a valid JSON object. "
                            "Never include markdown, code fences, or any text outside the JSON."
                        )
                    },
                    {"role": "user", "content": prompt}
                ]
            },
            timeout=180,
        )
        resp.raise_for_status()

        raw     = resp.json().get("message", {}).get("content", "")
        cleaned = re.sub(r"```json\n?|```\n?", "", raw).strip()
        m       = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not m:
            raise ValueError(f"No JSON in model response: {raw[:200]}")

        parsed = json.loads(m.group())
        return jsonify({
            "verdict":       parsed.get("verdict", "UNVERIFIABLE"),
            "confidence":    int(parsed.get("confidence", 0)),
            "explanation":   parsed.get("explanation", ""),
            "correctedFact": parsed.get("correctedFact"),
        })

    except req_lib.exceptions.ConnectionError:
        msg = "Ollama is not running. Start it with: ollama serve"
        logging.error(f"[Verdict] {msg}")
        return jsonify({"verdict": "UNVERIFIABLE", "confidence": 0,
                        "explanation": msg, "correctedFact": None})
    except req_lib.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        if status == 404:
            msg = f"Ollama model not found. Run: ollama pull {OLLAMA_MODEL}"
        else:
            msg = f"Ollama HTTP error {status}: {e}"
        logging.error(f"[Verdict] {msg}")
        return jsonify({"verdict": "UNVERIFIABLE", "confidence": 0,
                        "explanation": msg, "correctedFact": None})
    except Exception as e:
        logging.exception("[Verdict] Error")
        return jsonify({"verdict": "UNVERIFIABLE", "confidence": 0,
                        "explanation": f"Verdict failed: {e}", "correctedFact": None})


# =============================================================================
# STAGE 0 — VIDEO DOWNLOAD (yt-dlp)
# =============================================================================

DOWNLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")


@app.route("/download", methods=["POST"])
def download_video():
    """
    Input:  { "url": "https://...", "video_id": "uuid" }
    Output: { "mp4_path", "title", "duration", "platform" }
    """
    data = request.get_json()
    if not data or "url" not in data:
        return jsonify({"error": "Missing 'url'"}), 400
    if not YTDLP_AVAILABLE:
        return jsonify({"error": "yt-dlp not installed"}), 503

    url      = data["url"].strip()
    video_id = data.get("video_id", str(uuid.uuid4()))
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    final_mp4    = os.path.join(DOWNLOAD_DIR, f"{video_id}.mp4")

    logging.info(f"[Download] Starting: {url}")

    try:
        ydl_opts = {
            "outtmpl": os.path.join(DOWNLOAD_DIR, f"{video_id}.%(ext)s"),
            "format": "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
            "merge_output_format": "mp4",
            "noplaylist": True,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

        if not os.path.exists(final_mp4):
            candidates = [f for f in os.listdir(DOWNLOAD_DIR) if f.startswith(video_id)]
            if not candidates:
                raise FileNotFoundError(f"Downloaded file not found for id {video_id}")
            candidate_path = os.path.join(DOWNLOAD_DIR, candidates[0])
            if candidates[0].endswith(".mp4"):
                final_mp4 = candidate_path
            else:
                result = subprocess.run(
                    ["ffmpeg", "-i", candidate_path, "-c:v", "copy", "-c:a", "aac", "-y", final_mp4],
                    capture_output=True, text=True
                )
                if result.returncode != 0:
                    raise RuntimeError(f"FFmpeg conversion failed: {result.stderr[-300:]}")
                os.remove(candidate_path)

        title    = info.get("title", "Unknown") if info else "Unknown"
        duration = float(info.get("duration") or 0) if info else 0.0
        platform = info.get("extractor_key", "unknown").lower() if info else "unknown"

        logging.info(f"[Download] Done → {final_mp4} ({duration:.0f}s, {platform})")
        return jsonify({
            "mp4_path": os.path.abspath(final_mp4),
            "title":    title,
            "duration": duration,
            "platform": platform,
        })

    except yt_dlp.utils.DownloadError as e:
        err = str(e)
        logging.error(f"[Download] yt-dlp error: {err}")
        if "Private video" in err or "private" in err.lower():
            msg = "This video is private and cannot be downloaded."
        elif "not available" in err.lower():
            msg = "This video is not available (geo-restricted or deleted)."
        elif "Sign in" in err or "login" in err.lower():
            msg = "This video requires login to access."
        elif "duration" in err.lower():
            msg = "Video is too long (max 60 minutes)."
        else:
            msg = f"Could not download video: {err[:200]}"
        return jsonify({"error": msg}), 422

    except Exception as e:
        logging.exception("[Download] Unexpected error")
        return jsonify({"error": f"Download failed: {str(e)}"}), 500


# =============================================================================
# HEALTH CHECK
# =============================================================================

@app.route("/health", methods=["GET"])
def health():
    ollama_ok, ollama_models = False, []
    try:
        r = req_lib.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3)
        if r.status_code == 200:
            ollama_ok     = True
            ollama_models = [m["name"] for m in r.json().get("models", [])]
    except Exception:
        pass

    return jsonify({
        "status": "ok",
        "components": {
            "whisper":              WHISPER_AVAILABLE,
            "whisper_model_loaded": whisper_model is not None,
            "whisper_model_size":   WHISPER_MODEL_SIZE,
            "spacy":                SPACY_AVAILABLE,
            "flair":                FLAIR_AVAILABLE,
            "fastcoref":            FASTCOREF_AVAILABLE,
            "fastcoref_model_loaded":fastcoref_model is not None,
            "serper":               SERPER_AVAILABLE,
            "duckduckgo":           DDG_AVAILABLE,
            "ytdlp":                YTDLP_AVAILABLE,
            "ollama":               ollama_ok,
            "ollama_model":         OLLAMA_MODEL,
            "ollama_models":        ollama_models,
            "cuda_available":       torch.cuda.is_available(),
            "vram_allocated_mb":    round(torch.cuda.memory_allocated() / 1024 / 1024, 1)
                                    if torch.cuda.is_available() else 0,
        }
    })


if __name__ == "__main__":
    logging.info("Pre-loading Whisper model on startup...")
    get_whisper_model()
    logging.info("Pre-loading fastcoref model on startup...")
    get_fastcoref_model()
    logging.info("All models ready. Starting Flask on :5001")
    app.run(host="0.0.0.0", port=5001, debug=False)