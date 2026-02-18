import type express from "express";

function getOptionalEnv(name: string): string | undefined {
  const v = process.env[name];
  const trimmed = typeof v === "string" ? v.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

export function registerTtsRoute(app: express.Express) {
  app.post("/api/tts", async (req, res) => {
    const apiKey = getOptionalEnv("ELEVENLABS_API_KEY");
    if (!apiKey) return res.status(500).json({ error: "ELEVENLABS_API_KEY missing" });

    const body = (req.body ?? {}) as any;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "Missing text" });
    if (text.length > 800) return res.status(400).json({ error: "Text too long (max 800 chars)" });

    const voiceId = getOptionalEnv("ELEVENLABS_VOICE_ID") || "21m00Tcm4TlvDq8ikWAM";
    const modelId = (process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2").trim();

    try {
      const elevenUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
      const upstream = await fetch(elevenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.8,
          },
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => "");
        return res.status(502).json({ error: `ElevenLabs error: ${upstream.status} ${errText}`.trim() });
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");

      // eslint-disable-next-line no-console
      console.log("TTS generated");
      return res.status(200).send(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });
}
