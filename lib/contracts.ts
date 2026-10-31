import { z } from "zod";
import { appConfig } from "@/app.config";

/* ── Verdicts ─────────────────────────────────────────────────────────────── */

export const VerdictSchema = z.enum([
  "supported",
  "contradicted",
  "misleading_context",
  "unresolved",
  "not_fact_checkable",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const OverallSchema = z.union([VerdictSchema, z.literal("mixed")]).nullable();
export type Overall = z.infer<typeof OverallSchema>;

/* ── Sources and passages (server-owned, never model-written) ─────────────── */

export const SourceKindSchema = z.enum([
  "news_article",
  "reference", // Wikipedia/MediaWiki
  "fact_check",
  "web_page",
  "user_submitted",
  "feed_item",
]);

export const SourceRecordSchema = z.object({
  id: z.string(),
  url: z.string(),
  canonicalUrl: z.string(),
  title: z.string(),
  publisher: z.string().nullable(),
  publishedAt: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  fetchedAt: z.string(),
  access: z.enum(["full_text", "snippet_only", "blocked", "failed"]),
  accessNote: z.string().nullable(),
  contentHash: z.string().nullable(),
  originGroupId: z.string().nullable(),
  provenanceStatus: z.enum(["established", "possible_shared_origin", "unknown"]),
  provider: z.string(),
  kind: SourceKindSchema,
  /** Wikipedia revision id or similar, when the provider supplies it. */
  revisionId: z.string().nullable(),
  /** Google Fact Check Tools rating, attributed to its publisher. */
  factCheckRating: z
    .object({ publisher: z.string(), rating: z.string(), reviewedClaim: z.string(), reviewDate: z.string().nullable() })
    .nullable(),
  /** Explicit years/dates found in the evidence used, for date-context checks. */
  dateNotes: z.array(z.string()),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const PassageSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  text: z.string(),
  normalizedStart: z.number().int().nonnegative(),
  normalizedEnd: z.number().int().nonnegative(),
  retrievalKind: z.enum(["article_body", "search_snippet", "feed_excerpt"]),
  /** Passage is predominantly an attributed quotation (what someone said). */
  isQuotation: z.boolean(),
  /** Passage contains text addressed to AI systems ("ignore previous instructions…"). */
  suspectedInjection: z.boolean(),
});
export type Passage = z.infer<typeof PassageSchema>;

/* ── Findings ─────────────────────────────────────────────────────────────── */

export const FindingSchema = z.object({
  id: z.string(),
  claim: z.string(),
  verdict: VerdictSchema,
  /** One-sentence finding. Model-written, validated. */
  headline: z.string(),
  explanation: z.string(),
  supportingPassageIds: z.array(z.string()),
  contradictingPassageIds: z.array(z.string()),
  contextPassageIds: z.array(z.string()),
  limitations: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  /** Notes added by server-side validation (e.g. a downgraded verdict). */
  validationNotes: z.array(z.string()),
  /** The label the model proposed, when validation changed it. */
  modelProposedVerdict: VerdictSchema.nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

/* ── Graph ────────────────────────────────────────────────────────────────── */

export const GraphNodeSchema = z.object({
  id: z.string(),
  type: z.enum(["claim", "source", "passage", "origin"]),
  label: z.string(),
  refId: z.string(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  relation: z.enum([
    "contains_passage",
    "supports_claim",
    "contradicts_claim",
    "provides_context",
    "cites_source",
    "exact_duplicate",
    "near_duplicate",
    "possible_shared_origin",
  ]),
  /** How the relationship was established. */
  basis: z.enum(["extraction", "model_inferred", "observed_link", "exact_hash", "text_similarity", "attribution_text"]),
  note: z.string().nullable(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/* ── Investigation result ─────────────────────────────────────────────────── */

export const ModeSchema = z.enum(["live", "demo"]);
export type Mode = z.infer<typeof ModeSchema>;
export const DepthSchema = z.enum(["quick", "deep"]);
export type Depth = z.infer<typeof DepthSchema>;

export const InvestigationResultSchema = z.object({
  id: z.string(),
  mode: ModeSchema,
  origin: z.enum(["fresh_run", "cached_run"]),
  status: z.enum(["complete", "partial", "failed", "cancelled"]),
  statusReason: z.string().nullable(),
  depth: DepthSchema,
  assessedAt: z.string(),
  referenceDate: z.string(),
  referenceTimezone: z.string(),
  originalInput: z.string(),
  inputKind: z.enum(["text", "url"]),
  overall: OverallSchema,
  summary: z.string(),
  findings: z.array(FindingSchema),
  uncheckedClaims: z.array(z.string()),
  assumptions: z.array(z.string()),
  sources: z.array(SourceRecordSchema),
  passages: z.array(PassageSchema),
  coverage: z.object({
    scope: z.enum(["selected_sources", "broader_web"]),
    providersAttempted: z.array(z.string()),
    providersSucceeded: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  graph: z.object({ nodes: z.array(GraphNodeSchema), edges: z.array(GraphEdgeSchema) }),
  model: z.string().nullable(),
  timing: z.object({
    totalMs: z.number(),
    retrievalMs: z.number(),
    inferenceMs: z.number(),
    firstEvidenceMs: z.number().nullable(),
    modelWarm: z.boolean().nullable(),
    llmCalls: z.number().int(),
  }),
  /** For cached results: when the cache entry stops being reused. */
  cacheExpiresAt: z.string().nullable(),
  baseRunId: z.string().nullable(),
});
export type InvestigationResult = z.infer<typeof InvestigationResultSchema>;

/* ── Requests ─────────────────────────────────────────────────────────────── */

export const InvestigateRequestSchema = z.object({
  input: z
    .string()
    .refine((s) => s.trim().length > 0, "Paste a claim, a forward or a news article URL.")
    .refine(
      (s) => s.length <= appConfig.maxInputChars,
      `That is longer than ${appConfig.maxInputChars.toLocaleString("en-IN")} characters. Paste the specific passage you want checked.`,
    ),
  depth: DepthSchema.default("quick"),
  mode: ModeSchema.default("live"),
  referenceTimezone: z.string().default(appConfig.referenceTimezone),
  refresh: z.boolean().default(false),
  /** "Investigate further" reuses the evidence of this run. */
  baseRunId: z.string().max(64).optional(),
  model: z.string().max(80).optional(),
});
export type InvestigateRequest = z.infer<typeof InvestigateRequestSchema>;

export const FollowUpRequestSchema = z.object({
  runId: z.string().max(64),
  question: z
    .string()
    .refine((s) => s.trim().length > 0, "Ask a question about the evidence.")
    .refine((s) => s.length <= appConfig.maxFollowUpChars, `Keep follow-ups under ${appConfig.maxFollowUpChars} characters.`),
});

export const FollowUpResponseSchema = z.object({
  runId: z.string(),
  mode: ModeSchema,
  kind: z.enum(["answer", "needs_new_investigation", "unavailable"]),
  answer: z.string(),
  citedPassageIds: z.array(z.string()),
  suggestedClaim: z.string().nullable(),
  notes: z.array(z.string()),
  inferenceMs: z.number(),
});
export type FollowUpResponse = z.infer<typeof FollowUpResponseSchema>;

/* ── Stream events ────────────────────────────────────────────────────────── */

export const StageSchema = z.enum(["understand", "retrieve", "extract", "compare", "validate"]);
export type Stage = z.infer<typeof StageSchema>;

export const STAGE_LABELS: Record<Stage, string> = {
  understand: "Understanding the claim",
  retrieve: "Searching sources",
  extract: "Reading and linking sources",
  compare: "Comparing evidence",
  validate: "Validating the assessment",
};

const LeadSchema = z.object({
  url: z.string(),
  title: z.string(),
  publisher: z.string().nullable(),
  provider: z.string(),
  publishedAt: z.string().nullable(),
});

export const EventPayloads = {
  started: z.object({
    mode: ModeSchema,
    depth: DepthSchema,
    referenceDate: z.string(),
    referenceTimezone: z.string(),
    providers: z.array(z.object({ id: z.string(), name: z.string() })),
    scope: z.enum(["selected_sources", "broader_web"]),
    cached: z.boolean(),
  }),
  stage_started: z.object({ stage: StageSchema, label: z.string() }),
  stage_completed: z.object({ stage: StageSchema, label: z.string(), detail: z.string().nullable() }),
  claim_identified: z.object({
    index: z.number().int(),
    claim: z.string(),
    checkable: z.boolean(),
    assumptions: z.array(z.string()),
  }),
  source_discovered: LeadSchema,
  source_fetched: z.object({
    sourceId: z.string(),
    url: z.string(),
    title: z.string(),
    publisher: z.string().nullable(),
    access: z.enum(["full_text", "snippet_only", "blocked", "failed"]),
    note: z.string().nullable(),
  }),
  passage_selected: z.object({ passageId: z.string(), sourceId: z.string(), preview: z.string() }),
  provenance_linked: z.object({
    relation: z.enum(["cites_source", "exact_duplicate", "near_duplicate", "possible_shared_origin"]),
    sourceIds: z.array(z.string()),
    message: z.string(),
  }),
  observation: z.object({ message: z.string(), sourceIds: z.array(z.string()) }),
  provider_warning: z.object({ provider: z.string(), code: z.string(), message: z.string() }),
  result: z.object({ result: InvestigationResultSchema }),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
  cancelled: z.object({ reason: z.string() }),
} as const;

export type EventType = keyof typeof EventPayloads;
export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

const envelope = <T extends EventType>(type: T) =>
  z.object({
    runId: z.string(),
    sequence: z.number().int().nonnegative(),
    timestamp: z.string(),
    elapsedMs: z.number().nonnegative(),
    type: z.literal(type),
    payload: EventPayloads[type],
  });

export const InvestigationEventSchema = z.discriminatedUnion("type", [
  envelope("started"),
  envelope("stage_started"),
  envelope("stage_completed"),
  envelope("claim_identified"),
  envelope("source_discovered"),
  envelope("source_fetched"),
  envelope("passage_selected"),
  envelope("provenance_linked"),
  envelope("observation"),
  envelope("provider_warning"),
  envelope("result"),
  envelope("error"),
  envelope("cancelled"),
]);
export type InvestigationEvent = z.infer<typeof InvestigationEventSchema>;

/* ── Model I/O (kept smaller than the result; no URLs, dates or counts) ───── */

export const ModelAssessmentSchema = z.object({
  findings: z
    .array(
      z.object({
        claim_index: z.number().int().min(0).max(4),
        // Order matters: the model lists evidence stances and writes its finding before
        // choosing a label, so the label follows from the cited evidence.
        evidence: z
          .array(
            z.object({
              passage_id: z.string().max(12),
              stance: z.enum(["supports", "contradicts", "context"]),
            }),
          )
          .max(6),
        finding: z.string().min(1).max(220),
        verdict: VerdictSchema,
        explanation: z.string().min(1).max(420),
        limitations: z.array(z.string().max(160)).max(2),
        missing_evidence: z.array(z.string().max(160)).max(2),
      }),
    )
    .min(1)
    .max(3),
});
export type ModelAssessment = z.infer<typeof ModelAssessmentSchema>;

export const ModelPlanSchema = z.object({
  claims: z
    .array(
      z.object({
        claim: z.string().min(3).max(300),
        checkable: z.boolean(),
      }),
    )
    .min(1)
    .max(6),
});
export type ModelPlan = z.infer<typeof ModelPlanSchema>;

export const ModelFollowUpSchema = z.object({
  kind: z.enum(["answer", "new_claim"]),
  answer: z.string().max(1500),
  cited_passage_ids: z.array(z.string().max(12)).max(8),
  new_claim: z.string().max(400),
});
export type ModelFollowUp = z.infer<typeof ModelFollowUpSchema>;

/* ── Health ───────────────────────────────────────────────────────────────── */

export type ProviderStatus = {
  id: string;
  name: string;
  kind: "core" | "optional";
  enabled: boolean;
  note: string;
};

export type HealthReport = {
  app: string;
  ollama: {
    host: string;
    reachable: boolean;
    version: string | null;
    model: string;
    modelInstalled: boolean;
    installedModels: string[];
    thinkingCapable: boolean | null;
    warm: boolean | null;
    message: string | null;
  };
  providers: ProviderStatus[];
  scope: "selected_sources" | "broader_web";
  feedIndex: { entries: number; refreshedAt: string | null };
  dataDir: string;
};
