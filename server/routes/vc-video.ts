import crypto from "crypto";
import type express from "express";

/* ------------------------------------------------------------------ */
/*  POST /api/vc-video                                                 */
/*  Non-blocking lip-sync video generation with SHA-256 cache.         */
/* ------------------------------------------------------------------ */

type PersonaId = "shark" | "analyst" | "mentor" | "operator";

interface VcVideoRequest {
  personaId: PersonaId;
  audioUrl?: string;
  audioBase64?: string;
}

interface VcVideoResponse {
  videoUrl: string;
  cached: boolean;
}

/* Simple in-memory cache: hash → videoUrl */
const videoCache = new Map<string, string>();

const VALID_PERSONAS = new Set<string>(["shark", "analyst", "mentor", "operator"]);

/* ------------------------------------------------------------------ */
/*  Placeholder: replace with real lip-sync API (e.g. Wav2Lip, D-ID,  */
/*  HeyGen, Synthesia, or a local model).                              */
/* ------------------------------------------------------------------ */
async function generateLipSyncVideo(
  _personaId: PersonaId,
  _audioBuffer: Buffer
): Promise<string> {
  // TODO: Integrate with a lip-sync video API.
  // Should return a publicly-accessible video URL.
  //
  // Example integrations:
  //   - D-ID:      POST https://api.d-id.com/talks  (avatar image + audio → video URL)
  //   - HeyGen:    POST https://api.heygen.com/v2/video/generate
  //   - Wav2Lip:   Local model server
  //
  // For now, return empty string so the frontend falls back to the
  // existing speaking animation loop (audio is never blocked).
  return "";
}

/* ------------------------------------------------------------------ */

function computeHash(personaId: string, audioBytes: Buffer): string {
  const h = crypto.createHash("sha256");
  h.update(personaId);
  h.update(audioBytes);
  return h.digest("hex");
}

async function resolveAudioBuffer(body: VcVideoRequest): Promise<Buffer | null> {
  try {
    // Prefer raw base64 (avoids an extra network round-trip).
    if (typeof body.audioBase64 === "string" && body.audioBase64.length > 0) {
      return Buffer.from(body.audioBase64, "base64");
    }

    // Fall back to downloading from URL.
    if (typeof body.audioUrl === "string" && body.audioUrl.length > 0) {
      const resp = await fetch(body.audioUrl, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    }
  } catch (err) {
    console.error("[vc-video] resolveAudioBuffer error", err);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Route registration                                                 */
/* ------------------------------------------------------------------ */

export function registerVcVideoRoute(app: express.Express) {
  app.post("/api/vc-video", async (req: express.Request, res: express.Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;

      // --- Validate personaId ---
      const rawPersona = typeof body.personaId === "string" ? body.personaId.trim().toLowerCase() : "";
      const personaId: PersonaId = VALID_PERSONAS.has(rawPersona)
        ? (rawPersona as PersonaId)
        : "analyst";

      // --- Resolve audio bytes ---
      const audioBuf = await resolveAudioBuffer(body as unknown as VcVideoRequest);
      if (!audioBuf || audioBuf.length === 0) {
        // No audio → nothing to lip-sync. Return graceful empty response.
        return res.status(200).json({ videoUrl: "", cached: false } satisfies VcVideoResponse);
      }

      // --- Cache check ---
      const hash = computeHash(personaId, audioBuf);
      const cached = videoCache.get(hash);
      if (cached) {
        console.info("[vc-video] cache hit", { hash: hash.slice(0, 12), personaId });
        return res.status(200).json({ videoUrl: cached, cached: true } satisfies VcVideoResponse);
      }

      // --- Generate lip-sync video ---
      const videoUrl = await generateLipSyncVideo(personaId, audioBuf);

      // Store in cache (even if empty — avoids repeated generation attempts for same audio).
      if (videoUrl) {
        videoCache.set(hash, videoUrl);
      }

      console.info("[vc-video] generated", { hash: hash.slice(0, 12), personaId, hasVideo: !!videoUrl });
      return res.status(200).json({ videoUrl: videoUrl || "", cached: false } satisfies VcVideoResponse);
    } catch (err) {
      // NEVER crash — always return a graceful fallback.
      console.error("[vc-video] unhandled error", err);
      return res.status(200).json({ videoUrl: "", cached: false } satisfies VcVideoResponse);
    }
  });
}
