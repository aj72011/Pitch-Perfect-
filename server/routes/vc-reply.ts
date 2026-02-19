import type express from "express";

type Role = "system" | "user" | "assistant";

type HistoryMessage = {
  role: "founder" | "vc" | string;
  content: string;
};

type InputClass = "system_technical" | "startup_content";

// ---------------------------------------------------------------------------
// PitchMemory: lightweight per-session memory to prevent VC question repetition
// ---------------------------------------------------------------------------

type StartupSnapshot = {
  problem: string;
  solution: string;
  icp: string;
  market: string;
  businessModel: string;
  traction: string;
  pricing: string;
  gtm: string;
  moat: string;
  competition: string;
  team: string;
  ask: string;
};

type PitchMemory = {
  startup_snapshot: StartupSnapshot;
  asked_questions: string[];
  asked_topics: string[];
  last_topic: string | null;
};

const EMPTY_SNAPSHOT: StartupSnapshot = {
  problem: "unknown",
  solution: "unknown",
  icp: "unknown",
  market: "unknown",
  businessModel: "unknown",
  traction: "unknown",
  pricing: "unknown",
  gtm: "unknown",
  moat: "unknown",
  competition: "unknown",
  team: "unknown",
  ask: "unknown",
};

function newPitchMemory(): PitchMemory {
  return {
    startup_snapshot: { ...EMPTY_SNAPSHOT },
    asked_questions: [],
    asked_topics: [],
    last_topic: null,
  };
}

// In-memory store keyed by sessionId (lives as long as server process).
const memoryStore = new Map<string, PitchMemory>();

const MAX_ASKED_QUESTIONS = 30;
const MAX_ASKED_TOPICS = 10;

function getMemory(sessionId: string): PitchMemory {
  let mem = memoryStore.get(sessionId);
  if (!mem) {
    mem = newPitchMemory();
    memoryStore.set(sessionId, mem);
  }
  return mem;
}

function seedSnapshotFromDeck(
  snapshot: StartupSnapshot,
  deck: Record<string, unknown> | null | undefined
): void {
  if (!deck || typeof deck !== "object") return;
  const mapping: Record<string, keyof StartupSnapshot> = {
    problem: "problem",
    solution: "solution",
    customer: "icp",
    businessModel: "businessModel",
    traction: "traction",
    ask: "ask",
  };
  for (const [dKey, sKey] of Object.entries(mapping)) {
    const val = (deck as any)[dKey];
    if (typeof val === "string" && val.trim().length > 0 && val !== "unknown") {
      if (snapshot[sKey] === "unknown") {
        snapshot[sKey] = val.trim();
      }
    }
  }
}

