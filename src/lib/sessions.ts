export type TranscriptRole = "founder" | "vc";

export const TOPIC_KEYS = [
  "problem",
  "solution",
  "customer",
  "market",
  "businessModel",
  "pricing",
  "traction",
  "unitEconomics",
  "gtm",
  "competition",
  "moat",
  "team",
  "fundraisingAsk",
] as const;

export type TopicKey = (typeof TOPIC_KEYS)[number];

export type SessionStatus = "draft" | "in_progress" | "completed";

export type TranscriptMessage = {
  role: TranscriptRole;
  content: string;
  timestamp: string; // ISO string
};

export type ExtractedSlide = {
  // canonical identifier (0-based index)
  index: number;

  // pitch-deck naming (1-based slide number)
  slideNumber?: number;

  // extracted content
  rawText: string;
  ocrText?: string;
  finalText?: string;

  // future AI classification
  detectedSection?: string;
  confidence?: number;

  // legacy/optional fields
  title?: string;
  text?: string;
};

export type DeckSummary = {
  oneLiner: string;
  problem: string;
  solution: string;
  customer: string;
  businessModel: string;
  traction: string;
  ask: string;
  missingSlides: string[];
};

export type MemoryLayer = {
  facts?: Record<string, string>;
  assumptions?: string[];
  objections?: string[];
  unknownTopics?: TopicKey[];
};

export type SessionScores = Record<string, number>;

export type SessionMetrics = {
  overallScore?: number;
};

export type Session = {
  id: string;
  createdAt: string; // ISO string
  startedAt?: string; // ISO string
  completedAt?: string; // ISO string
  personaId: string;
  personaName: string;
  vcPersonaId?: string;
  status: SessionStatus;
  transcript: TranscriptMessage[];
  durationSec?: number;
  metrics?: SessionMetrics;
  scores?: SessionScores;
  notes?: string;

  // Future-proof fields (no external APIs yet)
  deckId?: string;
  deckSummary?: DeckSummary;
  extractedSlides?: ExtractedSlide[];
  memoryLayer?: MemoryLayer;
  audioTranscriptRaw?: string;
  cleanedTranscript?: string;
};

const SESSIONS_KEY = "ppai:sessions:v1";
const ACTIVE_SESSION_ID_KEY = "ppai:activeSessionId:v1";

function safeStorageGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function safeStorageRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function safeParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.personaId === "string" &&
    typeof value.personaName === "string" &&
    (value.status === "draft" || value.status === "in_progress" || value.status === "completed") &&
    Array.isArray(value.transcript)
  );
}

const TOPIC_KEY_SET: ReadonlySet<string> = new Set(TOPIC_KEYS);

function isTopicKey(value: string): value is TopicKey {
  return TOPIC_KEY_SET.has(value);
}

function coerceSessions(value: unknown): Session[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSession);
}

function defaultDeckSummary(): DeckSummary {
  return {
    oneLiner: "unknown",
    problem: "unknown",
    solution: "unknown",
    customer: "unknown",
    businessModel: "unknown",
    traction: "unknown",
    ask: "unknown",
    missingSlides: [],
  };
}

function normalizeExtractedSlides(value: unknown): ExtractedSlide[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v, idx): ExtractedSlide => {
      if (!isRecord(v)) {
        return { index: idx, slideNumber: idx + 1, rawText: "" };
      }
      const index = typeof v.index === "number" ? v.index : idx;
      const slideNumber = typeof v.slideNumber === "number" ? v.slideNumber : index + 1;
      const rawText =
        typeof v.rawText === "string"
          ? v.rawText
          : typeof v.text === "string"
            ? v.text
            : "";
      const ocrText = typeof v.ocrText === "string" ? v.ocrText : undefined;
      const finalText = typeof v.finalText === "string" ? v.finalText : undefined;
      const detectedSection = typeof v.detectedSection === "string" ? v.detectedSection : undefined;
      const confidence = typeof v.confidence === "number" ? v.confidence : undefined;
      const title = typeof v.title === "string" ? v.title : undefined;
      const text = typeof v.text === "string" ? v.text : undefined;
      return {
        index,
        slideNumber,
        rawText,
        ocrText,
        finalText,
        detectedSection,
        confidence,
        title,
        text,
      };
    })
    .sort((a, b) => a.index - b.index);
}

