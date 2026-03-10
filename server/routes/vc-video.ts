import crypto from "crypto";
import type express from "express";

type PersonaId = "shark" | "analyst" | "mentor" | "operator";

interface VcVideoRequest {
  personaId?: PersonaId | string;
  audioUrl?: string;
  audioBase64?: string;
}

interface VcVideoResponse {
  video: string;
  videoUrl: string;
  cached: boolean;
  talkId?: string;
}

const videoCache = new Map<string, string>();
const VALID_PERSONAS = new Set<string>(["shark", "analyst", "mentor", "operator"]);

const DID_BASE_URL = "https://api.d-id.com";
const DID_POLL_INTERVAL_MS = 1500;
const DID_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_AVATAR_SOURCE = "https://d-id-public-bucket.s3.us-west-2.amazonaws.com/alice.jpg";

function getOptionalEnv(name: string): string | undefined {
  const v = process.env[name];
  const trimmed = typeof v === "string" ? v.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function safeParseJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function didBasicAuthHeader(apiKey: string): string {
  // Requirement: Authorization: Basic base64(DID_API_KEY + ":")
  const encoded = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

function computeHash(personaId: string, audioBytes: Buffer): string {
  const h = crypto.createHash("sha256");
  h.update(personaId);
  h.update(audioBytes);
  return h.digest("hex");
}

async function resolveAudioBuffer(body: VcVideoRequest): Promise<Buffer | null> {
  try {
    if (typeof body.audioBase64 === "string" && body.audioBase64.trim().length > 0) {
      return Buffer.from(body.audioBase64.trim(), "base64");
    }

    if (typeof body.audioUrl === "string" && body.audioUrl.trim().length > 0) {
      const resp = await fetch(body.audioUrl.trim(), { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.error("[vc-video] audioUrl fetch failed", { status: resp.status, body: txt });
        return null;
      }
      return Buffer.from(await resp.arrayBuffer());
    }
  } catch (err) {
    console.error("[vc-video] resolveAudioBuffer error", err);
  }
  return null;
}

async function createDidTalk(
  audioBuffer: Buffer,
  didApiKey: string,
  sourceUrl: string
): Promise<{ talkId: string; rawResponse: unknown }> {
  const audioBase64 = audioBuffer.toString("base64");

  const payload = {
    source_url: sourceUrl,
    script: {
      type: "audio",
      audio_base64: audioBase64,
    },
    config: {
      stitch: true,
    },
  };

  const response = await fetch(`${DID_BASE_URL}/talks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: didBasicAuthHeader(didApiKey),
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text().catch(() => "");
  const parsed = safeParseJson(rawText);
  console.info("[vc-video][did][create] response", {
    status: response.status,
    body: parsed,
  });

  if (!response.ok) {
    throw new Error(`D-ID POST /talks failed: ${response.status} ${rawText}`.trim());
  }

  const talkId =
    typeof (parsed as any)?.id === "string"
      ? String((parsed as any).id).trim()
      : "";

  if (!talkId) {
    throw new Error("D-ID POST /talks succeeded but response missing id");
  }

  return { talkId, rawResponse: parsed };
}

export async function pollVideo(talkId: string, didApiKey: string): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  const auth = didBasicAuthHeader(didApiKey);

  while (Date.now() - startedAt < DID_POLL_TIMEOUT_MS) {
    const response = await fetch(`${DID_BASE_URL}/talks/${encodeURIComponent(talkId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: auth,
      },
    });

    const rawText = await response.text().catch(() => "");
    const parsed = safeParseJson(rawText);
    const statusRaw = typeof (parsed as any)?.status === "string" ? String((parsed as any).status) : "";
    const status = statusRaw.toLowerCase();

    console.info("[vc-video][did][poll] response", {
      talkId,
      httpStatus: response.status,
      status: statusRaw || "(missing)",
      body: parsed,
    });

    if (!response.ok) {
      throw new Error(`D-ID poll failed: ${response.status} ${rawText}`.trim());
    }

    if (status && status !== lastStatus) {
      console.info("[vc-video][did][poll] status transition", {
        talkId,
        from: lastStatus || "(start)",
        to: status,
      });
      lastStatus = status;
    }

    if (status === "done") {
      const resultUrl =
        typeof (parsed as any)?.result_url === "string"
          ? String((parsed as any).result_url).trim()
          : typeof (parsed as any)?.result?.url === "string"
            ? String((parsed as any).result.url).trim()
            : "";

      if (!resultUrl) {
        throw new Error("D-ID status=done but result_url is missing");
      }

      console.info("[vc-video][did][done] final result_url", {
        talkId,
        result_url: resultUrl,
      });

      return resultUrl;
    }

    if (status === "error" || status === "failed" || status === "rejected") {
      throw new Error(`D-ID returned terminal status=${status}: ${rawText}`.trim());
    }

    await new Promise((resolve) => setTimeout(resolve, DID_POLL_INTERVAL_MS));
  }

  throw new Error(`D-ID polling timed out after ${DID_POLL_TIMEOUT_MS}ms for talkId=${talkId}`);
}

export function registerVcVideoRoute(app: express.Express) {
  app.post("/api/vc-video", async (req: express.Request, res: express.Response) => {
    try {
      const body = (req.body ?? {}) as VcVideoRequest;

      const didApiKey = getOptionalEnv("DID_API_KEY");
      if (!didApiKey) {
        return res.status(500).json({
          error: "DID_API_KEY missing",
          video: "",
          videoUrl: "",
          cached: false,
        } satisfies VcVideoResponse);
      }

      const avatarSource = getOptionalEnv("DID_AVATAR_SOURCE_URL") || DEFAULT_AVATAR_SOURCE;

      const rawPersona = typeof body.personaId === "string" ? body.personaId.trim().toLowerCase() : "";
      const personaId: PersonaId = VALID_PERSONAS.has(rawPersona)
        ? (rawPersona as PersonaId)
        : "analyst";

      const audioBuf = await resolveAudioBuffer(body);
      if (!audioBuf || audioBuf.length === 0) {
        return res.status(400).json({
          error: "Missing audio payload: provide audioBase64 or audioUrl",
          video: "",
          videoUrl: "",
          cached: false,
        } satisfies VcVideoResponse);
      }

      const hash = computeHash(personaId, audioBuf);
      const cachedUrl = videoCache.get(hash);
      if (cachedUrl) {
        console.info("[vc-video] cache hit", { hash: hash.slice(0, 12), personaId, video: cachedUrl });
        return res.status(200).json({
          video: cachedUrl,
          videoUrl: cachedUrl,
          cached: true,
        } satisfies VcVideoResponse);
      }

      const create = await createDidTalk(audioBuf, didApiKey, avatarSource);
      const resultUrl = await pollVideo(create.talkId, didApiKey);

      if (!resultUrl) {
        throw new Error("pollVideo returned empty result URL");
      }

      videoCache.set(hash, resultUrl);

      const responsePayload: VcVideoResponse = {
        video: resultUrl,
        videoUrl: resultUrl,
        talkId: create.talkId,
        cached: false,
      };

      console.info("[vc-video] response payload", responsePayload);
      return res.status(200).json(responsePayload);
    } catch (err) {
      const message = toErrorMessage(err);
      console.error("[vc-video] unhandled error", err);
      return res.status(502).json({
        error: message,
        video: "",
        videoUrl: "",
        cached: false,
      } satisfies VcVideoResponse);
    }
  });
}
