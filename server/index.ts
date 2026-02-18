import "dotenv/config";

import cors from "cors";
import express from "express";
import * as http from "http";
import { attachSttWebSocket } from "./routes/stt.js";
import { registerTtsRoute } from "./routes/tts.js";
import { registerVcReplyRoute } from "./routes/vc-reply.js";
import { registerVcVideoRoute } from "./routes/vc-video.js";

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function getOptionalEnv(name: string): string | undefined {
  const v = process.env[name];
  const trimmed = typeof v === "string" ? v.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeJsonParse(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function coerceString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function coerceArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function truncateText(input: string, maxChars: number): string {
  const t = input.replace(/\s+/g, " ").trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0) return t;
  return t.length > maxChars ? t.slice(0, maxChars).trim() : t;
}

async function readBodyJson(req: express.Request): Promise<Record<string, unknown>> {
  const body = safeJsonParse(req.body);
  if (!body) throw new Error("Invalid JSON body");
  return body;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: [/^http:\/\/localhost:\d+$/],
    credentials: true,
  })
);

app.get("/api/health", (_req: express.Request, res: express.Response) => {
  res.json({ ok: true });
});

app.get("/api/ping", (_req: express.Request, res: express.Response) => {
  res.json({ ok: true });
});

// Core API routes
registerVcReplyRoute(app);
registerTtsRoute(app);
registerVcVideoRoute(app);

app.get("/api/stt-token", async (_req: express.Request, res: express.Response) => {
  try {
    const apiKey = mustGetEnv("DEEPGRAM_API_KEY");
    const projectId = getOptionalEnv("DEEPGRAM_PROJECT_ID");
    const rawTtl = Number(process.env.DEEPGRAM_STT_TOKEN_TTL_SEC || 600);
    const ttlSeconds = Number.isFinite(rawTtl) ? Math.max(60, Math.min(1800, rawTtl)) : 600;

    res.setHeader("Cache-Control", "no-store");

    // Preferred: create a short-lived scoped key server-side.
    if (projectId) {
      const url = `https://api.deepgram.com/v1/projects/${encodeURIComponent(projectId)}/keys`;
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${apiKey}`,
        },
        body: JSON.stringify({
          comment: "ppai-stt-token",
          scopes: ["usage:write"],
          time_to_live_in_seconds: Number.isFinite(ttlSeconds) ? ttlSeconds : 600,
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => "");
        return res
          .status(502)
          .json({ error: `Deepgram token error: ${upstream.status} ${errText}`.trim() });
      }

      const json = (await upstream.json().catch(() => null)) as unknown;
      const key =
        typeof (json as any)?.key === "string"
          ? String((json as any).key)
          : typeof (json as any)?.api_key === "string"
            ? String((json as any).api_key)
            : null;

      if (!key || key.trim().length === 0) {
        return res.status(502).json({ error: "Deepgram token response missing key" });
      }

      return res.status(200).json({ key, expiresInSec: ttlSeconds, temporary: true });
    }

    // Never expose DEEPGRAM_API_KEY to the browser.
    return res.status(501).json({
      error:
        "Deepgram temp token not configured. Set DEEPGRAM_PROJECT_ID to mint short-lived tokens. Otherwise use the backend STT WebSocket proxy at /api/stt.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

const server = http.createServer(app);

attachSttWebSocket(server);

const port = Number(process.env.API_PORT || 8787);

server.on("error", (err: any) => {
  if (err?.code === "EADDRINUSE") {
    // eslint-disable-next-line no-console
    console.error(`API port ${port} already in use. If another API server is running, you can keep using it.`);
    // Exit 0 so `concurrently` doesn't kill the client dev server.
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error("API server failed to start", err);
  process.exit(1);
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API server listening on http://localhost:${port}`);
});
