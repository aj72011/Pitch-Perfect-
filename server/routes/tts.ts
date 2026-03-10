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
      console.log("TTS request text:", text);
      console.log("TTS using voice ID:", voiceId);
      console.log("TTS using model ID:", modelId);
      
      const elevenUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
      const upstream = await fetch(elevenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: text,
          model_id: modelId,
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => "");
        console.error("TTS ElevenLabs error:", upstream.status, errText);
        return res.status(502).json({ error: `ElevenLabs error: ${upstream.status} ${errText}`.trim() });
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");

      console.log("TTS generated successfully, audio size:", buf.length, "bytes");
      return res.status(200).send(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("TTS error:", message);
      return res.status(500).json({ error: message });
    }
  });
}
