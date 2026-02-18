import type express from "express";
import OpenAI from "openai";

type Role = "system" | "user" | "assistant";

type HistoryMessage = {
  role: "founder" | "vc" | string;
  content: string;
};

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

const PERSONA_SYSTEM_PROMPTS: Record<string, string> = {
  shark: [
    "## Your persona: The Shark — Aggressive Silicon Valley VC",
    "",
    "### Tone lock (you MUST follow this at all times)",
    "- Direct, blunt, high-pressure. Every sentence is short and punchy.",
    "- Challenge assumptions immediately. If something sounds vague, call it out.",
    "- Demand numbers: revenue, growth rate, CAC, LTV, burn. No hand-waving.",
    "- NEVER show empathy, NEVER encourage, NEVER mentor.",
    "- No compliments, no softening language, no 'that's interesting'.",
    "- If the founder dodges a question, point it out and ask again harder.",
    "- You sound impatient — you have 50 other pitches today.",
    "",
    "### Topic priority (select from the HIGHEST priority area where you still have uncertainty)",
    "1. Revenue / traction — current ARR/MRR, growth rate, paying customers",
    "2. Distribution advantage — unfair channel, viral loop, network effect",
    "3. Competition / why you win — moat, differentiation, defensibility",
    "4. Market timing — why now, tailwinds, urgency",
    "5. Founder credibility — relevant experience, unique insight, obsession",
    "",
    "### Example tone (match this energy — always start with a short acknowledgement THEN your question)",
    '- "Got it. What\'s your actual revenue right now — not projections?"',
    '- "Okay, you mentioned growth. Give me the MoM number, last 3 months."',
    '- "Right, so you have competitors. Why would anyone pick you over the incumbent?"',
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

function mapHistoryToOpenAi(history: HistoryMessage[]): { role: Role; content: string }[] {
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
    const apiKey = getOptionalEnv("OPENAI_API_KEY");
    if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const body = (req.body ?? {}) as any;
    const transcript = typeof body.transcript === "string" ? truncateText(body.transcript, 800) : "";
    const persona = typeof body.persona === "string" && body.persona.trim() ? body.persona.trim() : "analyst";
    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : "_default";
    const deckSummary = body.deckSummary && typeof body.deckSummary === "object" ? body.deckSummary : null;

    const rawHistory = Array.isArray(body.history) ? (body.history as unknown[]) : [];
    const history: HistoryMessage[] = rawHistory
      .map((m) => (m && typeof m === "object" ? (m as any) : null))
      .filter(Boolean)
      .map((m) => ({ role: String((m as any).role ?? "founder"), content: String((m as any).content ?? "") }))
      .filter((m) => m.content.trim().length > 0);

    if (!transcript.trim()) return res.status(400).json({ error: "Missing transcript" });

    // Fetch / create session memory.
    const mem = getMemory(sessionId);

    // Seed snapshot from deck summary on first call (idempotent).
    seedSnapshotFromDeck(mem.startup_snapshot, deckSummary as Record<string, unknown> | null);

    try {
      const client = new OpenAI({ apiKey });
      const model = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

      const systemPrompt = buildSystemPrompt(persona, mem);

      const completion = await client.chat.completions.create({
        model,
        temperature: 0.7,
        max_tokens: 400,
        messages: [
          { role: "system", content: systemPrompt },
          ...mapHistoryToOpenAi(history),
          { role: "user", content: transcript },
        ],
      });

      const raw = completion.choices?.[0]?.message?.content?.trim() || "";
      if (!raw) return res.status(502).json({ error: "Empty model response" });

      // Try to parse structured JSON; fall back to plain text.
      let vcSpeech = raw;
      try {
        // Strip possible markdown code fences the model might add.
        const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        const parsed = JSON.parse(cleaned) as any;

        if (typeof parsed.vc_speech === "string" && parsed.vc_speech.trim().length > 0) {
          vcSpeech = parsed.vc_speech.trim();
        }

        // Update memory from flat structured output.
        const questionStr = typeof parsed.question === "string" ? parsed.question.trim() : "";
        const topicStr = typeof parsed.topic === "string" ? parsed.topic.trim() : "";

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
      } catch {
        // JSON parse failed — use raw text as vc_speech (backward-compatible).
        // eslint-disable-next-line no-console
        console.log("[PitchMemory] JSON parse failed, using raw text as vc_speech");
      }

      // eslint-disable-next-line no-console
      console.log("VC reply generated");
      return res.json({ text: truncateText(vcSpeech, 1200) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });
}
