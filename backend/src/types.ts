export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface ClassifiedSentence {
  text: string;
  start: number;
  end: number;
  type: "fact" | "opinion" | "uncertain";
  confidence: number;
  entities: string[];
  rule_signals: string[];
}

export interface ExtractedClaim {
  originalText: string;
  structuredClaim: string;
  start: number;
  end: number;
  entities: string[];
  sentenceType?: "fact" | "opinion" | "uncertain";
  hasNamedEntity?: boolean;
  hasNumber?: boolean;
  // Context resolution fields (added by /resolve_context stage)
  resolvedClaim?: string;      // pronoun-resolved version of structuredClaim
  contextText?: string;        // 90s of preceding transcript
  contextEntities?: string[];  // named entities found in contextText
  topicSummary?: string;       // top 3 context entities for display
  enrichedQuery?: string;      // pre-built search query with context
}

export interface SearchEvidence {
  url: string;
  title: string;
  snippet: string;
  relevanceScore: number;
}

export interface Verdict {
  claim: ExtractedClaim;
  verdict: "TRUE" | "FALSE" | "UNVERIFIABLE" | "PARTIALLY_TRUE";
  confidence: number;
  explanation: string;
  evidence: SearchEvidence[];
  correctedFact?: string;
}

export interface AnalysisResult {
  videoId: string;
  duration: number;
  sourceUrl?: string;
  sourceTitle?: string;
  sourcePlatform?: string;
  transcript: TranscriptSegment[];
  classifiedSentences: ClassifiedSentence[];
  claims: ExtractedClaim[];
  verdicts: Verdict[];
  summary: {
    totalSentences: number;
    factCount: number;
    opinionCount: number;
    trueCount: number;
    falseCount: number;
    unverifiableCount: number;
    partiallyTrueCount: number;
  };
}

export interface PipelineStatus {
  stage:
    | "downloading"
    | "extracting"
    | "transcribing"
    | "classifying"
    | "extracting_claims"
    | "resolving_context"  // fastcoref + context window
    | "searching"
    | "verifying"
    | "done"
    | "error";
  progress: number;
  message: string;
}

export interface PartialVerdictsResponse {
  verdicts: Verdict[];
  totalClaims: number;
  done: boolean;
}