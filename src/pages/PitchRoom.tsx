import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronRight,
  Clock,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ToastAction } from "@/components/ui/toast";
import { toast } from "@/components/ui/use-toast";
import {
  TOPIC_KEYS,
  type DeckSummary,
  type ExtractedSlide,
  type MemoryLayer,
  type Session,
  type TopicKey,
  type TranscriptMessage,
  createDeckId,
  createSessionId,
  getActiveSessionId,
  getSession,
  setActiveSessionId,
  upsertSession,
} from "@/lib/sessions";

type SessionPhase = "setup" | "intro" | "feedback";

type TalkState = "idle" | "listening" | "thinking" | "speaking";

type CallTurnState = "listening" | "thinking" | "speaking";

type VcPersona = {
  id: "shark" | "analyst" | "mentor" | "operator";
  name: string;
  style: string;
};

const vcPersonas: VcPersona[] = [
  { id: "shark", name: "The Shark", style: "Aggressive Silicon Valley VC" },
  { id: "analyst", name: "The Analyst", style: "Analytical Fintech Investor" },
  { id: "mentor", name: "The Mentor", style: "Friendly Seed-Stage Advisor" },
  { id: "operator", name: "The Operator", style: "Growth-Stage Operator VC" },
];

// Fallback loop video paths per persona (place .mp4 files in public/vc-loops/)
type VcLoopState = "idle" | "thinking" | "speaking";
const VC_LOOP_VIDEOS: Record<VcPersona["id"], Record<VcLoopState, string>> = {
  shark:    { idle: "/vc-loops/shark-idle.mp4",    thinking: "/vc-loops/shark-thinking.mp4",    speaking: "/vc-loops/shark-speaking.mp4"    },
  analyst:  { idle: "/vc-loops/analyst-idle.mp4",  thinking: "/vc-loops/analyst-thinking.mp4",  speaking: "/vc-loops/analyst-speaking.mp4"  },
  mentor:   { idle: "/vc-loops/mentor-idle.mp4",   thinking: "/vc-loops/mentor-thinking.mp4",   speaking: "/vc-loops/mentor-speaking.mp4"   },
  operator: { idle: "/vc-loops/operator-idle.mp4", thinking: "/vc-loops/operator-thinking.mp4", speaking: "/vc-loops/operator-speaking.mp4" },
};

const phaseLabels: Record<SessionPhase, string> = {
  setup: "Setup",
  intro: "Session",
  feedback: "Feedback",
};

const vcQuestionBank: Record<VcPersona["id"], string[]> = {
  shark: [
    "What's your traction and growth rate?",
    "What's your CAC and LTV?",
    "Why will you win versus incumbents?",
    "How big is the market and what's your wedge?",
  ],
  analyst: [
    "Walk me through your unit economics.",
    "What's the payback period on CAC?",
    "How does your pipeline convert by stage?",
    "What assumptions drive your 18-month plan?",
  ],
  mentor: [
    "What's the origin story behind this problem?",
    "Who is your ideal customer and why?",
    "What proof points do you have for PMF?",
    "What's the riskiest assumption you're testing next?",
  ],
  operator: [
    "What's your go-to-market motion today?",
    "What roles are you hiring next and why?",
    "Where is execution breaking down right now?",
    "What would it take to scale to the next milestone?",
  ],
};

type MemoryTopic = {
  key: TopicKey;
  label: string;
  questionsByPersona: Partial<Record<VcPersona["id"] | "shark", string>>;
};

const memoryTopics: MemoryTopic[] = [
  {
    key: "problem",
    label: "Problem",
    questionsByPersona: {
      shark: "State the problem in one sentence. Who feels it most?",
      analyst: "How do you quantify the pain and urgency?",
      mentor: "Why do you care about this problem?",
      operator: "How is the problem handled today operationally?",
    },
  },
  {
    key: "solution",
    label: "Solution",
    questionsByPersona: {
      shark: "What exactly do you do, and why now?",
      analyst: "What differentiates your solution technically/economically?",
      mentor: "What's the simplest story of your solution?",
      operator: "What are the implementation steps for a customer?",
    },
  },
  {
    key: "customer",
    label: "Customer",
    questionsByPersona: {
      shark: "Who's the buyer and why will they pay?",
      analyst: "What's the ICP and how do you reach them efficiently?",
      mentor: "Tell me about the person who loves this product.",
      operator: "What's the sales cycle and who signs?",
    },
  },
  {
    key: "businessModel",
    label: "Business Model",
    questionsByPersona: {
      shark: "How do you make money and how big can this get?",
      analyst: "What are the key drivers of revenue and margin?",
      mentor: "Why is this model the right fit?",
      operator: "How do you price and package for adoption?",
    },
  },
  {
    key: "traction",
    label: "Traction",
    questionsByPersona: {
      shark: "Show me traction. Numbers.",
      analyst: "What are your leading indicators and retention?",
      mentor: "What customer story best proves momentum?",
      operator: "Where is traction coming from in the funnel?",
    },
  },
  {
    key: "fundraisingAsk",
    label: "Fundraising Ask",
    questionsByPersona: {
      shark: "How much are you raising and what milestone does it buy?",
      analyst: "What's your burn and runway post-raise?",
      mentor: "What will you learn with this capital?",
      operator: "How do headcount and GTM scale with this round?",
    },
  },
];

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

type PdfJsTextContent = { items: unknown[] };
type PdfJsPage = { getTextContent: () => Promise<PdfJsTextContent> };
type PdfJsDoc = { numPages: number; getPage: (pageNumber: number) => Promise<PdfJsPage> };
type PdfJsModule = {
  getDocument: (args: { data: ArrayBuffer }) => { promise: Promise<PdfJsDoc> };
  GlobalWorkerOptions: { workerSrc: string };
};

async function loadPdfjs(): Promise<PdfJsModule> {
  try {
    const pdfjsUnknown = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown;
    const pdfjs = pdfjsUnknown as PdfJsModule;
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
    return pdfjs;
  } catch {
    const pdfjsUnknown = (await import("pdfjs-dist/build/pdf.mjs")) as unknown;
    const pdfjs = pdfjsUnknown as PdfJsModule;
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
    return pdfjs;
  }
}

function pickFirstSentence(text: string, maxLen: number): string {
  const t = normalizeText(text);
  if (!t) return "unknown";
  const sentence = t.split(/(?<=[.!?])\s+/)[0] ?? t;
  return sentence.length > maxLen ? `${sentence.slice(0, maxLen).trim()}…` : sentence;
}

function findSnippet(allText: string, regex: RegExp, maxLen: number): string {
  const m = allText.match(regex);
  if (!m || typeof m.index !== "number") return "unknown";
  const start = Math.max(0, m.index - 80);
  const end = Math.min(allText.length, m.index + 200);
  return pickFirstSentence(allText.slice(start, end), maxLen);
}

function detectSection(rawText: string): string {
  const t = rawText.toLowerCase();
  if (/problem|pain|challenge/.test(t)) return "problem";
  if (/solution|product|platform|how it works/.test(t)) return "solution";
  if (/traction|users|mrr|arr|revenue|growth|retention|churn/.test(t)) return "traction";
  if (/pricing|price|subscription|plan|tier|revenue model/.test(t)) return "pricing";
  if (/market|tam|sam|som|market size|growing market/.test(t)) return "market";
  if (/competition|competitor|vs\./.test(t)) return "competition";
  if (/team|founder|co-founder|hiring/.test(t)) return "team";
  if (/ask|raise|funding|use of funds|round/.test(t)) return "ask";
  return "unknown";
}

