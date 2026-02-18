import type * as http from "http";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { WebSocket, WebSocketServer } from "ws";

function getOptionalEnv(name: string): string | undefined {
  const v = process.env[name];
  const trimmed = typeof v === "string" ? v.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function deepgramUrl(): string {
  const base = "wss://api.deepgram.com/v1/listen";
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
  return `${base}?${params.toString()}`;
}

function byteLength(data: WebSocket.RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((acc, v) => acc + (Buffer.isBuffer(v) ? v.length : 0), 0);
  try {
    // ws may pass a Uint8Array-like
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyData = data as any;
    if (typeof anyData?.byteLength === "number") return anyData.byteLength;
  } catch {
    // ignore
  }
  return 0;
}

export function attachSttWebSocket(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!req.url) return;
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname !== "/api/stt") return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (clientWs: WebSocket) => {
    const dgKey = getOptionalEnv("DEEPGRAM_API_KEY");
    if (!dgKey) {
      try {
        clientWs.send(JSON.stringify({ type: "error", message: "DEEPGRAM_API_KEY missing" }));
      } catch {
        // ignore
      }
      clientWs.close();
      return;
    }

    // eslint-disable-next-line no-console
    console.log("WS client connected");

    let dgWs: WebSocket | null = null;
    const pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    const MAX_PENDING_BYTES = 2 * 1024 * 1024; // 2MB safety cap

    dgWs = new WebSocket(deepgramUrl(), {
      headers: {
        Authorization: `Token ${dgKey}`,
      },
    });

    dgWs.on("open", () => {
      // eslint-disable-next-line no-console
      console.log("DG open");

      if (pendingChunks.length > 0) {
        for (const chunk of pendingChunks) {
          try {
            dgWs?.send(chunk);
          } catch {
            // ignore
          }
        }
        pendingChunks.length = 0;
        pendingBytes = 0;
      }

      try {
        clientWs.send(JSON.stringify({ type: "stt-ready" }));
      } catch {
        // ignore
      }
    });

    dgWs.on("message", (data: WebSocket.RawData) => {
      try {
        const str = typeof data === "string" ? data : data.toString();
        const evt = JSON.parse(str) as any;

        const evtType = typeof evt?.type === "string" ? String(evt.type).toLowerCase() : "";
        if (evtType.includes("error")) {
          const msg = typeof evt?.message === "string" ? evt.message : typeof evt?.error === "string" ? evt.error : str;
          // eslint-disable-next-line no-console
          console.log(`DG error payload: ${msg}`);
          try {
            clientWs.send(JSON.stringify({ type: "error", message: msg }));
          } catch {
            // ignore
          }
          try {
            clientWs.close();
          } catch {
            // ignore
          }
          try {
            dgWs?.close();
          } catch {
            // ignore
          }
          return;
        }

        const alt = evt?.channel?.alternatives?.[0];
        const transcript: string = alt?.transcript || "";
        const isFinal: boolean = Boolean(evt?.is_final || evt?.speech_final);

        if (typeof transcript === "string" && transcript.trim().length > 0) {
          // eslint-disable-next-line no-console
          console.log(`DG transcript: ${transcript} final=${isFinal}`);
          clientWs.send(JSON.stringify({ type: "transcript", text: transcript, is_final: isFinal }));
        }
      } catch {
        // ignore
      }
    });

    dgWs.on("close", (code: number, reason: Buffer) => {
      // eslint-disable-next-line no-console
      console.log(`DG close code=${code} reason=${reason?.toString?.() || ""}`);
      try {
        clientWs.send(JSON.stringify({ type: "stt-closed" }));
      } catch {
        // ignore
      }
    });

    dgWs.on("error", (err: Error) => {
      // eslint-disable-next-line no-console
      console.log(`DG error ${err.message}`);
      try {
        clientWs.send(JSON.stringify({ type: "error", message: err.message }));
      } catch {
        // ignore
      }
      try {
        clientWs.close();
      } catch {
        // ignore
      }
      try {
        dgWs?.close();
      } catch {
        // ignore
      }
    });

    clientWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        // eslint-disable-next-line no-console
        console.log(`received chunk bytes=${byteLength(data)}`);
        const bytes = byteLength(data);

        // Convert RawData to Buffer for buffering/forwarding.
        const buf =
          Buffer.isBuffer(data)
            ? data
            : typeof data === "string"
              ? Buffer.from(data)
              : data instanceof ArrayBuffer
                ? Buffer.from(new Uint8Array(data))
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(data as any);

        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(buf);
          return;
        }

        // Buffer until DG is open.
        if (pendingBytes + bytes <= MAX_PENDING_BYTES) {
          pendingChunks.push(buf);
          pendingBytes += bytes;
        }
        return;
      }

      if (!dgWs || dgWs.readyState !== WebSocket.OPEN) return;

      try {
        const str = typeof data === "string" ? data : data.toString();
        const msg = JSON.parse(str) as any;
        if (msg?.type === "finalize") {
          dgWs.send(JSON.stringify({ type: "Finalize" }));
        }
      } catch {
        // ignore
      }
    });

    clientWs.on("close", () => {
      // eslint-disable-next-line no-console
      console.log("DG close");
      try {
        dgWs?.close();
      } catch {
        // ignore
      }
      dgWs = null;
    });

    clientWs.on("error", () => {
      // eslint-disable-next-line no-console
      console.log("DG error");
    });
  });

  return wss;
}
