import crypto from "crypto";
import type express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

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
const DID_POLL_INTERVAL_MS = 800; // Reduced from 1500ms
const DID_POLL_TIMEOUT_MS = 60000;

const DEFAULT_AVATAR_SOURCE =
  "https://d-id-public-bucket.s3.us-west-2.amazonaws.com/alice.jpg";

function getOptionalEnv(name: string): string | undefined {
  const v = process.env[name];
  const trimmed = typeof v === "string" ? v.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function getRequiredEnv(name: string): string {
  const v = getOptionalEnv(name);
  if (!v) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return v;
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
      const resp = await fetch(body.audioUrl.trim(), {
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.error("[vc-video] audioUrl fetch failed", {
          status: resp.status,
          body: txt,
        });
        return null;
      }

      return Buffer.from(await resp.arrayBuffer());
    }
  } catch (err) {
    console.error("[vc-video] resolveAudioBuffer error", err);
  }

  return null;
}

/**
 * Upload audio buffer to S3 and return a public HTTPS URL
 */
async function uploadAudioToS3(audioBuffer: Buffer): Promise<string> {
  console.log("[vc-video] Uploading audio to S3");

  const bucket = getRequiredEnv("S3_BUCKET");
  const region = getRequiredEnv("AWS_REGION");
  const accessKeyId = getRequiredEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = getRequiredEnv("AWS_SECRET_ACCESS_KEY");

  const s3Client = new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const filename = `audio-${crypto.randomUUID()}.mp3`;
  const key = `vc-audio/${filename}`;

  try {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: audioBuffer,
      ContentType: "audio/mpeg",
      ACL: "public-read",
    });

    await s3Client.send(command);

    const audioUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
    console.log("[vc-video] Audio URL:", audioUrl);

    return audioUrl;
  } catch (err) {
    console.error("[vc-video] S3 upload failed:", err);
    throw new Error(`Failed to upload audio to S3: ${toErrorMessage(err)}`);
  }
}

async function createDidTalk(
  audioBuffer: Buffer,
  didApiKey: string,
  sourceUrl: string
): Promise<{ talkId: string; rawResponse: unknown }> {
  // Upload audio to S3 first
  const uploadedAudioUrl = await uploadAudioToS3(audioBuffer);

  const payload = {
    source_url: sourceUrl,
    script: {
      type: "audio",
      audio_url: uploadedAudioUrl,
    },
    config: {
      stitch: true,
    },
  };

  console.log("[vc-video][did] Creating talk with audio_url:", uploadedAudioUrl);

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
    console.error("[vc-video][did][create] failed", {
      status: response.status,
      response: rawText,
    });
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

  console.log("[vc-video][did][poll] Starting immediate polling for talkId:", talkId);

  // Start polling immediately
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

    const statusRaw =
      typeof (parsed as any)?.status === "string"
        ? String((parsed as any).status)
        : "";

    const status = statusRaw.toLowerCase();

    console.info("[vc-video][did][poll] response", {
      talkId,
      httpStatus: response.status,
      status: statusRaw || "(missing)",
      body: parsed,
    });

    if (!response.ok) {
      console.error("[vc-video][did][poll] failed", {
        talkId,
        status: response.status,
        response: rawText,
      });
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
        console.error("[vc-video][did][done] result_url missing", { talkId, parsed });
        throw new Error("D-ID status=done but result_url is missing");
      }

      console.info("[vc-video][did][done] final result_url", {
        talkId,
        result_url: resultUrl,
      });

      return resultUrl;
    }

    if (status === "error" || status === "failed" || status === "rejected") {
      console.error("[vc-video][did][error] terminal status", {
        talkId,
        status,
        response: rawText,
      });
      throw new Error(`D-ID returned terminal status=${status}: ${rawText}`.trim());
    }

    await new Promise((resolve) => setTimeout(resolve, DID_POLL_INTERVAL_MS));
  }

  console.error("[vc-video][did][timeout]", {
    talkId,
    lastStatus,
    timeoutMs: DID_POLL_TIMEOUT_MS,
  });

  throw new Error(`D-ID polling timed out after ${DID_POLL_TIMEOUT_MS}ms for talkId=${talkId}`);
}

export function registerVcVideoRoute(app: express.Express) {
  app.post("/api/vc-video", async (req: express.Request, res: express.Response) => {
    try {
      const body = (req.body ?? {}) as VcVideoRequest;

      const didApiKey = getOptionalEnv("DID_API_KEY");

      if (!didApiKey) {
        console.error("[vc-video] DID_API_KEY missing");
        return res.status(500).json({
          error: "DID_API_KEY missing",
          video: "",
          videoUrl: "",
          cached: false,
        });
      }

      const avatarSource =
        getOptionalEnv("DID_AVATAR_SOURCE_URL") || DEFAULT_AVATAR_SOURCE;

      const rawPersona =
        typeof body.personaId === "string"
          ? body.personaId.trim().toLowerCase()
          : "";

      const personaId: PersonaId = VALID_PERSONAS.has(rawPersona)
        ? (rawPersona as PersonaId)
        : "analyst";

      const audioBuf = await resolveAudioBuffer(body);

      if (!audioBuf || audioBuf.length === 0) {
        console.error("[vc-video] Missing audio payload");
        return res.status(400).json({
          error: "Missing audio payload",
          video: "",
          videoUrl: "",
          cached: false,
        });
      }

      const hash = computeHash(personaId, audioBuf);
      const cachedUrl = videoCache.get(hash);

      if (cachedUrl) {
        console.info("[vc-video] cache hit", { hash: hash.slice(0, 12), personaId, video: cachedUrl });
        return res.status(200).json({
          video: cachedUrl,
          videoUrl: cachedUrl,
          cached: true,
        });
      }

      console.log("[vc-video] Creating D-ID talk for persona:", personaId);

      const create = await createDidTalk(audioBuf, didApiKey, avatarSource);
      const resultUrl = await pollVideo(create.talkId, didApiKey);

      videoCache.set(hash, resultUrl);

      console.info("[vc-video] success", {
        personaId,
        talkId: create.talkId,
        videoUrl: resultUrl,
      });

      return res.status(200).json({
        video: resultUrl,
        videoUrl: resultUrl,
        talkId: create.talkId,
        cached: false,
      });
    } catch (err) {
      const message = toErrorMessage(err);

      console.error("[vc-video] error", {
        message,
        error: err,
        stack: err instanceof Error ? err.stack : undefined,
      });

      return res.status(502).json({
        error: message,
        video: "",
        videoUrl: "",
        cached: false,
      });
    }
  });
}
