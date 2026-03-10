import "dotenv/config";

import cors from "cors";
import express from "express";
import http from "http";
import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------

const API_PORT = Number(process.env.API_PORT || 8787);

const HUGGINGFACE_API_URL =
  process.env.HUGGINGFACE_API_URL?.trim() ||
  "https://router.huggingface.co/v1/chat/completions";

const HF_MODEL = mustGetEnv("HF_MODEL");
const HUGGINGFACE_API_KEY = mustGetEnv("HUGGINGFACE_API_KEY");
const ELEVENLABS_API_KEY = mustGetEnv("ELEVENLABS_API_KEY");
const ELEVENLABS_VOICE_ID = mustGetEnv("ELEVENLABS_VOICE_ID");
const DID_API_KEY = mustGetEnv("DID_API_KEY");

// Deepgram key is required for real-time STT streaming.
const DEEPGRAM_API_KEY = mustGetEnv("DEEPGRAM_API_KEY");

const ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2";

// Validate ElevenLabs configuration at startup
console.log("ElevenLabs configuration:");
console.log("  API key loaded:", !!ELEVENLABS_API_KEY);
console.log("  API key length:", ELEVENLABS_API_KEY ? ELEVENLABS_API_KEY.length : 0);
console.log("  Voice ID:", ELEVENLABS_VOICE_ID);
console.log("  Model ID:", ELEVENLABS_MODEL_ID);

const DID_AVATAR_SOURCE_URL =
  process.env.DID_AVATAR_SOURCE_URL?.trim() ||
  "https://d-id-public-bucket.s3.us-west-2.amazonaws.com/alice.jpg";

const DID_BASE_URL = "https://api.d-id.com";
const DEEPGRAM_BASE_URL = "wss://api.deepgram.com/v1/listen";

// Speech finalization controls.
const SILENCE_DEBOUNCE_MS = 1000; // requirement: 800-1200ms
const FINAL_DEBOUNCE_MS = 300;
const HIGH_CONFIDENCE_THRESHOLD = 0.9;
const STABLE_CONFIDENCE_HITS = 2;
const MIN_FINAL_TEXT_CHARS = 6;

// D-ID polling controls.
const DID_POLL_INTERVAL_MS = 1500;
const DID_POLL_TIMEOUT_MS = 120000;

// Generation controls requested by user.
const VC_GEN_PARAMS = {
  temperature: 0.35,
  top_p: 0.9,
  repetition_penalty: 1.15,
  max_new_tokens: 180,
};

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

const VC_SYSTEM_PROMPT = [
  "You are The Shark, a skeptical and impatient Silicon Valley VC.",
  "No praise unless metrics clearly justify it.",
  "No motivational tone, no friendliness, no soft transitions.",
  "Only care about revenue quality, CAC, LTV, gross margin, burn multiple, retention cohorts, defensibility, and founder-market fit.",
  "Ask exactly ONE hard question.",
  "If the founder is vague, call it out directly.",
  "Keep language short, sharp, and realistic.",
  "Output only a single question sentence and nothing else.",
].join(" ");

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

class AppError extends Error {
  constructor(stage, message, statusCode = 500, details = null) {
    super(message);
    this.name = "AppError";
    this.stage = stage;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function toErrorPayload(err) {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      stage: err.stage,
      message: err.message,
      details: err.details,
    };
  }

  return {
    statusCode: 500,
    stage: "internal",
    message: err instanceof Error ? err.message : "Unknown error",
    details: null,
  };
}

function mustGetEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function normalizeText(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function didAuthHeader(apiKeyRaw) {
  const raw = apiKeyRaw.trim();
  if (/^basic\s+/i.test(raw)) return raw;
  if (raw.includes(":")) {
    return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }
  return `Basic ${raw}`;
}

// ---------------------------------------------------------------------------
// VC question quality controls
// ---------------------------------------------------------------------------

function extractMetricSnippet(transcript) {
  const text = normalizeText(transcript);
  const revenue = text.match(/\$?\s*\d+(?:\.\d+)?\s*(?:k|m|b)?\s*(?:mrr|arr|revenue)/i);
  if (revenue?.[0]) return normalizeText(revenue[0]);

  const users = text.match(/\d+(?:\.\d+)?\s*(?:k|m|b)?\s*users?/i);
  if (users?.[0]) return normalizeText(users[0]);

  const churn = text.match(/\d+(?:\.\d+)?\s*%\s*churn/i);
  if (churn?.[0]) return normalizeText(churn[0]);

  return null;
}

function buildFallbackVcQuestion(founderText) {
  const t = founderText.toLowerCase();
  const metric = extractMetricSnippet(founderText);

  if ((/\bpre[- ]?revenue\b/.test(t) || /\bno revenue\b/.test(t)) && /users?/.test(t)) {
    return "You have users but no revenue, so what 90-day activation-to-paid conversion proves LTV can exceed CAC, and what breaks if conversion is half your plan?";
  }

  if ((/\bmrr\b|\barr\b|\brevenue\b/.test(t)) && metric) {
    return `Break down ${metric} by customer segment, and what is churn in your largest cohort?`;
  }

  if (/\bcac\b|\bltv\b|\bchurn\b|\bretention\b/.test(t)) {
    return "If paid acquisition doubles CAC next quarter, what breaks first: margin, growth, or runway?";
  }

  return "Which assumption in your model fails first if churn is 2x your plan?";
}

function isWeakOrPolite(question) {
  const q = normalizeText(question).toLowerCase();
  if (!q) return true;
  if (!q.includes("?")) return true;
  if (/\b(great|awesome|nice|love|exciting|interesting|good job|congrats)\b/.test(q)) return true;
  if (/^(what'?s your revenue\??|how will you grow\??|tell me more\??)$/i.test(q)) return true;
  if (!/\b(revenue|mrr|arr|cac|ltv|margin|burn|churn|retention|cohort|defens)/.test(q)) return true;
  return false;
}

function enforceSingleHardQuestion(rawOutput, founderText) {
  let question = normalizeText(rawOutput)
    .replace(/^["'`\-\s]+/, "")
    .replace(/["'`]+$/, "");

  // Keep only the first line and first question mark to guarantee one question.
  question = question.split("\n")[0].trim();
  const firstQuestionMark = question.indexOf("?");
  if (firstQuestionMark >= 0) {
    question = question.slice(0, firstQuestionMark + 1);
  }

  if (!question.endsWith("?")) {
    question = `${question}?`.trim();
  }

  if (isWeakOrPolite(question)) {
    return buildFallbackVcQuestion(founderText);
  }

  return question;
}

// ---------------------------------------------------------------------------
// External API clients
// ---------------------------------------------------------------------------

async function generateVcQuestion(founderTranscript) {
  const founderText = normalizeText(founderTranscript);
  if (!founderText) {
    throw new AppError("vc_generation", "Missing founder transcript", 400);
  }

  const response = await fetch(HUGGINGFACE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${HUGGINGFACE_API_KEY}`,
    },
    body: JSON.stringify({
      model: HF_MODEL,
      temperature: VC_GEN_PARAMS.temperature,
      top_p: VC_GEN_PARAMS.top_p,
      repetition_penalty: VC_GEN_PARAMS.repetition_penalty,
      max_new_tokens: VC_GEN_PARAMS.max_new_tokens,
      max_tokens: VC_GEN_PARAMS.max_new_tokens,
      messages: [
        { role: "system", content: VC_SYSTEM_PROMPT },
        { role: "user", content: founderText },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new AppError(
      "vc_generation",
      `Hugging Face error: ${response.status}`,
      502,
      normalizeText(errText)
    );
  }

  const json = await response.json().catch(() => null);
  const raw =
    typeof json?.choices?.[0]?.message?.content === "string"
      ? json.choices[0].message.content
      : Array.isArray(json?.choices?.[0]?.message?.content)
        ? json.choices[0].message.content
            .map((p) => (typeof p?.text === "string" ? p.text : ""))
            .join("")
        : "";

  if (!normalizeText(raw)) {
    throw new AppError("vc_generation", "Empty response from Hugging Face", 502);
  }

  return enforceSingleHardQuestion(raw, founderText);
}

async function synthesizeWithElevenLabs(text) {
  const inputText = normalizeText(text);
  if (!inputText) {
    throw new AppError("tts", "Missing text for ElevenLabs", 400);
  }

  console.log("Calling ElevenLabs TTS");
  console.log("  Voice ID:", ELEVENLABS_VOICE_ID);
  console.log("  Model ID:", ELEVENLABS_MODEL_ID);
  console.log("  Text length:", inputText.length);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "xi-api-key": ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text: inputText,
      model_id: ELEVENLABS_MODEL_ID,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.85,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error("ElevenLabs API error:");
    console.error("  Status:", response.status);
    console.error("  Status Text:", response.statusText);
    console.error("  Response Body:", errText);
    console.error("  Using API key length:", ELEVENLABS_API_KEY ? ELEVENLABS_API_KEY.length : 0);
    throw new AppError("tts", `ElevenLabs error: ${response.status}`, 502, normalizeText(errText));
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (!audioBuffer.length) {
    throw new AppError("tts", "ElevenLabs returned empty audio", 502);
  }

  console.log("ElevenLabs TTS successful, audio size:", audioBuffer.length, "bytes");

  return {
    audioBuffer,
    audioBase64: audioBuffer.toString("base64"),
  };
}

async function createDidTalkFromBase64(audioBase64) {
  const audioDataUri = `data:audio/mpeg;base64,${audioBase64}`;
  const response = await fetch(`${DID_BASE_URL}/talks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: didAuthHeader(DID_API_KEY),
    },
    body: JSON.stringify({
      source_url: DID_AVATAR_SOURCE_URL,
      script: {
        type: "audio",
        audio_url: audioDataUri,
        subtitles: false,
      },
      config: {
        stitch: true,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new AppError("avatar", `D-ID talks create failed: ${response.status}`, 502, normalizeText(errText));
  }

  const json = await response.json().catch(() => null);
  const talkId = typeof json?.id === "string" ? json.id : "";
  if (!talkId) {
    throw new AppError("avatar", "D-ID create response missing talk id", 502, json);
  }

  return talkId;
}

async function pollDidTalkUntilDone(talkId) {
  const startedAt = Date.now();
  const auth = didAuthHeader(DID_API_KEY);

  while (Date.now() - startedAt < DID_POLL_TIMEOUT_MS) {
    const response = await fetch(`${DID_BASE_URL}/talks/${encodeURIComponent(talkId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: auth,
      },
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new AppError("avatar", `D-ID talks poll failed: ${response.status}`, 502, normalizeText(errText));
    }

    const json = await response.json().catch(() => null);
    const status = String(json?.status || "").toLowerCase();

    if (status === "done") {
      const videoUrl =
        typeof json?.result_url === "string"
          ? json.result_url
          : typeof json?.result?.url === "string"
            ? json.result.url
            : "";

      if (!videoUrl) {
        throw new AppError("avatar", "D-ID status=done but missing result_url", 502, json);
      }

      return videoUrl;
    }

    if (status === "error" || status === "failed" || status === "rejected") {
      throw new AppError("avatar", `D-ID talk failed with status=${status}`, 502, json);
    }

    await sleep(DID_POLL_INTERVAL_MS);
  }

  throw new AppError("avatar", "Timed out waiting for D-ID video", 504, {
    timeoutMs: DID_POLL_TIMEOUT_MS,
    talkId,
  });
}

// Full VC pipeline: transcript -> VC text -> ElevenLabs audio -> D-ID video URL.
async function runVcAvatarPipeline(founderTranscript) {
  const vcText = await generateVcQuestion(founderTranscript);
  const { audioBuffer, audioBase64 } = await synthesizeWithElevenLabs(vcText);
  const talkId = await createDidTalkFromBase64(audioBase64);
  const videoUrl = await pollDidTalkUntilDone(talkId);

  return {
    vcText,
    audioBuffer,
    audioBase64,
    didTalkId: talkId,
    videoUrl,
  };
}

// ---------------------------------------------------------------------------
// Deepgram speech finalization logic
// ---------------------------------------------------------------------------

function buildDeepgramWsUrl() {
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-2",
    punctuate: "true",
    interim_results: "true",
    vad_events: "true",
    endpointing: process.env.DEEPGRAM_ENDPOINTING_MS || "50",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
  });
  return `${DEEPGRAM_BASE_URL}?${params.toString()}`;
}

function createSpeechFinalizer({ onFinal }) {
  let finalSegments = [];
  let interimText = "";
  let silenceTimer = null;
  let finalDebounceTimer = null;
  let lastStableInterim = "";
  let stableHits = 0;
  let lastEmittedHash = "";
  let closed = false;

  function currentTurnText() {
    const joined = normalizeText([...finalSegments, interimText].join(" "));
    return joined;
  }

  function clearTimers() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    if (finalDebounceTimer) {
      clearTimeout(finalDebounceTimer);
      finalDebounceTimer = null;
    }
  }

  function resetSilenceTimer() {
    if (closed) return;
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      void emitFinal("silence_1s");
    }, SILENCE_DEBOUNCE_MS);
  }

  function scheduleFinal(reason, delayMs = FINAL_DEBOUNCE_MS) {
    if (closed) return;
    if (finalDebounceTimer) clearTimeout(finalDebounceTimer);
    finalDebounceTimer = setTimeout(() => {
      void emitFinal(reason);
    }, delayMs);
  }

  async function emitFinal(reason) {
    if (closed) return;
    const text = currentTurnText();
    if (text.length < MIN_FINAL_TEXT_CHARS) return;

    const hash = crypto.createHash("sha1").update(text).digest("hex");
    if (hash === lastEmittedHash) return;

    lastEmittedHash = hash;
    finalSegments = [];
    interimText = "";
    lastStableInterim = "";
    stableHits = 0;

    await onFinal(text, reason);
  }

  function consume(partial) {
    if (closed) return;

    const text = normalizeText(partial.text || "");
    const isFinal = Boolean(partial.is_final);
    const speechFinal = Boolean(partial.speech_final);
    const confidence = Number.isFinite(partial.confidence) ? partial.confidence : Number.NaN;

    if (text) {
      resetSilenceTimer();
    }

    if (text && isFinal) {
      finalSegments.push(text);
      interimText = "";
      scheduleFinal("is_final", FINAL_DEBOUNCE_MS);
    } else if (text) {
      interimText = text;

      if (confidence >= HIGH_CONFIDENCE_THRESHOLD) {
        if (text === lastStableInterim) {
          stableHits += 1;
        } else {
          lastStableInterim = text;
          stableHits = 1;
        }

        if (stableHits >= STABLE_CONFIDENCE_HITS) {
          scheduleFinal("high_confidence_stable", FINAL_DEBOUNCE_MS);
        }
      } else {
        stableHits = 0;
        lastStableInterim = "";
      }
    }

    if (speechFinal) {
      scheduleFinal("speech_final", 120);
    }
  }

  function close() {
    closed = true;
    clearTimers();
  }

  return { consume, emitFinal, close };
}

function attachDeepgramGateway(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) return;
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/api/stt") return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (clientWs, req) => {
    const url = new URL(req.url || "/api/stt", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId") || crypto.randomUUID();

    const dgWs = new WebSocket(buildDeepgramWsUrl(), {
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
      },
    });

    let pipelineQueue = Promise.resolve();
    const finalizer = createSpeechFinalizer({
      onFinal: async (finalTranscript, reason) => {
        safeSend(clientWs, {
          type: "finalized_transcript",
          sessionId,
          reason,
          text: finalTranscript,
        });

        pipelineQueue = pipelineQueue
          .then(async () => {
            safeSend(clientWs, {
              type: "vc_processing",
              sessionId,
              stage: "start",
              transcript: finalTranscript,
            });

            const result = await runVcAvatarPipeline(finalTranscript);
            safeSend(clientWs, {
              type: "vc_response",
              sessionId,
              transcript: finalTranscript,
              vcText: result.vcText,
              didTalkId: result.didTalkId,
              videoUrl: result.videoUrl,
            });
          })
          .catch((err) => {
            const payload = toErrorPayload(err);
            console.error("[WS pipeline error]", payload);
            safeSend(clientWs, {
              type: "error",
              sessionId,
              stage: payload.stage,
              message: payload.message,
              details: payload.details,
            });
          });
      },
    });

    dgWs.on("open", () => {
      safeSend(clientWs, { type: "stt_ready", sessionId });
    });

    dgWs.on("message", (raw) => {
      const message = typeof raw === "string" ? raw : raw.toString();
      const json = safeJsonParse(message);
      if (!json || typeof json !== "object") return;

      const evtType = String(json.type || "").toLowerCase();
      if (evtType.includes("error")) {
        safeSend(clientWs, {
          type: "error",
          sessionId,
          stage: "stt",
          message: String(json.message || json.error || "Deepgram error"),
        });
        return;
      }

      const transcript = json?.channel?.alternatives?.[0]?.transcript || "";
      const confidence = Number(json?.channel?.alternatives?.[0]?.confidence);
      const isFinal = Boolean(json?.is_final);
      const speechFinal = Boolean(json?.speech_final);

      if (normalizeText(transcript)) {
        safeSend(clientWs, {
          type: "transcript",
          sessionId,
          text: transcript,
          is_final: isFinal,
          speech_final: speechFinal,
          confidence: Number.isFinite(confidence) ? confidence : undefined,
        });
      }

      finalizer.consume({
        text: transcript,
        is_final: isFinal,
        speech_final: speechFinal,
        confidence,
      });
    });

    dgWs.on("close", (code, reason) => {
      safeSend(clientWs, {
        type: "stt_closed",
        sessionId,
        code,
        reason: reason?.toString?.() || "",
      });
    });

    dgWs.on("error", (err) => {
      safeSend(clientWs, {
        type: "error",
        sessionId,
        stage: "stt",
        message: `Deepgram websocket error: ${err.message}`,
      });
    });

    clientWs.on("message", (raw, isBinary) => {
      // Audio chunks are forwarded to Deepgram as-is.
      if (isBinary && dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(raw);
        return;
      }

      if (dgWs.readyState !== WebSocket.OPEN) return;

      const message = typeof raw === "string" ? raw : raw.toString();
      const json = safeJsonParse(message);
      if (!json || typeof json !== "object") return;

      if (json.type === "finalize") {
        // Explicit finalize from client (optional).
        dgWs.send(JSON.stringify({ type: "Finalize" }));
        void finalizer.emitFinal("client_finalize");
      }
    });

    clientWs.on("close", () => {
      finalizer.close();
      try {
        dgWs.close();
      } catch {
        // ignore
      }
    });

    clientWs.on("error", () => {
      finalizer.close();
      try {
        dgWs.close();
      } catch {
        // ignore
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));

// Prevent "Cannot GET /" confusion.
app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "VC simulation API",
    endpoints: ["/api/health", "/api/vc-turn", "WS /api/stt", "GET /debug/elevenlabs"],
  });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

// Diagnostic endpoint to test ElevenLabs authentication
app.get("/debug/elevenlabs", async (_req, res) => {
  try {
    console.log("Testing ElevenLabs authentication...");
    console.log("  API key present:", !!ELEVENLABS_API_KEY);
    console.log("  API key length:", ELEVENLABS_API_KEY ? ELEVENLABS_API_KEY.length : 0);
    
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      method: "GET",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
    });
    
    console.log("  Response status:", response.status);
    console.log("  Response ok:", response.ok);
    
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error("  Error response:", errText);
      return res.status(response.status).json({
        ok: false,
        status: response.status,
        message: "ElevenLabs authentication failed",
        details: errText,
        config: {
          apiKeyPresent: !!ELEVENLABS_API_KEY,
          apiKeyLength: ELEVENLABS_API_KEY ? ELEVENLABS_API_KEY.length : 0,
          voiceId: ELEVENLABS_VOICE_ID,
          modelId: ELEVENLABS_MODEL_ID,
        },
      });
    }
    
    const data = await response.json();
    console.log("  Authentication successful, voices count:", data.voices?.length || 0);
    
    return res.status(200).json({
      ok: true,
      message: "ElevenLabs authentication successful",
      voicesCount: data.voices?.length || 0,
      config: {
        voiceId: ELEVENLABS_VOICE_ID,
        modelId: ELEVENLABS_MODEL_ID,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Diagnostic endpoint error:", message);
    return res.status(500).json({
      ok: false,
      error: message,
    });
  }
});

// Direct HTTP endpoint for already-finalized transcript text.
app.post("/api/vc-turn", async (req, res) => {
  try {
    const transcript = normalizeText(req.body?.transcript || "");
    const isFinalized = Boolean(req.body?.isFinalized);

    if (!transcript) {
      throw new AppError("request", "Missing transcript", 400);
    }
    if (!isFinalized) {
      throw new AppError(
        "request",
        "Transcript is not finalized yet. Wait for is_final/silence/stable confidence before calling /api/vc-turn.",
        409
      );
    }

    const result = await runVcAvatarPipeline(transcript);

    return res.status(200).json({
      ok: true,
      transcript,
      vcText: result.vcText,
      didTalkId: result.didTalkId,
      videoUrl: result.videoUrl,
      // Exposed for debugging/inspection; remove in production if payload size matters.
      audioBase64: result.audioBase64,
    });
  } catch (err) {
    const payload = toErrorPayload(err);
    console.error("[/api/vc-turn error]", payload);
    return res.status(payload.statusCode).json({
      ok: false,
      stage: payload.stage,
      error: payload.message,
      details: payload.details,
    });
  }
});

const server = http.createServer(app);
attachDeepgramGateway(server);

server.listen(API_PORT, () => {
  console.log(`VC API listening on http://localhost:${API_PORT}`);
  console.log(`Default avatar source: ${DID_AVATAR_SOURCE_URL}`);
});

