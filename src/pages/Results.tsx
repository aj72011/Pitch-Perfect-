import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/sessions";

function getBestSlideText(slide: {
  finalText?: string;
  ocrText?: string;
  rawText?: string;
}): string {
  const t =
    (slide.finalText && slide.finalText.trim()) ||
    (slide.ocrText && slide.ocrText.trim()) ||
    (slide.rawText && slide.rawText.trim()) ||
    "";
  return t;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

const Results = () => {
  const { sessionId } = useParams<{ sessionId: string }>();

  const session = useMemo(() => {
    if (!sessionId) return null;
    return getSession(sessionId);
  }, [sessionId]);

  if (!sessionId || !session) {
    return (
      <div className="min-h-screen bg-background pt-24 pb-16">
        <div className="container mx-auto px-6">
          <div className="rounded-xl border border-border bg-card p-8">
            <h1 className="text-2xl font-bold text-foreground">Session not found</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We couldn’t find that session in local storage.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Link to="/dashboard">
                <Button variant="hero">Back to Dashboard</Button>
              </Link>
              <Link to="/pitch">
                <Button variant="outline">Start New Pitch</Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const transcriptSorted = [...session.transcript].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );

  return (
    <div className="min-h-screen bg-background pt-24 pb-16">
      <div className="container mx-auto px-6">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Session Report</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Persona: <span className="font-medium text-foreground">{session.personaName}</span>
              <span className="mx-2">·</span>
              Created: <span className="font-medium text-foreground">{formatDateTime(session.createdAt)}</span>
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link to="/pitch">
              <Button variant="hero">Start New Pitch</Button>
            </Link>
            <Link to="/dashboard">
              <Button variant="outline">Back to Dashboard</Button>
            </Link>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left: Transcript */}
          <div className="lg:col-span-2 rounded-xl border border-border bg-card">
            <div className="border-b border-border p-5">
              <h2 className="text-lg font-semibold text-foreground">Transcript</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Stored locally. No STT/LLM yet.
              </p>
            </div>
            <div className="space-y-4 p-5">
              {transcriptSorted.length === 0 ? (
                <p className="text-sm text-muted-foreground">No transcript messages yet.</p>
              ) : (
                transcriptSorted.map((m, i) => (
                  <div key={`${m.timestamp}_${i}`} className={`flex gap-3 ${m.role === "founder" ? "flex-row-reverse" : ""}`}>
                    <div
                      className={`max-w-[90%] rounded-xl px-4 py-3 text-sm ${
                        m.role === "vc" ? "bg-primary/10 text-foreground" : "bg-secondary text-foreground"
                      }`}
                    >
                      <p className="mb-1 text-xs font-medium text-muted-foreground">
                        {m.role === "vc" ? session.personaName : "You"} · {formatDateTime(m.timestamp)}
                      </p>
                      {m.content}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right: Score placeholders */}
          <div className="space-y-6">
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-lg font-semibold text-foreground">Scores (Placeholder)</h2>
              <div className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Overall</span>
                  <span className="font-semibold text-foreground">—</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Clarity</span>
                  <span className="font-semibold text-foreground">—</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Traction</span>
                  <span className="font-semibold text-foreground">—</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Market</span>
                  <span className="font-semibold text-foreground">—</span>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-lg font-semibold text-foreground">Deck Feedback (Placeholder)</h2>
              {session.deckId ? (
                <div className="mt-3 space-y-3">
                  {session.deckSummary ? (
                    <div className="space-y-2 text-sm">
                      <p className="text-foreground">
                        <span className="font-medium">One-liner:</span> {session.deckSummary.oneLiner || "unknown"}
                      </p>
                      <p className="text-foreground">
                        <span className="font-medium">Problem:</span> {session.deckSummary.problem || "unknown"}
                      </p>
                      <p className="text-foreground">
                        <span className="font-medium">Solution:</span> {session.deckSummary.solution || "unknown"}
                      </p>
                      <p className="text-foreground">
                        <span className="font-medium">Customer:</span> {session.deckSummary.customer || "unknown"}
                      </p>
                      <p className="text-foreground">
                        <span className="font-medium">Business model:</span> {session.deckSummary.businessModel || "unknown"}
                      </p>
                      <p className="text-foreground">
                        <span className="font-medium">Traction:</span> {session.deckSummary.traction || "unknown"}
                      </p>
                      <p className="text-foreground">
                        <span className="font-medium">Ask:</span> {session.deckSummary.ask || "unknown"}
                      </p>
                      <p className="text-muted-foreground">
                        <span className="font-medium">Missing slides:</span>{" "}
                        {session.deckSummary.missingSlides?.length
                          ? session.deckSummary.missingSlides.join(", ")
                          : "—"}
                      </p>
                      {session.memoryLayer?.unknownTopics?.length ? (
                        <p className="text-muted-foreground">
                          <span className="font-medium">Unknown topics:</span>{" "}
                          {session.memoryLayer.unknownTopics.join(", ")}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No deck summary available.</p>
                  )}
                  <div className="rounded-lg border border-border bg-background p-3">
                    <p className="text-xs font-medium text-muted-foreground">Extracted slides</p>
                    <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
                      {(session.extractedSlides ?? []).map((s, i) => (
                        <div key={`${s.index}_${i}`} className="rounded-md border border-border p-2">
                          <p className="text-xs text-muted-foreground">
                            Slide {s.slideNumber ?? s.index + 1} · Section: {s.detectedSection ?? "unknown"}
                            {typeof s.confidence === "number" ? ` · Conf: ${Math.round(s.confidence * 100)}%` : ""}
                          </p>
                          <p className="mt-1 text-xs text-foreground">
                            {(() => {
                              const text = getBestSlideText(s);
                              return `${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`;
                            })()}
                          </p>
                        </div>
                      ))}
                      {(session.extractedSlides ?? []).length === 0 && (
                        <p className="text-xs text-muted-foreground">No slides extracted.</p>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No deck uploaded for this session.</p>
              )}
            </div>

            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-lg font-semibold text-foreground">Shark Q/A (Placeholder)</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Persona-specific interrogation summaries will be generated later.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-lg font-semibold text-foreground">Action Items (Placeholder)</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Actionable improvements will be produced later.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-lg font-semibold text-foreground">Memory Layer (Debug)</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Rule-based keyword extraction for now.
              </p>
              <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-border bg-background p-3 text-xs text-foreground">
                {JSON.stringify(session.memoryLayer ?? null, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Results;