function buildDeckSummaryObject(slides: ExtractedSlide[]): DeckSummary {
  const joined = slides.map((s) => getBestSlideText(s)).join("\n\n");
  const lower = joined.toLowerCase();
  const oneLiner = pickFirstSentence(getBestSlideText(slides[0] ?? { index: 0, rawText: "" } as ExtractedSlide), 140);

  const problem = /problem|pain|challenge/.test(lower)
    ? findSnippet(joined, /(problem|pain|challenge)/i, 160)
    : "unknown";
  const solution = /solution|product|platform|we built|we are building/.test(lower)
    ? findSnippet(joined, /(solution|product|platform|we built|we are building)/i, 160)
    : "unknown";
  const customer = /customer|buyers?|users?|icp|persona/.test(lower)
    ? findSnippet(joined, /(customer|buyer|user|icp|persona)/i, 160)
    : "unknown";
  const businessModel = /business model|revenue model|subscription|usage|saas|margin/.test(lower)
    ? findSnippet(joined, /(business model|revenue model|subscription|usage|saas|margin)/i, 160)
    : "unknown";
  const traction = /mrr|arr|revenue|users|growth|retention|churn/.test(lower)
    ? findSnippet(joined, /(mrr|arr|revenue|users|growth|retention|churn)/i, 160)
    : "unknown";
  const ask = /raise|funding|round|use of funds|we are raising|our ask/.test(lower)
    ? findSnippet(joined, /(raise|funding|round|use of funds|we are raising|our ask)/i, 160)
    : "unknown";

  const missingSlides: string[] = [];
  if (problem === "unknown") missingSlides.push("problem");
  if (solution === "unknown") missingSlides.push("solution");
  if (customer === "unknown") missingSlides.push("customer");
  if (businessModel === "unknown") missingSlides.push("businessModel");
  if (traction === "unknown") missingSlides.push("traction");
  if (ask === "unknown") missingSlides.push("ask");

  return { oneLiner, problem, solution, customer, businessModel, traction, ask, missingSlides };
}

function buildMemoryLayer(slides: ExtractedSlide[]): MemoryLayer {
  const joined = slides.map((s) => getBestSlideText(s)).join("\n\n");
  const t = joined.toLowerCase();

  const presence: Record<TopicKey, boolean> = {
    problem: /problem|pain|challenge/.test(t),
    solution: /solution|product|platform|how it works|we built|we are building/.test(t),
    customer: /customer|buyers?|users?|icp|persona/.test(t),
    market: /tam|sam|som|market size|market\b/.test(t),
    businessModel: /business model|revenue model|subscription|usage|saas|margin/.test(t),
    pricing: /pricing|price|subscription|plan|tier/.test(t),
    traction: /mrr|arr|revenue|users|growth|retention|churn/.test(t),
    unitEconomics: /cac|ltv|payback|gross margin|contribution margin|unit economics/.test(t),
    gtm: /go-to-market|\bgtm\b|sales|pipeline|inbound|outbound|partners?|plg|freemium/.test(t),
    competition: /competition|competitor|vs\.|alternatives?/.test(t),
    moat: /moat|defensib|network effects|switching costs?|data advantage|patents?/.test(t),
    team: /team|founder|co-founder|hiring|experience/.test(t),
    fundraisingAsk: /raise|funding|round|use of funds|we are raising|our ask|seeking\s+\$/.test(t),
  };

  const facts: Record<string, string> = Object.fromEntries(
    TOPIC_KEYS.map((k) => [k, presence[k] ? "present" : "unknown"])
  );

  const unknownTopics: TopicKey[] = TOPIC_KEYS.filter((k) => !presence[k]);

  const assumptions: string[] = [];
  const objections: string[] = [];

  const objectionByKey: Record<TopicKey, string> = {
    problem: "Problem not clearly stated in deck.",
    solution: "Solution not clearly stated in deck.",
    customer: "Customer/ICP not clearly stated in deck.",
    market: "Market sizing not clearly stated in deck.",
    businessModel: "Business model not clearly stated in deck.",
    pricing: "Pricing not clearly stated in deck.",
    traction: "Traction not clearly stated in deck.",
    unitEconomics: "Unit economics not clearly stated in deck.",
    gtm: "Go-to-market not clearly stated in deck.",
    competition: "Competition not clearly stated in deck.",
    moat: "Moat/defensibility not clearly stated in deck.",
    team: "Team not clearly stated in deck.",
    fundraisingAsk: "Fundraising ask not clearly stated in deck.",
  };

  unknownTopics.forEach((k) => objections.push(objectionByKey[k]));

  return { facts, assumptions, objections, unknownTopics };
}

