import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import Navbar from "@/components/layout/Navbar";
import { useEffect, useMemo, useState } from "react";
import { getSessions, type Session } from "@/lib/sessions";
import {
  Play,
  Clock,
  TrendingUp,
  BarChart3,
  Plus,
  Calendar,
  Star,
} from "lucide-react";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDuration(sec?: number): string {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function scoreColor(s: number): string {
  return s >= 80 ? "text-emerald-400" : s >= 60 ? "text-accent" : "text-destructive";
}

const Dashboard = () => {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    const refresh = () => setSessions(getSessions());
    refresh();
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);

  const stats = useMemo(() => {
    const total = sessions.length;
    const completed = sessions.filter((s) => s.status === "completed").length;
    const totalTimeSec = sessions.reduce((acc, s) => acc + (s.durationSec ?? 0), 0);

    const scored = sessions
      .map((s) => s.metrics?.overallScore)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const avgScore = scored.length > 0 ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
    const bestScore = scored.length > 0 ? Math.max(...scored) : null;

    return {
      total,
      completed,
      totalTimeLabel: formatDuration(totalTimeSec),
      avgScoreLabel: avgScore === null ? "—" : String(avgScore),
      bestScoreLabel: bestScore === null ? "—" : String(bestScore),
    };
  }, [sessions]);

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto px-6 pt-24 pb-16">
        {/* Header */}
        <div className="mb-10 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
            <p className="mt-1 text-muted-foreground">Track your pitch performance over time.</p>
          </div>
          <Link to="/pitch">
            <Button variant="hero">
              <Plus className="mr-2 h-4 w-4" />
              New Session
            </Button>
          </Link>
        </div>

        {/* Stats */}
        <div className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Play, label: "Total Sessions", value: String(stats.total) },
            { icon: Clock, label: "Completed Sessions", value: String(stats.completed) },
            { icon: TrendingUp, label: "Avg Score", value: stats.avgScoreLabel },
            { icon: Star, label: "Best Score", value: stats.bestScoreLabel },
          ].map((stat) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-border bg-card p-6"
            >
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <stat.icon className="h-5 w-5 text-primary" />
              </div>
              <p className="text-2xl font-bold text-foreground">{stat.value}</p>
              <p className="text-sm text-muted-foreground">{stat.label}</p>
            </motion.div>
          ))}
        </div>

        {/* Session history */}
        <div>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Session History</h2>
          {sessions.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-8">
              <p className="text-sm text-muted-foreground">No sessions yet.</p>
              <div className="mt-4">
                <Link to="/pitch">
                  <Button variant="hero">
                    <Plus className="mr-2 h-4 w-4" />
                    Start Your First Session
                  </Button>
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {sessions.map((session, i) => {
                const score = session.metrics?.overallScore;
                return (
                  <motion.div
                    key={session.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex items-center justify-between rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/20"
                  >
                    <div className="flex items-center gap-5">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
                        <BarChart3 className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{session.personaName}</p>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {formatDate(session.createdAt)}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatDuration(session.durationSec)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-5">
                      <div className="text-right">
                        {typeof score === "number" ? (
                          <p className={`text-xl font-bold ${scoreColor(score)}`}>{score}</p>
                        ) : (
                          <p className="text-xl font-bold text-muted-foreground">—</p>
                        )}
                        <p className="text-xs text-muted-foreground">Score</p>
                      </div>
                      <Link to={`/results/${session.id}`}>
                        <Button variant="outline" size="sm">
                          Review
                        </Button>
                      </Link>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
