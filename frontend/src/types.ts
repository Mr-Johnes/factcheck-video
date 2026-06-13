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
  // Context resolution fields
  resolvedClaim?: string;
  contextText?: string;
  contextEntities?: string[];
  topicSummary?: string;
  enrichedQuery?: string;
}

export interface SearchEvidence {
  url: string;
  title: string;
  snippet: string;
  relevanceScore: number;
}

export type VerdictType = "TRUE" | "FALSE" | "PARTIALLY_TRUE" | "UNVERIFIABLE";

export interface Verdict {
  claim: ExtractedClaim;
  verdict: VerdictType;
  confidence: number;
  explanation: string;
  evidence: SearchEvidence[];
  correctedFact?: string;
}

export interface AnalysisSummary {
  totalSentences: number;
  factCount: number;
  opinionCount: number;
  trueCount: number;
  falseCount: number;
  unverifiableCount: number;
  partiallyTrueCount: number;
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
  summary: AnalysisSummary;
}

export type PipelineStage =
  | "downloading"
  | "extracting"
  | "transcribing"
  | "classifying"
  | "extracting_claims"
  | "resolving_context"   // fastcoref + context window
  | "searching"
  | "verifying"
  | "done"
  | "error";

export interface PipelineStatus {
  stage: PipelineStage;
  progress: number;
  message: string;
}