const PitchRoom = () => {
  const navigate = useNavigate();
  const bypassStorage =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("bypassStorage") === "1";
  const [isMicOn, setIsMicOn] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [selectedPersona, setSelectedPersona] = useState(vcPersonas[0]);
  const [phase, setPhase] = useState<SessionPhase>("setup");
  const [showTranscript, setShowTranscript] = useState(true);
  const [timer, setTimer] = useState(0);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [founderDraft, setFounderDraft] = useState("");
  const [currentDraftText, setCurrentDraftText] = useState("");
  const [deckFileName, setDeckFileName] = useState<string | null>(null);
  const [isDeckProcessing, setIsDeckProcessing] = useState(false);
  const [isMemoryDialogOpen, setIsMemoryDialogOpen] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [sttStatus, setSttStatus] = useState<"idle" | "connecting" | "ready" | "error">("idle");
  const [callError, setCallError] = useState<string | null>(null);
  const [vcSpeaking, setVcSpeaking] = useState(false);
  const [isVcThinking, setIsVcThinking] = useState(false);
  const [talkState, setTalkState] = useState<TalkState>("idle");
  const [callTurnState, setCallTurnState] = useState<CallTurnState>("listening");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const vcAudioUrlRef = useRef<string | null>(null);

  // Lip-sync video overlay refs
  const vcVideoRef = useRef<HTMLVideoElement>(null);
  const [vcVideoMode, setVcVideoMode] = useState<"avatar" | "lip-sync">("avatar");
  const lipSyncAbortRef = useRef<AbortController | null>(null);
  const vcVideoUrlRef = useRef<string | null>(null);

  // Fallback loop video ref + state
  const vcFallbackVideoRef = useRef<HTMLVideoElement>(null);
  const [vcLoopReady, setVcLoopReady] = useState(false);

  const dgWsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const zeroGainRef = useRef<GainNode | null>(null);

  const pcmQueueRef = useRef<Int16Array[]>([]);
  const pcmQueueSamplesRef = useRef<number>(0);

  const lastUtteranceRef = useRef<string>("");
  const replyInFlightRef = useRef(false);
  const pendingUtteranceRef = useRef<string>("");
  const lastFinalRef = useRef<string>("");
  const lastVcTextRef = useRef<string>("");
  const waitToastAtRef = useRef<number>(0);

  const finalTextRef = useRef<string>("");
  const interimTextRef = useRef<string>("");
  const lastFinalAtRef = useRef<number>(0);

  // Auto VC reply scheduler refs (per spec)
  const lastTranscriptUpdateAtRef = useRef<number>(0);
  const autoReplyTimerRef = useRef<number | null>(null);
  const pendingUserTextRef = useRef<string>("");
  const lastAutoReplyFingerprintRef = useRef<string>("");
  const lastCommittedUserFingerprintRef = useRef<string>("");

  const autoEnabledRef = useRef<boolean>(false);
  const vcBusyRef = useRef<boolean>(false);

  // Keep latest state in refs to avoid stale timer closures.
  const callTurnStateRef = useRef<CallTurnState>(callTurnState);
  const talkStateRef = useRef<TalkState>(talkState);
  const inCallRef = useRef<boolean>(inCall);
  const sttStatusRef = useRef<typeof sttStatus>(sttStatus);

  useEffect(() => {
    callTurnStateRef.current = callTurnState;
  }, [callTurnState]);

  useEffect(() => {
    talkStateRef.current = talkState;
  }, [talkState]);

  useEffect(() => {
    inCallRef.current = inCall;
  }, [inCall]);

  useEffect(() => {
    sttStatusRef.current = sttStatus;
  }, [sttStatus]);

  // Preload fallback loop videos for current persona
  useEffect(() => {
    const loops = VC_LOOP_VIDEOS[selectedPersona.id];
    if (!loops) return;
    let loaded = 0;
    const total = Object.values(loops).length;
    Object.values(loops).forEach((src) => {
      const v = document.createElement("video");
      v.preload = "auto";
      v.muted = true;
      v.src = src;
      v.oncanplaythrough = () => {
        loaded++;
        if (loaded >= total) setVcLoopReady(true);
      };
      v.onerror = () => {
        // File missing — mark ready so we fall back to icon gracefully
        loaded++;
        if (loaded >= total) setVcLoopReady(true);
      };
    });
    // Set initial src on fallback video
    if (vcFallbackVideoRef.current) {
      vcFallbackVideoRef.current.src = loops.idle;
      vcFallbackVideoRef.current.load();
    }
    return () => { setVcLoopReady(false); };
  }, [selectedPersona.id]);

  // Switch fallback loop video src based on talkState (only when not in lip-sync mode)
  useEffect(() => {
    if (vcVideoMode === "lip-sync") return;
    const el = vcFallbackVideoRef.current;
    if (!el) return;
    const loops = VC_LOOP_VIDEOS[selectedPersona.id];
    if (!loops) return;

    let loopState: VcLoopState = "idle";
    if (talkState === "speaking" || vcSpeaking) loopState = "speaking";
    else if (talkState === "thinking" || isVcThinking) loopState = "thinking";
    else if (talkState === "listening" || (inCall && sttStatus === "ready")) loopState = "idle";

    const newSrc = loops[loopState];
    // Only switch if src actually changed
    if (el.src && el.src.endsWith(newSrc)) return;

    el.src = newSrc;
    el.loop = true;
    el.muted = true;
    el.load();
    el.play().catch(() => { /* autoplay may be blocked until interaction */ });
    console.debug("[vc-loop] switched to", loopState, newSrc);
  }, [talkState, vcSpeaking, isVcThinking, inCall, sttStatus, selectedPersona.id, vcVideoMode]);

  // Ensure exactly one active draft session exists on enter (setup phase)
  useEffect(() => {
    if (bypassStorage) {
      const now = new Date().toISOString();
      const s: Session = {
        id: "debug",
        createdAt: now,
        personaId: vcPersonas[0].id,
        personaName: vcPersonas[0].name,
        status: "draft",
        transcript: [],
        durationSec: 0,
        vcPersonaId: vcPersonas[0].id,
        scores: {},
        extractedSlides: [],
        memoryLayer: { facts: {}, assumptions: [], objections: [], unknownTopics: [] },
        audioTranscriptRaw: "",
        cleanedTranscript: "",
        deckId: undefined,
        deckSummary: undefined,
        metrics: { overallScore: undefined },
        notes: "",
      };
      setActiveSessionIdState(s.id);
      setActiveSession(s);
      return;
    }

    const existingId = getActiveSessionId();
    const existing = existingId ? getSession(existingId) : null;
    if (existingId && existing) {
      setActiveSessionIdState(existingId);
      setActiveSession(existing);
      const persona = vcPersonas.find((p) => p.id === existing.personaId);
      if (persona) setSelectedPersona(persona);
      return;
    }

    const now = new Date().toISOString();
    const s: Session = {
      id: createSessionId(),
      createdAt: now,
      personaId: vcPersonas[0].id,
      personaName: vcPersonas[0].name,
      status: "draft",
      transcript: [],
      durationSec: 0,
      vcPersonaId: vcPersonas[0].id,
      scores: {},
      extractedSlides: [],
      memoryLayer: { facts: {}, assumptions: [], objections: [], unknownTopics: [] },
      audioTranscriptRaw: "",
      cleanedTranscript: "",
      deckId: undefined,
      deckSummary: undefined,
      metrics: { overallScore: undefined },
      notes: "",
    };
    upsertSession(s);
    setActiveSessionId(s.id);
    setActiveSessionIdState(s.id);
    setActiveSession(s);
  }, []);

  // Timer
  useEffect(() => {
    if (!isSessionActive) return;
    const interval = setInterval(() => setTimer((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isSessionActive]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m.toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
  };

  const toggleCamera = useCallback(async () => {
    if (!inCall) {
      toast({
        title: "Start Call first",
        description: "Camera permission is requested only after you start the call.",
      });
      return;
    }

    if (isCameraOn) {
      const tracks = streamRef.current?.getTracks?.() ?? [];
      tracks.forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setIsCameraOn(false);
    } else {
      try {
        console.log("[talk] request camera");
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setIsCameraOn(true);
      } catch (err) {
        console.error("Camera access denied", err);
        toast({ variant: "destructive", title: "Camera permission denied" });
      }
    }
  }, [inCall, isCameraOn]);

  const createDraftSession = useCallback((): Session => {
    const now = new Date().toISOString();
    return {
      id: createSessionId(),
      createdAt: now,
      personaId: selectedPersona.id,
      personaName: selectedPersona.name,
      status: "draft",
      transcript: [],
      durationSec: 0,
      vcPersonaId: selectedPersona.id,
      scores: {},
      extractedSlides: [],
      memoryLayer: { facts: {}, assumptions: [], objections: [], unknownTopics: [] },
      audioTranscriptRaw: "",
      cleanedTranscript: "",
      deckId: undefined,
      deckSummary: undefined,
      metrics: { overallScore: undefined },
      notes: "",
    };
  }, [selectedPersona.id, selectedPersona.name]);

  const ensureDraftSession = useCallback((): Session => {
    if (activeSessionId) {
      const existing = getSession(activeSessionId);
      if (existing && existing.status === "draft") {
        // Keep persona in sync with current selection
        const next: Session = {
          ...existing,
          personaId: selectedPersona.id,
          personaName: selectedPersona.name,
          vcPersonaId: selectedPersona.id,
        };
        upsertSession(next);
        setActiveSession(next);
        return next;
      }
    }

    const s = createDraftSession();
    upsertSession(s);
    setActiveSessionId(s.id);
    setActiveSessionIdState(s.id);
    setActiveSession(s);
    return s;
  }, [activeSessionId, createDraftSession, selectedPersona.id, selectedPersona.name]);

  const startSession = useCallback(() => {
    const s = ensureDraftSession();
    const startedAt = s.startedAt ?? new Date().toISOString();
    const next: Session = {
      ...s,
      status: "in_progress",
      startedAt,
      personaId: selectedPersona.id,
      personaName: selectedPersona.name,
      vcPersonaId: selectedPersona.id,
    };
    upsertSession(next);
    setActiveSession(next);

    setIsSessionActive(true);
    setPhase("intro");
    setTimer(0);
  }, [ensureDraftSession, selectedPersona.id, selectedPersona.name]);

  const handleDeckChange = useCallback(
    async (file: File) => {
      const activeId = getActiveSessionId();
      const base = activeId ? getSession(activeId) : null;
      const s = base ?? ensureDraftSession();
      setIsDeckProcessing(true);
      setDeckFileName(file.name);

      try {
        const pdfjsLib = await loadPdfjs();
        const data = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const pageCount = pdf.numPages;
        const slides: ExtractedSlide[] = [];

        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
          // NOTE: This is basic text extraction. Many decks are image-based.
          // TODO(OCR): Add OCR for image-only slides in a future phase.
          const page = await pdf.getPage(pageNumber);
          const textContent = await page.getTextContent();
          const items = textContent.items as unknown[];
          const rawText = normalizeText(
            items
              .map((it) => {
                const maybe = it as { str?: unknown };
                return typeof maybe.str === "string" ? maybe.str : "";
              })
              .join(" ")
          );
          const detectedSection = detectSection(rawText);

          slides.push({
            index: pageNumber - 1,
            slideNumber: pageNumber,
            rawText: rawText || "(no extractable text; likely image-based slide)",
            ocrText: undefined,
            finalText: undefined,
            detectedSection,
            confidence: rawText ? 0.6 : 0.1,
          });
        }

        const deckSummary = buildDeckSummaryObject(slides);
        const memoryLayer = buildMemoryLayer(slides);

        const next: Session = {
          ...s,
          deckId: createDeckId(),
          extractedSlides: slides,
          deckSummary,
          memoryLayer,
        };
        upsertSession(next);
        setActiveSession(next);
        if (!activeId) {
          setActiveSessionId(next.id);
          setActiveSessionIdState(next.id);
        }
      } finally {
        setIsDeckProcessing(false);
      }
    },
    [ensureDraftSession]
  );

  const appendMessage = useCallback(
    (msg: Omit<TranscriptMessage, "timestamp"> & { timestamp?: string }) => {
      if (bypassStorage) {
        const nextMsg: TranscriptMessage = {
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp ?? new Date().toISOString(),
        };
        setActiveSession((prev) => {
          if (!prev) return prev;
          return { ...prev, transcript: [...(prev.transcript ?? []), nextMsg] };
        });
        return;
      }

      if (!activeSessionId) return;
      const existing = getSession(activeSessionId);
      if (!existing) return;
      const nextMsg: TranscriptMessage = {
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp ?? new Date().toISOString(),
      };
      const next: Session = {
        ...existing,
        personaId: selectedPersona.id,
        personaName: selectedPersona.name,
        vcPersonaId: selectedPersona.id,
        transcript: [...existing.transcript, nextMsg],
      };
      upsertSession(next);
      setActiveSession(next);
    },
    [activeSessionId, bypassStorage, selectedPersona.id, selectedPersona.name]
  );

  const formatMsgTime = useCallback((timestamp: string) => {
    try {
      const ms = Date.parse(timestamp);
      if (!Number.isFinite(ms)) return "";
      return new Date(ms).toLocaleTimeString();
    } catch {
      return "";
    }
  }, []);

  const cleanupVcAudio = useCallback(() => {
    if (audioElRef.current) {
      try {
        audioElRef.current.pause();
      } catch {
        // ignore
      }
      audioElRef.current.src = "";
    }
    if (vcAudioUrlRef.current) {
      try {
        URL.revokeObjectURL(vcAudioUrlRef.current);
      } catch {
        // ignore
      }
      vcAudioUrlRef.current = null;
    }
    // Cleanup lip-sync video
    try { lipSyncAbortRef.current?.abort(); } catch { /* ignore */ }
    lipSyncAbortRef.current = null;
    if (vcVideoRef.current) {
      try { vcVideoRef.current.pause(); } catch { /* ignore */ }
      vcVideoRef.current.src = "";
    }
    if (vcVideoUrlRef.current) {
      try { URL.revokeObjectURL(vcVideoUrlRef.current); } catch { /* ignore */ }
      vcVideoUrlRef.current = null;
    }
    setVcVideoMode("avatar");
    setVcSpeaking(false);
  }, []);

  const clearPendingSilenceTimer = useCallback(() => {
    if (autoReplyTimerRef.current !== null) {
      try {
        window.clearTimeout(autoReplyTimerRef.current);
      } catch {
        // ignore
      }
      autoReplyTimerRef.current = null;
    }
  }, []);

  const commitUserTurnOnce = useCallback(
    (text: string): boolean => {
      const t = normalizeText(text);
      if (t.length < 1) {
        console.debug("[TURN] blocked duplicate commit", { reason: "empty" });
        return false;
      }
      if (t === lastCommittedUserFingerprintRef.current) {
        console.debug("[TURN] blocked duplicate commit", { reason: "sameFingerprint", fingerprintPreview: t.slice(0, 40) });
        return false;
      }
      lastCommittedUserFingerprintRef.current = t;
      appendMessage({ role: "founder", content: t });
      pendingUserTextRef.current = "";
      setCurrentDraftText("");
      console.info("[TURN] commitUserTurnOnce", { committed: true, fingerprintPreview: t.slice(0, 40) });
      return true;
    },
    [appendMessage]
  );

  const waitForVcAudioToFinish = useCallback(async (): Promise<void> => {
    const el = audioElRef.current;
    if (!el) return;
    if (el.paused || el.ended) return;

    await new Promise<void>((resolve) => {
      const done = () => {
        try {
          el.removeEventListener("ended", done);
          el.removeEventListener("pause", done);
        } catch {
          // ignore
        }
        resolve();
      };

      try {
        el.addEventListener("ended", done, { once: true });
        el.addEventListener("pause", done, { once: true });
      } catch {
        resolve();
      }
    });
  }, []);

  const triggerVcFromText = useCallback(
    async (utteranceRaw: string): Promise<void> => {
      const utterance = normalizeText(utteranceRaw);
      if (!utterance || utterance.length < 2) return;
      if (!inCallRef.current || sttStatusRef.current !== "ready") return;
      if (vcBusyRef.current) return;

      vcBusyRef.current = true;
      try {
        console.debug("[AUTO]", "calling vc-reply");
        await handleFinalFounderUtterance(utterance);
        await waitForVcAudioToFinish();
      } finally {
        vcBusyRef.current = false;
      }
    },
    [handleFinalFounderUtterance, waitForVcAudioToFinish]
  );

  const maybeAutoTriggerVcReply = useCallback(async () => {
    const AUTO_MS = 1200;

    const state = callTurnStateRef.current;
    const vcBusy = vcBusyRef.current || talkStateRef.current === "thinking" || talkStateRef.current === "speaking";
    const idleMs = Date.now() - lastTranscriptUpdateAtRef.current;
    // Build committedText from accumulated buffers (NOT pendingUserTextRef)
    const committedText = normalizeText((finalTextRef.current + " " + interimTextRef.current).trim());
    const pendingLen = committedText.length;

    if (state !== "listening") {
      console.debug("[AUTO]", "blocked", { reason: "state", state, vcBusy, idleMs, pendingLen });
      return;
    }

    if (!autoEnabledRef.current) {
      console.debug("[AUTO]", "blocked", { reason: "disabled", state, vcBusy, idleMs, pendingLen });
      return;
    }

    if (vcBusy) {
      console.debug("[AUTO]", "blocked", { reason: "vcBusy", state, vcBusy, idleMs, pendingLen });
      return;
    }

    if (idleMs < AUTO_MS) {
      console.debug("[AUTO]", "blocked", { reason: "notIdle", state, vcBusy, idleMs, pendingLen });
      return;
    }

    if (pendingLen < 3) {
      console.debug("[AUTO]", "blocked", { reason: "tooShort", state, vcBusy, idleMs, pendingLen });
      return;
    }

    if (committedText === lastAutoReplyFingerprintRef.current) {
      console.debug("[AUTO]", "blocked", { reason: "sameText", state, vcBusy, idleMs, pendingLen });
      return;
    }

    lastAutoReplyFingerprintRef.current = committedText;
    console.info("[TURN_COMMIT]", { len: committedText.length, preview: committedText.slice(0, 60) });

    // Clear both buffers BEFORE commit
    finalTextRef.current = "";
    interimTextRef.current = "";
    pendingUserTextRef.current = "";
    setCurrentDraftText("");

    if (!commitUserTurnOnce(committedText)) return;
    await triggerVcFromText(committedText);
  }, [commitUserTurnOnce, triggerVcFromText]);

  const scheduleAutoVcReply = useCallback(() => {
    const AUTO_MS = 1200;
    const state = callTurnStateRef.current;
    const vcBusy = vcBusyRef.current || talkStateRef.current === "thinking" || talkStateRef.current === "speaking";
    const idleMs = Date.now() - lastTranscriptUpdateAtRef.current;
    const pendingLen = (finalTextRef.current + " " + interimTextRef.current).trim().length;

    console.debug("[AUTO]", "schedule", { state, vcBusy, idleMs, pendingLen, AUTO_MS });

    clearPendingSilenceTimer();
    autoReplyTimerRef.current = window.setTimeout(() => {
      void maybeAutoTriggerVcReply();
    }, AUTO_MS);
  }, [clearPendingSilenceTimer, maybeAutoTriggerVcReply]);

  const stopCall = useCallback(() => {
    console.log("[talk] Stop Call");
    setInCall(false);
    setSttStatus("idle");
    setCallError(null);

    autoEnabledRef.current = false;
    clearPendingSilenceTimer();

    pendingUserTextRef.current = "";
    lastAutoReplyFingerprintRef.current = "";
    lastCommittedUserFingerprintRef.current = "";

    replyInFlightRef.current = false;
    pendingUtteranceRef.current = "";
    finalTextRef.current = "";
    interimTextRef.current = "";
    lastFinalAtRef.current = 0;
    lastFinalRef.current = "";
    setCurrentDraftText("");
    setTalkState("idle");
    setCallTurnState("listening");

    cleanupVcAudio();

    pcmQueueRef.current = [];
    pcmQueueSamplesRef.current = 0;

    try {
      processorRef.current?.disconnect();
    } catch {
      // ignore
    }
    processorRef.current = null;

    try {
      audioSourceRef.current?.disconnect();
    } catch {
      // ignore
    }
    audioSourceRef.current = null;

    try {
      zeroGainRef.current?.disconnect();
    } catch {
      // ignore
    }
    zeroGainRef.current = null;

    try {
      audioCtxRef.current?.close();
    } catch {
      // ignore
    }
    audioCtxRef.current = null;

    try {
      dgWsRef.current?.close();
    } catch {
      // ignore
    }
    dgWsRef.current = null;

    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;

    const videoTracks = streamRef.current?.getTracks?.() ?? [];
    videoTracks.forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsCameraOn(false);
    setIsMicOn(false);
  }, [cleanupVcAudio, clearPendingSilenceTimer]);

  const downsampleFloat32ToInt16PCM = useCallback((input: Float32Array, inSampleRate: number, outSampleRate: number) => {
    if (!input || input.length === 0) return new Int16Array(0);
    if (!Number.isFinite(inSampleRate) || !Number.isFinite(outSampleRate) || inSampleRate <= 0 || outSampleRate <= 0) {
      return new Int16Array(0);
    }
    if (inSampleRate === outSampleRate) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i += 1) {
        const s = Math.max(-1, Math.min(1, input[i] ?? 0));
        out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      }
      return out;
    }

    const ratio = inSampleRate / outSampleRate;
    const newLength = Math.floor(input.length / ratio);
    const out = new Int16Array(newLength);

    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < out.length) {
      const nextOffsetBuffer = Math.floor((offsetResult + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
        sum += input[i] ?? 0;
        count += 1;
      }
      const avg = count > 0 ? sum / count : 0;
      const s = Math.max(-1, Math.min(1, avg));
      out[offsetResult] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }
    return out;
  }, []);

  async function handleFinalFounderUtterance(utteranceRaw: string) {
    const utterance = normalizeText(utteranceRaw);
    if (!utterance || utterance.length < 2) {
      replyInFlightRef.current = false;
      setTalkState(inCall && sttStatus === "ready" ? "listening" : "idle");
      setCallTurnState("listening");
      return;
    }

    // NOTE: user message is committed by commitUserTurnOnce BEFORE this function is called.
    // Do NOT appendMessage({role:"founder"}) here to avoid duplicates.
    setIsVcThinking(true);
    setTalkState("thinking");
    setCallTurnState("thinking");
    try {
      console.log("Calling /api/vc-reply");
      let vcText = await fetchVcReply(utterance);
      console.log("VC reply received");

      // One-shot anti-repeat guard.
      try {
        const prev = normalizeText(lastVcTextRef.current).toLowerCase();
        const next = normalizeText(vcText).toLowerCase();
        const looksSame =
          prev.length >= 20 &&
          next.length >= 20 &&
          (prev === next || prev.includes(next) || next.includes(prev) || prev.slice(0, 60) === next.slice(0, 60));
        if (looksSame) {
          console.log("VC reply too similar; retrying once");
          vcText = await fetchVcReply(`${utterance}\nAvoid repeating: "${lastVcTextRef.current}"`);
          console.log("VC reply received (retry)");
        }
      } catch {
        // ignore
      }

      lastVcTextRef.current = vcText;
      appendMessage({ role: "vc", content: vcText });

      try {
        setTalkState("speaking");
        setCallTurnState("speaking");
        console.log("Calling /api/tts");
        await speakVcText(vcText);
        console.log("VC audio playing");
      } catch (err) {
        const message = err instanceof Error ? err.message : "TTS error";
        console.log("[talk] tts error", message);
        toast({
          variant: "destructive",
          title: "Voice unavailable",
          description: "VC text was generated, but audio playback failed.",
        });
        setTalkState("idle");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.log("[talk] vc-reply error", message);
      if (message.toLowerCase().includes("aborted") || message.toLowerCase().includes("timeout")) {
        toast({
          variant: "destructive",
          title: "VC is thinking too long",
          description: "Tap Retry to request again.",
          action: (
            <ToastAction
              altText="Retry"
              onClick={() => {
                if (replyInFlightRef.current) return;
                const last = lastUtteranceRef.current;
                if (!last || last.length < 2) return;
                setTalkState("thinking");
                replyInFlightRef.current = true;
                void handleFinalFounderUtterance(last);
              }}
            >
              Retry
            </ToastAction>
          ),
        });
      } else {
        setCallError(message);
        toast({ variant: "destructive", title: "VC reply failed", description: message });
      }
    } finally {
      setIsVcThinking(false);
      replyInFlightRef.current = false;
      setTalkState(inCall && sttStatus === "ready" ? "listening" : "idle");
      setCallTurnState("listening");
      console.log("returning to listening");

      const pending = pendingUtteranceRef.current;
      if (pending && inCall && sttStatus === "ready" && !replyInFlightRef.current) {
        pendingUtteranceRef.current = "";
        replyInFlightRef.current = true;
        setCallTurnState("thinking");
        console.log("Draining pending utterance");
        void handleFinalFounderUtterance(pending);
      }
    }
  }

  const fetchVcReply = useCallback(
    async (lastUserText: string): Promise<string> => {
      const persona = selectedPersona.id;
      const history = (activeSession?.transcript ?? []).slice(-8).map((m) => ({ role: m.role, content: m.content }));
      const sessionId = activeSession?.id ?? activeSessionId ?? undefined;
      const deckSummary = activeSession?.deckSummary ?? undefined;

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      const started = performance.now();

      console.log("Calling /api/vc-reply");
      const resp = await fetch("/api/vc-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: lastUserText, history, persona, sessionId, deckSummary }),
        signal: controller.signal,
      });

      window.clearTimeout(timeout);
      const latency = Math.round(performance.now() - started);
      console.log("[talk] vc-reply latency ms", latency);

      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`VC reply failed: ${resp.status} ${t}`.trim());
      }
      const json = (await resp.json().catch(() => null)) as unknown;
      const vcText = typeof (json as any)?.text === "string" ? String((json as any).text) : "";
      if (!vcText.trim()) throw new Error("VC reply was empty");
      console.log("VC reply received");
      return vcText.trim();
    },
    [activeSession?.transcript, activeSession?.id, activeSession?.deckSummary, activeSessionId, selectedPersona.id]
  );

  const speakVcText = useCallback(
    async (vcText: string) => {
      cleanupVcAudio();

      const started = performance.now();

      console.log("Calling /api/tts");
      const resp = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: vcText }),
      });

      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`TTS failed: ${resp.status} ${t}`.trim());
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      vcAudioUrlRef.current = url;

      const latency = Math.round(performance.now() - started);
      console.log("[talk] tts latency ms", latency);

      // --- Fire non-blocking lip-sync fetch in parallel ---
      try {
        lipSyncAbortRef.current?.abort();
      } catch { /* ignore */ }
      const lipSyncAbort = new AbortController();
      lipSyncAbortRef.current = lipSyncAbort;
      const audioPlayStarted = Date.now();

      // Convert TTS blob to base64 for the video endpoint
      const reader = new FileReader();
      const audioBase64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          // Strip data:audio/mpeg;base64, prefix
          const b64 = result.includes(",") ? result.split(",")[1] : result;
          resolve(b64 || "");
        };
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      });

      // Fire lip-sync request (non-blocking — does NOT affect audio playback)
      void (async () => {
        try {
          const b64 = await audioBase64Promise;
          if (!b64 || lipSyncAbort.signal.aborted) return;

          const videoResp = await fetch("/api/vc-video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personaId: selectedPersona.id, audioBase64: b64 }),
            signal: lipSyncAbort.signal,
          });

          if (!videoResp.ok || lipSyncAbort.signal.aborted) return;
          const videoJson = (await videoResp.json().catch(() => null)) as any;
          const videoUrl = typeof videoJson?.videoUrl === "string" ? videoJson.videoUrl : "";
          if (!videoUrl || lipSyncAbort.signal.aborted) return;

          // Only use lip-sync if it arrived within ~1200ms of audio start
          const elapsed = Date.now() - audioPlayStarted;
          if (elapsed > 1200) {
            console.debug("[lip-sync] video arrived too late", { elapsed });
            return;
          }

          // Switch to lip-sync video
          if (vcVideoRef.current) {
            vcVideoRef.current.src = videoUrl;
            vcVideoRef.current.muted = true;
            vcVideoRef.current.play().catch(() => { /* fallback stays */ });
            vcVideoUrlRef.current = videoUrl;
            setVcVideoMode("lip-sync");
            console.info("[lip-sync] playing", { elapsed, cached: !!videoJson?.cached });
          }
        } catch (err: any) {
          if (err?.name === "AbortError") return;
          console.debug("[lip-sync] failed, using fallback", err);
          // No action needed — fallback avatar stays visible
        }
      })();

      if (!audioElRef.current) return;
      audioElRef.current.src = url;
      try {
        console.log("Playing VC audio");
        await audioElRef.current.play();
      } catch {
        // Treat as TTS failure so we don't get stuck in "speaking".
        throw new Error("Audio playback failed");
      }
    },
    [cleanupVcAudio, selectedPersona.id]
  );

  const startCall = useCallback(async () => {
    console.log("MIC ON clicked");
    if (inCall || sttStatus === "connecting") return;
    console.log("Requesting mic…");
    setCallError(null);
    setSttStatus("connecting");
    setTalkState("idle");

    if (!navigator.mediaDevices?.getUserMedia) {
      const message = "Microphone is not available in this browser";
      console.error("Mic denied", message);
      setCallError(message);
      setSttStatus("error");
      toast({ variant: "destructive", title: "Microphone permission denied" });
      return;
    }

    const cleanupLocal = () => {
      autoEnabledRef.current = false;
      finalTextRef.current = "";
      interimTextRef.current = "";
      lastFinalAtRef.current = 0;
      lastFinalRef.current = "";
      pendingUtteranceRef.current = "";
      pendingUserTextRef.current = "";
      setCurrentDraftText("");
      clearPendingSilenceTimer();

      pcmQueueRef.current = [];
      pcmQueueSamplesRef.current = 0;

      try {
        processorRef.current?.disconnect();
      } catch {
        // ignore
      }
      processorRef.current = null;

      try {
        audioSourceRef.current?.disconnect();
      } catch {
        // ignore
      }
      audioSourceRef.current = null;

      try {
        zeroGainRef.current?.disconnect();
      } catch {
        // ignore
      }
      zeroGainRef.current = null;

      try {
        audioCtxRef.current?.close();
      } catch {
        // ignore
      }
      audioCtxRef.current = null;

      try {
        dgWsRef.current?.close();
      } catch {
        // ignore
      }
      dgWsRef.current = null;

      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      setIsMicOn(false);
      setInCall(false);
      setTalkState("idle");
      setCallTurnState("listening");
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      setIsMicOn(true);
      console.log("Mic granted");
    } catch (e) {
      console.error("Mic denied", e);
      setCallError("Microphone permission denied");
      setSttStatus("error");
      toast({ variant: "destructive", title: "Microphone permission denied" });
      cleanupLocal();
      return;
    }

    try {
      console.log("Opening STT");

      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const wsUrl = import.meta.env.DEV ? "ws://localhost:8787/api/stt" : `${proto}://${window.location.host}/api/stt`;
      const ws = new WebSocket(wsUrl);
      dgWsRef.current = ws;

      const openTimeout = window.setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) return;
        toast({ variant: "destructive", title: "STT connection failed" });
        setSttStatus("error");
        setCallError("STT connection failed");
        cleanupLocal();
      }, 3000);

      ws.onopen = () => {
        window.clearTimeout(openTimeout);
        console.log("STT WS open");
        setSttStatus("ready");
        setInCall(true);
        setTalkState("listening");
        setCallTurnState("listening");

        autoEnabledRef.current = true;

        try {
          const Ctx = window.AudioContext || (window as any).webkitAudioContext;
          const audioCtx: AudioContext = new Ctx({ latencyHint: "interactive" });
          audioCtxRef.current = audioCtx;

          const source = audioCtx.createMediaStreamSource(stream);
          audioSourceRef.current = source;

          const processor = audioCtx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;

          const zeroGain = audioCtx.createGain();
          zeroGain.gain.value = 0;
          zeroGainRef.current = zeroGain;

          source.connect(processor);
          processor.connect(zeroGain);
          zeroGain.connect(audioCtx.destination);

          const OUT_RATE = 16000;
          const CHUNK_MS = 250;
          const CHUNK_SAMPLES = Math.floor((OUT_RATE * CHUNK_MS) / 1000);

          processor.onaudioprocess = (e) => {
            const socket = dgWsRef.current;
            if (!socket || socket.readyState !== WebSocket.OPEN) return;

            const input = e.inputBuffer.getChannelData(0);
            const int16 = downsampleFloat32ToInt16PCM(input, audioCtx.sampleRate, OUT_RATE);
            if (int16.length === 0) return;

            pcmQueueRef.current.push(int16);
            pcmQueueSamplesRef.current += int16.length;

            while (pcmQueueSamplesRef.current >= CHUNK_SAMPLES) {
              const chunk = new Int16Array(CHUNK_SAMPLES);
              let written = 0;
              while (written < CHUNK_SAMPLES && pcmQueueRef.current.length > 0) {
                const head = pcmQueueRef.current[0];
                const remaining = CHUNK_SAMPLES - written;
                const take = Math.min(remaining, head.length);
                chunk.set(head.subarray(0, take), written);
                written += take;

                if (take === head.length) {
                  pcmQueueRef.current.shift();
                } else {
                  pcmQueueRef.current[0] = head.subarray(take);
                }
              }

              pcmQueueSamplesRef.current -= CHUNK_SAMPLES;
              const bytes = chunk.byteLength;
              console.log(`PCM chunk bytes=${bytes}`);
              socket.send(chunk.buffer);
            }
          };

          // Resume context if needed.
          void audioCtx.resume().catch(() => {
            // ignore
          });
        } catch (err) {
          console.error("PCM audio pipeline start failed", err);
          toast({ variant: "destructive", title: "Microphone streaming failed" });
          setSttStatus("error");
          setCallError("Microphone streaming failed");
          cleanupLocal();
        }
      };

      ws.onerror = (e) => {
        window.clearTimeout(openTimeout);
        console.error("STT error", e);
        toast({ variant: "destructive", title: "STT connection failed" });
        setSttStatus("error");
        setCallError("STT connection failed");
        cleanupLocal();
      };

      ws.onclose = (e) => {
        window.clearTimeout(openTimeout);
        console.log("STT closed", (e as CloseEvent)?.code, (e as CloseEvent)?.reason);
        setSttStatus((s) => (s === "idle" ? "idle" : "error"));
        setInCall(false);
        autoEnabledRef.current = false;
        pendingUserTextRef.current = "";
        finalTextRef.current = "";
        interimTextRef.current = "";
        lastFinalAtRef.current = 0;
        lastFinalRef.current = "";
        pendingUtteranceRef.current = "";
        setCurrentDraftText("");
        clearPendingSilenceTimer();
        setTalkState("idle");
        setCallTurnState("listening");
      };

      ws.onmessage = (evt) => {
        void (async () => {
          let payload = "";
          try {
            const d: any = (evt as MessageEvent).data;
            if (typeof d === "string") payload = d;
            else if (d instanceof Blob) payload = await d.text();
            else if (d instanceof ArrayBuffer) payload = new TextDecoder().decode(new Uint8Array(d));
            else payload = String(d);
          } catch {
            return;
          }

          try {
            console.log("STT WS message raw:", payload.slice(0, 120));
          } catch {
            // ignore
          }

          let msg: any;
          try {
            msg = JSON.parse(payload);
          } catch {
            return;
          }

          const msgType = typeof msg?.type === "string" ? msg.type : "";
          const text = String(msg?.text ?? msg?.transcript ?? "").trim();
          const isFinal = Boolean(msg?.is_final ?? msg?.isFinal ?? msg?.final);

          console.log("STT parsed type=", msgType, "final=", isFinal, "textLen=", text.length);

          if (msgType === "error") {
            const message = String(msg?.message ?? "STT error");
            toast({ variant: "destructive", title: "STT error", description: message });
            setCallError(message);
            return;
          }

          if (msgType !== "transcript") return;
          if (!text) return;

          // --- Transcript buffering (per spec) ---
          lastTranscriptUpdateAtRef.current = Date.now();

          if (isFinal) {
            // Append finalized chunk to accumulated final text
            finalTextRef.current = (finalTextRef.current + " " + text).trim();
            interimTextRef.current = "";
            lastFinalAtRef.current = Date.now();
            lastFinalRef.current = text;
            console.debug("[STT]", { isFinal: true, interimLen: 0, finalLen: finalTextRef.current.length });
          } else {
            // Interim: overwrite, do NOT accumulate
            interimTextRef.current = text;
            console.debug("[STT]", { isFinal: false, interimLen: text.length, finalLen: finalTextRef.current.length });
          }

          // Live display: full accumulated + latest interim
          const liveDisplay = normalizeText((finalTextRef.current + " " + interimTextRef.current).trim());
          setCurrentDraftText(liveDisplay);
          // Do NOT update pendingUserTextRef on every event;
          // committedText is built at end-of-turn in maybeAutoTriggerVcReply.

          scheduleAutoVcReply();

          // Minimal auto-trigger only: the silence scheduler handles firing.
          // Keep existing UX behavior for "wait" toast but don't block scheduler.
          if (callTurnState !== "listening") {
            const now = Date.now();
            if (now - waitToastAtRef.current > 2500) {
              waitToastAtRef.current = now;
              toast({ title: "Wait for VC to finish", description: "VC is responding; please pause and speak again." });
            }
          }
        })();
      };
    } catch (err) {
      console.error("[talk] Start Call error", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      setCallError(message);
      setSttStatus("error");
      toast({ variant: "destructive", title: "STT connection failed", description: message });
      cleanupLocal();
    }
  }, [handleFinalFounderUtterance, inCall, sttStatus, talkState]);

  const getBestUtterance = useCallback((): string => {
    // Build from accumulated buffers, same as auto-trigger
    const full = normalizeText((finalTextRef.current + " " + interimTextRef.current).trim());
    return full || normalizeText(lastFinalRef.current || currentDraftText || "");
  }, [currentDraftText]);

  const forceVcReply = useCallback(() => {
    const utterance = getBestUtterance();
    console.log("[debug] Force VC Reply utterance len=", utterance.length, "text=", utterance.slice(0, 180));
    if (!utterance || utterance.length < 2) {
      toast({ title: "No utterance yet", description: "Speak a bit first, then try again." });
      return;
    }
    if (!commitUserTurnOnce(utterance)) return;
    void triggerVcFromText(utterance);
  }, [commitUserTurnOnce, getBestUtterance, triggerVcFromText]);

  const toggleMic = useCallback(() => {
    if (sttStatus === "connecting") return;
    if (inCall) {
      stopCall();
      return;
    }
    void startCall();
  }, [inCall, startCall, stopCall, sttStatus]);

  useEffect(() => {
    return () => {
      stopCall();
    };
  }, [stopCall]);

  const generateVcQuestionMock = useCallback(() => {
    if (!activeSession) return;
    const vcCount = activeSession.transcript.filter((m) => m.role === "vc").length;

    const unknownTopics = activeSession.memoryLayer?.unknownTopics ?? [];
    if (unknownTopics.length > 0) {
      const key = unknownTopics[vcCount % unknownTopics.length];
      const topic = memoryTopics.find((t) => t.key === key);
      if (topic) {
        const q =
          topic.questionsByPersona[selectedPersona.id] ??
          topic.questionsByPersona.shark ??
          `Tell me more about your ${topic.label.toLowerCase()}.`;
        appendMessage({ role: "vc", content: q });
        return;
      }
    }

    const bank = vcQuestionBank[selectedPersona.id] ?? vcQuestionBank.shark;
    const idx = vcCount % bank.length;
    appendMessage({ role: "vc", content: bank[idx] });
  }, [activeSession, appendMessage, selectedPersona.id]);

  const sendFounderMessage = useCallback(() => {
    const trimmed = founderDraft.trim();
    if (!trimmed) return;
    appendMessage({ role: "founder", content: trimmed });
    setFounderDraft("");
  }, [appendMessage, founderDraft]);

  const endSession = () => {
    setIsSessionActive(false);
    setPhase("feedback");

    if (activeSessionId) {
      const existing = getSession(activeSessionId);
      if (existing) {
        const completedAt = new Date().toISOString();
        const next: Session = {
          ...existing,
          status: "completed",
          completedAt,
          durationSec: timer,
        };
        upsertSession(next);
        setActiveSession(next);
      }
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsCameraOn(false);
    setIsMicOn(false);

    if (activeSessionId) {
      navigate(`/results/${activeSessionId}`);
    } else {
      navigate("/dashboard");
    }
  };

  // Setup screen
  if (!isSessionActive && phase === "setup") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 pt-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-lg rounded-2xl border border-border bg-card p-8"
        >
          <h1 className="mb-2 text-2xl font-bold text-foreground">Start a Pitch Session</h1>
          <p className="mb-8 text-sm text-muted-foreground">Choose your VC and prepare your setup.</p>

          <div className="mb-8">
            <label className="mb-3 block text-sm font-medium text-foreground">Select VC Persona</label>
            <div className="grid grid-cols-2 gap-3">
              {vcPersonas.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPersona(p)}
                  className={`rounded-xl border p-4 text-left transition-all ${
                    selectedPersona.id === p.id
                      ? "border-primary bg-primary/10"
                      : "border-border bg-secondary/30 hover:border-muted-foreground/30"
                  }`}
                >
                  <p className="text-sm font-semibold text-foreground">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.style}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="mb-8">
            <label className="mb-3 block text-sm font-medium text-foreground">Upload Pitch Deck (PDF)</label>
            <div className="rounded-xl border border-border bg-secondary/30 p-4">
              <div className="flex flex-col gap-3">
                <Input
                  type="file"
                  accept="application/pdf"
                  disabled={isDeckProcessing}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void handleDeckChange(file);
                  }}
                />
                <div className="text-xs text-muted-foreground">
                  {isDeckProcessing ? (
                    <span>Processing deck…</span>
                  ) : activeSession?.deckId ? (
                    <span>
                      Deck uploaded ✔ · {(activeSession.extractedSlides ?? []).length} page(s)
                      {deckFileName ? ` · ${deckFileName}` : ""}
                    </span>
                  ) : (
                    <span>PDF only. Text extraction is best-effort (image-only slides will be empty).</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="mb-8 flex items-center gap-4">
            <Button
              variant={isCameraOn ? "default" : "outline"}
              onClick={toggleCamera}
              className="flex-1"
            >
              {isCameraOn ? <Video className="mr-2 h-4 w-4" /> : <VideoOff className="mr-2 h-4 w-4" />}
              {isCameraOn ? "Camera On" : "Enable Camera"}
            </Button>
            <Button
              variant={isMicOn ? "default" : "outline"}
              onClick={toggleMic}
              className="flex-1"
            >
              {isMicOn ? <Mic className="mr-2 h-4 w-4" /> : <MicOff className="mr-2 h-4 w-4" />}
              {isMicOn ? "Mic On" : "Enable Mic"}
            </Button>
          </div>

          {/* Camera preview */}
          {isCameraOn && (
            <div className="mb-6 overflow-hidden rounded-xl border border-border">
              <video ref={videoRef} autoPlay muted playsInline className="h-48 w-full object-cover" />
            </div>
          )}

          <Button variant="hero" size="lg" className="w-full" onClick={startSession}>
            Launch Session with {selectedPersona.name}
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-background pt-16">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-4">
          <span className="rounded-md bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            {phaseLabels[phase]}
          </span>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {formatTime(timer)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {selectedPersona.name} · {selectedPersona.style}
          </span>
          <div className="ml-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Context Loaded:</span>
            <span className="text-xs text-foreground">
              Deck uploaded {activeSession?.deckId ? "✅" : "❌"}
              {activeSession?.deckId ? ` (${(activeSession.extractedSlides ?? []).length})` : ""}
            </span>
            <span className="text-xs text-foreground">
              Memory ready {activeSession?.memoryLayer ? "✅" : "❌"}
              {activeSession?.memoryLayer ? ` (${(activeSession.memoryLayer.unknownTopics ?? []).length})` : ""}
            </span>
            {activeSession?.memoryLayer ? (
              <Dialog open={isMemoryDialogOpen} onOpenChange={setIsMemoryDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    View Memory
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Memory Layer (Debug)</DialogTitle>
                  </DialogHeader>
                  <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-background p-3 text-xs text-foreground">
                    {JSON.stringify(activeSession.memoryLayer ?? null, null, 2)}
                  </pre>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Video area */}
        <div className="flex flex-1 flex-col">
          <div className="grid flex-1 grid-cols-2 gap-3 p-4">
            {/* AI VC */}
            <div className="relative flex items-center justify-center overflow-hidden rounded-2xl border border-border bg-card">
              {/* Lip-sync video overlay (hidden unless mode=lip-sync) */}
              <video
                ref={vcVideoRef}
                muted
                playsInline
                className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
                  vcVideoMode === "lip-sync" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
                }`}
                onError={() => {
                  console.debug("[lip-sync] video error, reverting to avatar");
                  setVcVideoMode("avatar");
                }}
                onEnded={() => {
                  setVcVideoMode("avatar");
                }}
              />
              {/* Fallback loop video (idle/thinking/speaking .mp4 per persona) */}
              <video
                ref={vcFallbackVideoRef}
                muted
                playsInline
                loop
                className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
                  vcVideoMode === "lip-sync"
                    ? "opacity-0 z-0 pointer-events-none"
                    : vcLoopReady
                      ? "opacity-100 z-[5]"
                      : "opacity-0 z-0 pointer-events-none"
                }`}
                onError={() => {
                  // Loop video missing or broken — icon fallback stays visible underneath
                  console.debug("[vc-loop] fallback video error");
                }}
              />
              {/* Icon fallback (visible only when no loop video AND no lip-sync) */}
              <div className={`flex flex-col items-center gap-4 transition-opacity duration-200 ${
                vcVideoMode === "lip-sync" || vcLoopReady ? "opacity-0 pointer-events-none" : "opacity-100"
              }`}>
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/20 animate-pulse-glow">
                  <Volume2 className="h-8 w-8 text-primary" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-foreground">{selectedPersona.name}</p>
                  <p className="text-xs text-muted-foreground">{selectedPersona.style}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {talkState === "speaking" || vcSpeaking
                      ? "VC Speaking…"
                      : talkState === "thinking" || isVcThinking
                        ? "VC Thinking…"
                        : talkState === "listening" || (inCall && sttStatus === "ready" && talkState === "idle")
                          ? "Listening…"
                          : inCall
                            ? "In Call"
                            : ""}
                  </p>
                </div>
              </div>
              <div className="absolute bottom-3 left-3 z-20 rounded-md bg-secondary/80 px-2 py-1 text-xs font-medium text-foreground">
                AI VC
              </div>
              {callError ? (
                <div className="absolute top-3 left-3 right-3 z-20 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                  {callError}
                </div>
              ) : null}
            </div>

            {/* Founder */}
            <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
              {isCameraOn ? (
                <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <VideoOff className="h-10 w-10" />
                    <p className="text-sm">Camera Off</p>
                  </div>
                </div>
              )}
              <div className="absolute bottom-3 left-3 rounded-md bg-secondary/80 px-2 py-1 text-xs font-medium text-foreground">
                You
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-center gap-3 border-t border-border p-4">
            <Button
              variant={inCall ? "secondary" : "default"}
              onClick={() => void startCall()}
              disabled={inCall || sttStatus === "connecting"}
            >
              {inCall && sttStatus === "ready" ? "Listening…" : sttStatus === "connecting" ? "Connecting…" : "Mic On"}
            </Button>
            <Button variant="destructive" onClick={stopCall} disabled={!inCall}>
              Mic Off
            </Button>
            <Button
              variant={isCameraOn ? "secondary" : "destructive"}
              size="icon"
              onClick={toggleCamera}
            >
              {isCameraOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
            </Button>
            <Button variant="secondary" size="icon" onClick={() => setIsScreenSharing(!isScreenSharing)}>
              <Monitor className="h-4 w-4" />
            </Button>
            <Button
              variant="secondary"
              size="icon"
              onClick={() => setShowTranscript(!showTranscript)}
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
            <div className="mx-2 h-6 w-px bg-border" />
            <Button variant="destructive" onClick={endSession}>
              <PhoneOff className="mr-2 h-4 w-4" />
              End Session
            </Button>
          </div>
        </div>

        {/* Transcript panel */}
        <AnimatePresence>
          {showTranscript && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 360, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              className="flex flex-col overflow-hidden border-l border-border"
            >
              <div className="border-b border-border p-4">
                <h3 className="text-sm font-semibold text-foreground">Live Transcript</h3>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto p-4">
                {(activeSession?.transcript ?? [])
                  .slice()
                  .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
                  .map((msg, i) => (
                    <div
                      key={`${msg.timestamp}_${i}`}
                      className={`flex gap-3 ${msg.role === "vc" ? "" : "flex-row-reverse"}`}
                    >
                      <div
                        className={`rounded-xl px-4 py-3 text-sm ${
                          msg.role === "vc" ? "bg-primary/10 text-foreground" : "bg-secondary text-foreground"
                        }`}
                      >
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {msg.role === "vc" ? selectedPersona.name : "You"}
                          {formatMsgTime(msg.timestamp) ? ` · ${formatMsgTime(msg.timestamp)}` : ""}
                        </p>
                        {msg.content}
                      </div>
                    </div>
                  ))}

                {currentDraftText.trim().length > 0 && (
                  <div className="flex gap-3 flex-row-reverse">
                    <div className="rounded-xl bg-secondary px-4 py-3 text-sm text-foreground opacity-80">
                      <p className="mb-1 text-xs font-medium text-muted-foreground">You · speaking…</p>
                      {currentDraftText}
                    </div>
                  </div>
                )}

                {(activeSession?.transcript?.length ?? 0) === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No messages yet. Add your pitch update or generate a mock VC question.
                  </p>
                )}
              </div>

              <div className="border-t border-border p-4">
                <div className="mb-3 flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={generateVcQuestionMock}
                    disabled={!activeSessionId}
                  >
                    Generate VC Question (Mock)
                  </Button>
                </div>
                {/* Force VC Reply button hidden – auto-trigger handles replies.
                   forceVcReply() is still available programmatically for debugging. */}
                <div className="flex gap-2">
                  <input
                    value={founderDraft}
                    onChange={(e) => setFounderDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") sendFounderMessage();
                    }}
                    placeholder="Type your message…"
                    className="h-10 flex-1 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <Button type="button" variant="secondary" onClick={sendFounderMessage} disabled={!activeSessionId}>
                    Send
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <audio
        ref={(el) => {
          audioElRef.current = el;
        }}
        onPlay={() => {
          setVcSpeaking(true);
          setTalkState("speaking");
          setCallTurnState("speaking");
        }}
        onPause={() => {
          setVcSpeaking(false);
          setTalkState("idle");
          setCallTurnState("listening");
          // Revert lip-sync on audio pause
          setVcVideoMode("avatar");
        }}
        onEnded={() => {
          setVcSpeaking(false);
          cleanupVcAudio();
          setTalkState("idle");
          setCallTurnState("listening");
          // Revert lip-sync on audio end
          setVcVideoMode("avatar");
        }}
        className="hidden"
      />
    </div>
  );
};

export default PitchRoom;