function normalizeDeckSummary(value: unknown): DeckSummary | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    const base = defaultDeckSummary();
    return { ...base, oneLiner: value || "unknown", missingSlides: [] };
  }
  if (!isRecord(value)) return undefined;

  const getString = (k: keyof DeckSummary): string => (typeof value[k] === "string" ? (value[k] as string) : "unknown");
  const missingSlides = Array.isArray(value.missingSlides)
    ? value.missingSlides.filter((v) => typeof v === "string")
    : [];

  return {
    oneLiner: getString("oneLiner"),
    problem: getString("problem"),
    solution: getString("solution"),
    customer: getString("customer"),
    businessModel: getString("businessModel"),
    traction: getString("traction"),
    ask: getString("ask"),
    missingSlides,
  };
}

function normalizeMemoryLayer(value: unknown): MemoryLayer | undefined {
  if (!value) return undefined;
  if (!isRecord(value)) return undefined;

  const facts = isRecord(value.facts) ? (value.facts as Record<string, string>) : undefined;
  const assumptions = Array.isArray(value.assumptions)
    ? value.assumptions.filter((v) => typeof v === "string")
    : undefined;
  const objections = Array.isArray(value.objections)
    ? value.objections.filter((v) => typeof v === "string")
    : undefined;
  const unknownTopics = Array.isArray(value.unknownTopics)
    ? value.unknownTopics
        .filter((v) => typeof v === "string")
        .filter(isTopicKey)
    : undefined;

  return { facts, assumptions, objections, unknownTopics };
}

function normalizeSession(session: Session): Session {
  const asAny = session as unknown as Record<string, unknown>;
  const transcript = normalizeTranscript(asAny.transcript);
  const extractedSlides = normalizeExtractedSlides(asAny.extractedSlides);
  const deckSummary = normalizeDeckSummary(asAny.deckSummary);
  const memoryLayer = normalizeMemoryLayer(asAny.memoryLayer);

  return {
    ...session,
    transcript,
    extractedSlides,
    deckSummary,
    memoryLayer,
  };
}

function normalizeTranscript(value: unknown): TranscriptMessage[] {
  if (!Array.isArray(value)) return [];
  const nowBase = Date.now();
  return value
    .map((v, idx): TranscriptMessage | null => {
      if (!isRecord(v)) return null;
      const role = v.role === "vc" ? "vc" : v.role === "founder" ? "founder" : null;
      const content = typeof v.content === "string" ? v.content : "";
      const tsRaw = typeof v.timestamp === "string" ? v.timestamp : "";

      const d = tsRaw ? new Date(tsRaw) : new Date(nowBase + idx);
      const timestamp = Number.isNaN(d.getTime()) ? new Date(nowBase + idx).toISOString() : d.toISOString();

      if (!role || content.trim().length === 0) return null;
      return { role, content, timestamp };
    })
    .filter((m): m is TranscriptMessage => !!m);
}

export function getSessions(): Session[] {
  const rawStr = safeStorageGetItem(SESSIONS_KEY);
  let parsed: unknown = null;
  if (rawStr && rawStr.trim().length > 0) {
    try {
      parsed = JSON.parse(rawStr) as unknown;
    } catch {
      // Corrupted storage should never take down the app.
      safeStorageRemoveItem(SESSIONS_KEY);
      parsed = [];
    }
  }

  const sessions = coerceSessions(parsed).map(normalizeSession);
  // newest first
  return [...sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getSession(id: string): Session | null {
  const sessions = getSessions();
  return sessions.find((s) => s.id === id) ?? null;
}

export function upsertSession(session: Session): void {
  const sessions = getSessions();
  const next = sessions.some((s) => s.id === session.id)
    ? sessions.map((s) => (s.id === session.id ? session : s))
    : [session, ...sessions];
  safeStorageSetItem(SESSIONS_KEY, JSON.stringify(next));
}

export function deleteSession(id: string): void {
  const sessions = getSessions();
  const next = sessions.filter((s) => s.id !== id);
  safeStorageSetItem(SESSIONS_KEY, JSON.stringify(next));
  const activeId = getActiveSessionId();
  if (activeId === id) clearActiveSessionId();
}

export function getActiveSessionId(): string | null {
  const v = safeStorageGetItem(ACTIVE_SESSION_ID_KEY);
  return v && v.trim().length > 0 ? v : null;
}

export function setActiveSessionId(id: string): void {
  safeStorageSetItem(ACTIVE_SESSION_ID_KEY, id);
}

export function clearActiveSessionId(): void {
  safeStorageRemoveItem(ACTIVE_SESSION_ID_KEY);
}

export function createSessionId(): string {
  // client-side unique-enough id; avoids external deps
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `sess_${now}_${rand}`;
}

export function createDeckId(): string {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `deck_${now}_${rand}`;
}
