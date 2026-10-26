// Public API — pipeline functions for programmatic use

export { computeClusterOverlap, runBenchmark } from "./benchmark.js";
export { selectCanonical } from "./canonical.js";
export { findDuplicateClusters } from "./cluster.js";
export type { Confidence } from "./confidence.js";
export {
  CONFIDENCE_HIGH_MIN,
  CONFIDENCE_SOLID_MIN,
  confidenceTier,
} from "./confidence.js";
export { getRepos, getVisionDoc, loadConfig, loadEnvConfig, parseRepo } from "./config.js";
export type {
  AdvisoryRoutingDecision,
  CategoryDecision,
  ChoiceAnswer,
  ChoiceQuestionDef,
  DecisionAnswer,
  DecisionConfig,
  DecisionProvenance,
  DecisionProvider,
  DecisionQuestionDef,
  DecisionQuestions,
  DecisionRequest,
  DecisionRequestOptions,
  DecisionResult,
  EvaluateItemOptions,
  GenericTechnicalDomain,
  ItemTypeDecision,
  JevProviderConfig,
  MockProviderOptions,
  NoulAnswer,
  NoulQuestionDef,
  RoutingThresholds,
  SanitizeOptions,
  ScoreAnswer,
  ScoreQuestionDef,
  TechnicalDomainDecision,
  TriageDecisionReport,
} from "./decisions/index.js";
// Typed Decision Layer (Phase 1)
export {
  computeDecisionIdentity,
  computeRubricHash,
  createDecisionProvider,
  DEFAULT_JEV_MODEL,
  DEFAULT_MAX_BODY,
  DEFAULT_MAX_TITLE,
  DEFAULT_ROUTING_THRESHOLDS,
  DisabledDecisionProvider,
  evaluateItemDecisions,
  GENERIC_TECHNICAL_DOMAINS,
  JevDecisionProvider,
  MockDecisionProvider,
  PR_PRISM_TECHNICAL_DOMAINS,
  sanitizeItemForDecision,
  sanitizeUntrustedText,
  TRIAGE_QUESTIONS,
  TRIAGE_SCHEMA_VERSION,
  validateDecisionAnswer,
  validateDecisionAnswers,
} from "./decisions/index.js";
export { createEmbeddingProvider, prepareEmbeddingText } from "./embeddings.js";
export { classifyFetchError, classifyHttpError, ProviderError } from "./errors.js";
export { GitHubClient } from "./github.js";
export type { PipelineContext } from "./pipeline.js";
export {
  createPipelineContext,
  parseDuration,
  resolveRepos,
  runCompare,
  runDupes,
  runDupesMulti,
  runRank,
  runScan,
  runVision,
} from "./pipeline.js";
export { buildScorerContext, rankPRs, scorePR } from "./scorer.js";
export { cosineSimilarity, isZeroVector } from "./similarity.js";
export { VectorStore } from "./store.js";
export type {
  Cluster,
  EmbeddingProvider,
  PRItem,
  RateLimitInfo,
  ScoredPR,
  ScoreSignals,
  StoreItem,
  VisionScore,
} from "./types.js";
export { checkVisionAlignment, loadAndEmbedVisionDoc, scoreVisionAlignment } from "./vision.js";