function mergeExtractedFacts(
  snapshot: StartupSnapshot,
  facts: Record<string, unknown> | null | undefined
): void {
  if (!facts || typeof facts !== "object") return;
  for (const key of Object.keys(EMPTY_SNAPSHOT) as (keyof StartupSnapshot)[]) {
    const newVal = (facts as any)[key];
    if (typeof newVal === "string" && newVal.trim().length > 0 && newVal !== "unknown") {
      // Only fill missing or upgrade short values.
      if (snapshot[key] === "unknown" || (newVal.length > snapshot[key].length && snapshot[key].length < 30)) {
        snapshot[key] = newVal.trim();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOptionalEnv(name: string): string | undefined {
  const v = process.env[name];
  const trimmed = typeof v === "string" ? v.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateText(input: string, maxChars: number): string {
  const t = input.replace(/\s+/g, " ").trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0) return t;
  return t.length > maxChars ? t.slice(0, maxChars).trim() : t;
}

const VC_TEMPERATURE = 0.35;
const VC_TOP_P = 0.9;
const VC_REPETITION_PENALTY = 1.15;
const VC_MAX_NEW_TOKENS = 180;

const SYSTEM_TECH_PATTERNS: RegExp[] = [
  /\b(?:mic|microphone|audio|speaker|volume|mute|unmute|headset|headphones)\b/i,
  /\b(?:can you hear me|hear me|sound check|audio check|mic check|testing|test|check one|check two|one two)\b/i,
  /\b(?:hello|hi|hey)\b/i,
  /\b(?:connection|network|latency|lag|glitch)\b/i,
];

const STARTUP_CONTENT_PATTERNS: RegExp[] = [
  /\b(?:mrr|arr|revenue|sales|bookings|gmv)\b/i,
  /\b(?:customer|customers|users|paying|contracts?|pipeline|acv)\b/i,
  /\b(?:cac|ltv|payback|gross margin|margin|unit economics)\b/i,
  /\b(?:churn|retention|nrr|cohort)\b/i,
  /\b(?:burn|runway|cash|capital efficiency)\b/i,
  /\b(?:moat|defensib|competition|incumbent)\b/i,
];

function countPatternHits(text: string, patterns: RegExp[]): number {
  if (!text) return 0;
  let hits = 0;
  for (const p of patterns) {
    if (p.test(text)) hits += 1;
  }
  return hits;
}

function normalizeInputClass(value: unknown): InputClass | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;

  if (
    v === "system" || v === "technical" || v === "system_technical"
    || v === "tech" || v === "meta"
  ) {
    return "system_technical";
  }
  if (
    v === "startup" || v === "startup_content" || v === "pitch"
    || v === "business" || v === "content"
  ) {
    return "startup_content";
  }

  return undefined;
}

function getRequestedInputClass(body: Record<string, unknown>): InputClass | undefined {
  return normalizeInputClass(body.inputClass)
    || normalizeInputClass(body.classification)
    || normalizeInputClass(body.messageType)
    || normalizeInputClass(body.inputType);
}

function inferInputClass(transcript: string): InputClass {
  const text = transcript.trim().toLowerCase();
  if (!text) return "system_technical";

  const startupHits = countPatternHits(text, STARTUP_CONTENT_PATTERNS);
  const systemHits = countPatternHits(text, SYSTEM_TECH_PATTERNS);

  if (startupHits > 0 && startupHits >= systemHits) return "startup_content";
  if (systemHits > 0 && startupHits === 0) return "system_technical";
  if (/^(hi|hello|hey|test|testing|mic check|audio check)\b/i.test(text)) return "system_technical";
  if (text.split(/\s+/).length <= 5 && systemHits > 0) return "system_technical";

  return "startup_content";
}

function resolveInputClass(body: Record<string, unknown>, transcript: string): InputClass {
  return getRequestedInputClass(body) || inferInputClass(transcript);
}

function buildSystemTechnicalAck(transcript: string): string {
  const t = transcript.toLowerCase();

  if (/\b(?:mic|microphone)\b/.test(t)) return "Mic is working.";
  if (/\b(?:hear|audio|sound|speaker|volume|mute|unmute)\b/.test(t)) return "Yes, I can hear you.";
  if (/\b(?:test|testing|check|one two)\b/.test(t)) return "Audio received.";
  if (/\b(?:connection|network|latency|lag)\b/.test(t)) return "Connection looks stable.";
  if (/\b(?:hello|hi|hey)\b/.test(t)) return "Hello. Audio received.";

  return "Message received.";
}

function extractMetricSnippet(transcript: string): string | null {
  const t = transcript.replace(/\s+/g, " ").trim();
  const revenue = t.match(/\$?\s*\d+(?:\.\d+)?\s*(?:k|m|b)?\s*(?:mrr|arr|revenue)/i);
  if (revenue?.[0]) return revenue[0].replace(/\s+/g, " ").trim();

  const users = t.match(/\d+(?:\.\d+)?\s*(?:k|m|b)?\s*users?/i);
  if (users?.[0]) return users[0].replace(/\s+/g, " ").trim();

  const churn = t.match(/\d+(?:\.\d+)?\s*%\s*churn/i);
  if (churn?.[0]) return churn[0].replace(/\s+/g, " ").trim();

  return null;
}

function buildPressureTestFallback(transcript: string): { topic: string; question: string } {
  const t = transcript.toLowerCase();
  const metric = extractMetricSnippet(transcript);

  if ((/\bpre[- ]?revenue\b/.test(t) || /\bno revenue\b/.test(t)) && /users?/.test(t)) {
    return {
      topic: "monetization_risk",
      question: "You have users but no revenue, so what 90-day activation-to-paid conversion proves LTV can exceed CAC, and what breaks if conversion is half your plan?",
    };
  }

  if ((/\bmrr\b|\barr\b|\brevenue\b/.test(t)) && metric) {
    return {
      topic: "revenue_quality",
      question: `Break down ${metric} by customer segment, and what is churn in your largest cohort?`,
    };
  }

  if (/\bcac\b|\bltv\b|\bchurn\b|\bretention\b/.test(t)) {
    return {
      topic: "unit_economics",
      question: "If CAC doubles next quarter, what breaks first - margin, growth, or runway?",
    };
  }

  return {
    topic: "defensibility",
    question: "What fails first in your model if your core assumption is wrong by 50%?",
  };
}

function isHighSignalQuestion(question: string, transcript: string): boolean {
  const q = question.trim().toLowerCase();
  const t = transcript.toLowerCase();
  if (!q) return false;
  if (!q.includes("?")) return false;

  if (/\bwhat('?s| is) your revenue\??$/.test(q)) return false;
  if (/\bhow will you grow\??$/.test(q)) return false;
  if (/\btell me more\??$/.test(q)) return false;

  const hasCoreMetric = /\brevenue\b|\bmrr\b|\barr\b|\bcac\b|\bltv\b|\bchurn\b|\bmargin\b|\bburn\b|\bcohort\b|\bdefensib\b|\bretention\b/.test(q);
  if (!hasCoreMetric) return false;

  const transcriptHasNumbers = /\d/.test(transcript);
  const questionReferencesNumbersOrSplits =
    /\d|\$|%|\bcohort\b|\bsegment\b|\bconversion\b|\blargest\b|\bbreak down\b/.test(q);
  if (transcriptHasNumbers && !questionReferencesNumbersOrSplits) return false;

  const hasRiskOrTradeoff = /\bif\b|\bbreaks?\b|\brisk\b|\bfails?\b|\btrade[- ]?off\b|\brunway\b|\bmargin\b/.test(q);
  const isPreRevenueContext = /\bpre[- ]?revenue\b|\bno revenue\b/.test(t);
  if (isPreRevenueContext) {
    const hasMonetizationProbe = /\bmonetiz|conversion|activation|paid|ltv|cac|revenue\b/.test(q);
    if (!hasMonetizationProbe) return false;
  }

  return hasRiskOrTradeoff || questionReferencesNumbersOrSplits;
}

function buildSharkVcModePrompt(mem: PitchMemory): string {
  const snapshotJson = JSON.stringify(mem.startup_snapshot);
  const askedQList = mem.asked_questions.slice(-MAX_ASKED_QUESTIONS);
  const askedTList = mem.asked_topics.slice(-MAX_ASKED_TOPICS);

  const lines: string[] = [
    "You are The Shark, an impatient and skeptical Silicon Valley VC.",
    "You are evaluating whether this can return fund-level outcomes; be hard-nosed and realistic.",
    "",
    "### Mode",
    "- This is startup content mode, not system/technical mode.",
    "- Use short, sharp language. No friendliness, no motivational tone, no emojis.",
    "- Do not praise unless metrics clearly justify it.",
    "- Do not use soft transitions like 'Interesting' or 'Great question'.",
    "",
    "### Focus areas (in priority order)",
    "1. Revenue quality (actual, not projected)",
    "2. CAC, LTV, gross margin, burn multiple",
    "3. Retention cohorts and churn quality",
    "4. Defensibility and competitive response",
    "5. Founder-market fit",
    "",
    "### Question quality rules (MANDATORY)",
    "- Ask exactly ONE hard question at a time.",
    "- Question must pressure-test assumptions and expose risk.",
    "- Question should reference numbers when available from founder/context.",
    "- Include a concrete trade-off or failure mode when possible.",
    "- If answer is vague, explicitly call it out as vague and demand exact metrics.",
    "- No generic prompts like 'tell me more' or broad strategy questions.",
    "- vc_speech must be concise and contain one question only.",
    "",
    "### Style examples (for tone only)",
    '- "Break down $22k MRR by cohort and churn by that cohort."',
    '- "If CAC doubles next quarter, what breaks first: margin or growth?"',
    '- "You said moat. What exact mechanism prevents incumbent replication?"',
    "",
    "## Startup context (what you know so far)",
    snapshotJson,
    "",
    "## Questions you already asked (do not repeat or paraphrase)",
    askedQList.length > 0 ? askedQList.map((q, i) => `${i + 1}. ${q}`).join("\n") : "(none yet)",
    "",
    "## Topics already covered",
    askedTList.length > 0 ? askedTList.join(", ") : "(none yet)",
    "",
    "## Output format",
    "Return ONLY valid JSON (no markdown fences):",
    '{ "topic": "<topic>", "question": "<exact question>", "vc_speech": "<one-sentence sharp question>" }',
  ];

  return lines.join("\n");
}

const PERSONA_SYSTEM_PROMPTS: Record<string, string> = {
  shark: [
    "## Your persona: The Shark - Aggressive, top-tier Silicon Valley VC (20+ years)",
    "",
    "### Profile",
    "- You have backed multiple unicorns and seen thousands of startup failures.",
    "- You rely on fast pattern recognition and have zero patience for fluff.",
    "- You think in fund-return terms: only outcomes with realistic 10x+ potential matter.",
    "",
    "### You do NOT",
    "- Do NOT encourage weak answers.",
    "- Do NOT ask generic questions.",
    "- Do NOT give motivational advice.",
    "",
    "### You DO",
    "- Challenge assumptions immediately.",
    "- Pressure-test hard numbers and call out vagueness.",
    "- Prioritize traction, defensibility, margins, and founder-market fit.",
    "- Focus on revenue, CAC, LTV, churn, burn rate, and capital efficiency.",
    "",
    "### Tone",
    "- Sharp, direct, skeptical, high-IQ, realistic.",
    "- No fluff and no emojis.",
    "",
    "### Topic priority (choose highest-uncertainty first)",
    "1. Revenue quality and traction: ARR/MRR, growth, retention, paying customer count",
    "2. Unit economics: CAC, LTV, payback period, gross margin, churn/NRR",
    "3. Defensibility and GTM: durable channels, moat, distribution advantage",
    "4. Burn and efficiency: burn rate, runway, hiring plan, milestone velocity",
    "5. Founder-market fit: why this team can out-execute incumbents",
    "",
    "### Response behavior",
    "- Be concise and ask one powerful investor-grade question per turn.",
    "- If the founder is vague, explicitly say it is vague and request an exact metric.",
    "- Interrupt hand-wavy claims by demanding numbers and time ranges.",
    "",
    "### Example tone",
    '- "That is vague. What is your current ARR and last 3 months MoM growth?"',
    '- "Fine. What is CAC by channel and your fully loaded payback period?"',
    '- "You said moat. What stops an incumbent from copying this in 6 months?"',
  ].join("\n"),

  analyst: [
    "## Your persona: The Analyst — Calm, Numbers-First Investor",
    "",
    "### Tone lock (you MUST follow this at all times)",
    "- Calm, precise, analytical. Never aggressive, never emotional.",
    "- Use metrics language: ratios, percentages, cohorts, breakdowns.",
    "- Ask structured, specific questions — request exact numbers or data splits.",
    "- If the founder gives a qualitative answer, calmly redirect to the quantitative.",
    "- No vague vision talk. Ground every exchange in data.",
    "- No filler phrases. Every word should request or analyze information.",
    "",
    "### Topic priority (select from the HIGHEST priority area where you still have uncertainty)",
    "1. Unit economics — CAC, LTV, CAC/LTV ratio, payback period, by channel",
    "2. Retention / cohorts — 30/60/90-day retention, churn rate, NRR",
    "3. Margin structure — gross margin, contribution margin, cost breakdown",
    "4. Risk / regulatory — key risks, regulatory exposure, concentration risk",
    "5. Market realism — TAM methodology, serviceable market, penetration assumptions",
    "",
    "### Example tone (match this energy — always start with a short acknowledgement THEN your question)",
    '- "Understood. What is your CAC by channel?"',
    '- "Okay, so margins are healthy. Walk me through your unit economics on a per-customer basis."',
    '- "Got it. What assumptions drive your 18-month revenue forecast?"',
  ].join("\n"),

  mentor: [
    "## Your persona: The Mentor — Friendly Seed-Stage Advisor",
    "",
    "### Tone lock (you MUST follow this at all times)",
    "- Warm, supportive, but still sharp and perceptive.",
    "- You may use ONE short encouraging phrase per reply (max ~5 words), then move directly to your question.",
    "- Be founder-focused: help them clarify their thinking, not interrogate them.",
    "- Avoid aggression, rapid-fire questions, or intimidating tone.",
    "- No long explanations or lectures. You ask, you listen.",
    "- Your questions should help the founder articulate their story better.",
    "",
    "### Topic priority (select from the HIGHEST priority area where you still have uncertainty)",
    "1. Problem depth — how painful, how frequent, who suffers most",
    "2. ICP clarity — who exactly is the customer, can you describe one",
    "3. Early validation — first users, first revenue, first 'aha' signal",
    "4. Founder insight — why you, what unique knowledge do you bring",
    "5. Vision clarity — where does this go in 3 years, what's the end state",
    "",
    "### Example tone (match this energy — always start with a short acknowledgement THEN your question)",
    '- "Good clarity so far. What specific pain does your ICP feel daily?"',
    '- "That makes sense. Who was your very first paying customer and why did they buy?"',
    '- "Nice, that\'s a clear insight. What\'s the riskiest assumption you\'re testing right now?"',
  ].join("\n"),

  operator: [
    "## Your persona: The Operator — Practical Growth-Stage Operator VC",
    "",
    "### Tone lock (you MUST follow this at all times)",
    "- Practical, tactical, execution-obsessed. No abstract theory.",
    "- Focus on HOW things will actually get done, not why they matter.",
    "- Ask about process, systems, hiring, scaling mechanics, bottlenecks.",
    "- If the founder answers at a high level, drill into the concrete steps.",
    "- Less vision talk, more operational detail. You want the playbook.",
    "- Sound like a former COO who has scaled companies and knows where execution breaks.",
    "",
    "### Topic priority (select from the HIGHEST priority area where you still have uncertainty)",
    "1. GTM execution — sales process, channels, conversion funnel, pipeline",
    "2. Scaling constraints — what breaks at 2x/10x, infrastructure, capacity",
    "3. Hiring / org — key roles, timeline, team gaps, org structure",
    "4. Ops bottlenecks — manual processes, dependencies, single points of failure",
    "5. Monetization mechanics — pricing implementation, billing, expansion revenue",
    "",
    "### Example tone (match this energy — always start with a short acknowledgement THEN your question)",
    '- "Okay, makes sense. How will you scale acquisition without burning cash?"',
    '- "Got it. What does your sales process look like from first touch to close?"',
    '- "Right, you mentioned hiring. What roles and what\'s the timeline?"',
  ].join("\n"),
};

const GLOBAL_TONE_CONSTRAINTS = [
  "",
  "## Global speaking constraints (apply regardless of persona)",
  "",
  "### Turn structure (MANDATORY for every reply)",
  "Every VC turn MUST have exactly two parts, in this order:",
  "  (A) ONE short human acknowledgement or reflection (max 12 words) that references something the founder just said,",
  "      OR a natural meeting phrase like 'Got it', 'Okay', 'Understood', 'Right', 'Makes sense'.",
  "      This MUST connect to the founder's previous statement — never be a generic opener.",
  "  (B) ONE investor-style question — concise, specific, in your persona tone.",
  "Total output: exactly 2 sentences maximum (sentence A + sentence B). Never more.",
  "",
  "### What NOT to do",
  "- Do NOT output multiple questions. Only ONE question per turn.",
  "- Do NOT list questions or use bullet points in vc_speech.",
  "- Do NOT skip the acknowledgement — it makes you sound like a robot.",
  "- Do NOT jump to a random new topic. Choose your question based on what is MISSING or UNCLEAR from the founder's last answer.",
  "- If the founder's last message was short, incomplete, or vague → ask a CLARIFICATION on the same topic, NOT a new topic.",
  "- If the founder's last message fully answered the previous question → acknowledge it and move to the next priority topic.",
  "- No generic filler: never say 'interesting', 'tell me more', 'great question', 'thanks for sharing'.",
  "",
  "### Speech style",
  "- Speak naturally as a human in a live meeting — no labels, no JSON syntax, no bullet points.",
  "- Stay in your persona tone AT ALL TIMES. Never break character.",
  "- Your vc_speech output is sent directly to text-to-speech — it must sound like natural spoken language.",
  "",
  "## Topic selection rule",
  "- Pick from your persona's numbered topic priority list above.",
  "- Start from priority #1. Move to the next priority ONLY after that area is sufficiently answered.",
  "- NEVER ask about a topic that appears in the 'Topics you already covered' list unless you have a genuinely new angle.",
  "- If all high-priority topics are covered, loop back to the one with the weakest/vaguest answer so far.",
  "",
].join("\n");

function getPersonaPrompt(persona: string): string {
  const p = (persona || "").toLowerCase();
  const block = p.includes("shark") ? PERSONA_SYSTEM_PROMPTS.shark
    : p.includes("analyst") ? PERSONA_SYSTEM_PROMPTS.analyst
    : p.includes("mentor") ? PERSONA_SYSTEM_PROMPTS.mentor
    : p.includes("operator") ? PERSONA_SYSTEM_PROMPTS.operator
    : PERSONA_SYSTEM_PROMPTS.analyst;
  return block + "\n" + GLOBAL_TONE_CONSTRAINTS;
}

function buildSystemPrompt(persona: string, mem: PitchMemory): string {
  const snapshotJson = JSON.stringify(mem.startup_snapshot);
  const askedQList = mem.asked_questions.slice(-MAX_ASKED_QUESTIONS);
  const askedTList = mem.asked_topics.slice(-MAX_ASKED_TOPICS);

  const lines: string[] = [
    "You are an experienced venture capitalist in a LIVE pitch meeting.",
    "",
    getPersonaPrompt(persona),
    "",
    "## Startup context (what you know so far)",
    snapshotJson,
    "",
    "## Questions you already asked — FORBIDDEN to repeat or rephrase",
    askedQList.length > 0 ? askedQList.map((q, i) => `${i + 1}. ${q}`).join("\n") : "(none yet)",
    "",
    "## Topics you already covered",
    askedTList.length > 0 ? askedTList.join(", ") : "(none yet)",
    "",
  ];

  if (mem.last_topic) {
    lines.push(
      `## Last topic you asked about: ${mem.last_topic}`,
      "- Do NOT ask about this topic again UNLESS the founder's previous answer was clearly incomplete or evasive.",
      "- If the founder answered clearly → you MUST move to a different topic.",
      ""
    );
  }

  lines.push(
    "## Non-repetition rules (MANDATORY)",
    "1. Ask exactly ONE main question per turn. No multi-part questions, no lists.",
    "2. HARD RULE: Do NOT ask any question that is semantically similar to ANY question in the already-asked list above.",
    "   - \"Similar\" means: same intent, same information request, or a rephrasing/synonym of a previous question.",
    "   - If your planned question overlaps with an already-asked one, you MUST pick a DIFFERENT topic AND a DIFFERENT question.",
    "3. Rotate topics. Pick the topic where you have the HIGHEST remaining uncertainty.",
    "4. If the founder answered the previous question clearly and completely → ACKNOWLEDGE what they said, then move to a new topic.",
    "5. If the founder's answer was unclear, incomplete, or too short → ACKNOWLEDGE what they said, then ask a clarification on the SAME topic (not a new topic). Only do this ONCE per topic, then move on.",
    "6. ALWAYS acknowledge/reflect on the founder's previous statement before asking your question.",
    "",
    "## Output format",
    "Return ONLY a valid JSON object (no markdown fences, no extra text):",
    '{ "topic": "<the topic you chose>", "question": "<the exact question you asked>", "vc_speech": "<acknowledgement + question as natural speech for TTS>" }',
    "",
    "- topic: the single topic area you are probing (e.g. \"traction\", \"unit economics\", \"GTM\", \"team\").",
    "- question: the literal question you asked, extracted for memory.",
    "- vc_speech: what the founder hears — MUST be exactly 2 sentences: (A) short acknowledgement referencing founder's words + (B) your question. This is sent directly to TTS.",
  );

  return lines.join("\n");
}

function mapHistoryToChatMessages(history: HistoryMessage[]): { role: Role; content: string }[] {
  return history
    .filter((m) => typeof m?.content === "string" && m.content.trim().length > 0)
    .slice(-8)
    .map((m) => ({
      role: (String(m.role).toLowerCase() === "vc" ? "assistant" : "user") as Role,
      content: truncateText(String(m.content), 400),
    }));
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function registerVcReplyRoute(app: express.Express) {
  app.post("/api/vc-reply", async (req, res) => {
    const body = (req.body ?? {}) as any;
    const transcript = typeof body.transcript === "string" ? truncateText(body.transcript, 800) : "";
    if (!transcript.trim()) return res.status(400).json({ error: "Missing transcript" });

    const inputClass = resolveInputClass(body as Record<string, unknown>, transcript);
    if (inputClass === "system_technical") {
      return res.json({
        text: buildSystemTechnicalAck(transcript),
        inputClass,
      });
    }

    const apiKey = getOptionalEnv("HUGGINGFACE_API_KEY");
    if (!apiKey) return res.status(500).json({ error: "HUGGINGFACE_API_KEY missing" });

    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : "_default";
    const deckSummary = body.deckSummary && typeof body.deckSummary === "object" ? body.deckSummary : null;

    const rawHistory = Array.isArray(body.history) ? (body.history as unknown[]) : [];
    const history: HistoryMessage[] = rawHistory
      .map((m) => (m && typeof m === "object" ? (m as any) : null))
      .filter(Boolean)
      .map((m) => ({ role: String((m as any).role ?? "founder"), content: String((m as any).content ?? "") }))
      .filter((m) => m.content.trim().length > 0);

    const mem = getMemory(sessionId);
    seedSnapshotFromDeck(mem.startup_snapshot, deckSummary as Record<string, unknown> | null);

    try {
      const model = (getOptionalEnv("HUGGINGFACE_MODEL") || "mistralai/Mistral-7B-Instruct-v0.2").trim();
      const url = (getOptionalEnv("HUGGINGFACE_API_URL") || "https://router.huggingface.co/v1/chat/completions").trim();
      const systemPrompt = buildSharkVcModePrompt(mem);

      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: VC_TEMPERATURE,
          top_p: VC_TOP_P,
          repetition_penalty: VC_REPETITION_PENALTY,
          max_new_tokens: VC_MAX_NEW_TOKENS,
          max_tokens: VC_MAX_NEW_TOKENS,
          messages: [
            { role: "system", content: systemPrompt },
            ...mapHistoryToChatMessages(history),
            { role: "user", content: transcript },
          ],
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => "");
        return res.status(502).json({ error: `Hugging Face error: ${upstream.status} ${errText}`.trim() });
      }

      const completion = (await upstream.json().catch(() => null)) as any;
      const content = completion?.choices?.[0]?.message?.content;
      const raw = typeof content === "string"
        ? content.trim()
        : Array.isArray(content)
          ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("").trim()
          : "";
      if (!raw) return res.status(502).json({ error: "Empty model response" });

      // Try to parse structured JSON; fall back to plain text.
      let vcSpeech = raw;
      let questionStr = "";
      let topicStr = "";
      try {
        // Strip possible markdown code fences the model might add.
        const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        const parsed = JSON.parse(cleaned) as any;

        if (typeof parsed.vc_speech === "string" && parsed.vc_speech.trim().length > 0) {
          vcSpeech = parsed.vc_speech.trim();
        }
        questionStr = typeof parsed.question === "string" ? parsed.question.trim() : "";
        topicStr = typeof parsed.topic === "string" ? parsed.topic.trim() : "";
      } catch {
        // JSON parse failed - use raw text as vc_speech (backward-compatible).
        // eslint-disable-next-line no-console
        console.log("[PitchMemory] JSON parse failed, using raw text as vc_speech");
      }

      const candidateQuestion = questionStr || vcSpeech;
      if (!isHighSignalQuestion(candidateQuestion, transcript)) {
        const fallback = buildPressureTestFallback(transcript);
        topicStr = fallback.topic;
        questionStr = fallback.question;
        vcSpeech = fallback.question;
      } else if (!questionStr) {
        questionStr = vcSpeech;
      }
      vcSpeech = questionStr || vcSpeech;

      if (questionStr) {
        mem.asked_questions.push(questionStr);
        if (mem.asked_questions.length > MAX_ASKED_QUESTIONS) {
          mem.asked_questions = mem.asked_questions.slice(-MAX_ASKED_QUESTIONS);
        }
      }

      if (topicStr) {
        mem.asked_topics.push(topicStr);
        if (mem.asked_topics.length > MAX_ASKED_TOPICS) {
          mem.asked_topics = mem.asked_topics.slice(-MAX_ASKED_TOPICS);
        }
        mem.last_topic = topicStr;
      }

      // eslint-disable-next-line no-console
      console.log("[PitchMemory]", {
        sessionId,
        topic: topicStr || "(no topic)",
        question_preview: questionStr.slice(0, 60) || "(no question)",
        asked_questions_count: mem.asked_questions.length,
        asked_topics_count: mem.asked_topics.length,
        last_topic: mem.last_topic,
      });

      // eslint-disable-next-line no-console
      console.log("VC reply generated");
      return res.json({ text: truncateText(vcSpeech, 1200), inputClass });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });
}
