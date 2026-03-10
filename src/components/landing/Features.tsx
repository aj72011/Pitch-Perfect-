import { motion } from "framer-motion";
import {
  MessageSquare,
  BarChart3,
  Shield,
  Clock,
  Repeat,
  Target,
} from "lucide-react";

const features = [
  {
    icon: MessageSquare,
    title: "Live Conversation",
    description: "Natural voice dialogue with a VC that interrupts, follows up, and challenges your claims in real time.",
  },
  {
    icon: BarChart3,
    title: "Investor Scorecard",
    description: "Get scored on clarity, market understanding, financials, storytelling, and investor readiness after every session.",
  },
  {
    icon: Target,
    title: "Dynamic Questions",
    description: "Questions are generated based on your industry, stage, and claims. No two sessions are the same.",
  },
  {
    icon: Shield,
    title: "VC Persona Engine",
    description: "Choose from aggressive SV VCs, analytical fintech investors, friendly mentors, or growth operators.",
  },
  {
    icon: Repeat,
    title: "Replay & Learn",
    description: "Review session recordings, transcripts, filler word detection, and improvement suggestions.",
  },
  {
    icon: Clock,
    title: "Structured Sessions",
    description: "Warm intro → Pitch → Interrogation → Deep Dive → Feedback. Just like a real partner meeting.",
  },
];

const Features = () => {
  return (
    <section id="features" className="relative py-32">
      <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-border to-transparent" />
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mb-16 text-center"
        >
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-primary">
            Features
          </p>
          <h2 className="mb-4 text-4xl font-bold text-foreground md:text-5xl">
            Everything You Need to <span className="text-gradient-primary">Nail Your Pitch</span>
          </h2>
          <p className="mx-auto max-w-2xl text-lg text-muted-foreground">
            A complete pitch simulation platform designed to make you investor-ready.
          </p>
        </motion.div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="group rounded-xl border border-border bg-card p-8 transition-all duration-300 hover:border-primary/30 hover:shadow-glow"
            >
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 transition-colors group-hover:bg-primary/20">
                <feature.icon className="h-6 w-6 text-primary" />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-foreground">{feature.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Features;
