import { motion } from "framer-motion";
import { Flame, LineChart, Heart, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

const personas = [
  {
    icon: Flame,
    name: "The Shark",
    style: "Aggressive Silicon Valley VC",
    description: "Rapid-fire questions, zero patience for fluff. Demands numbers, traction, and a clear path to $1B.",
    traits: ["Direct", "Skeptical", "Data-driven"],
    color: "text-destructive",
    borderColor: "hover:border-destructive/40",
  },
  {
    icon: LineChart,
    name: "The Analyst",
    style: "Analytical Fintech Investor",
    description: "Deep dives into unit economics, CAC/LTV, burn rate, and financial projections. Loves spreadsheets.",
    traits: ["Methodical", "Detail-oriented", "Quantitative"],
    color: "text-primary",
    borderColor: "hover:border-primary/40",
  },
  {
    icon: Heart,
    name: "The Mentor",
    style: "Friendly Seed-Stage Advisor",
    description: "Supportive but honest. Focuses on vision, team, and product-market fit. Helps you find your story.",
    traits: ["Encouraging", "Insightful", "Constructive"],
    color: "text-accent",
    borderColor: "hover:border-accent/40",
  },
  {
    icon: Rocket,
    name: "The Operator",
    style: "Growth-Stage Operator VC",
    description: "Cares about execution, hiring, go-to-market, and scaling. Tests your operational readiness.",
    traits: ["Pragmatic", "Execution-focused", "Strategic"],
    color: "text-emerald-400",
    borderColor: "hover:border-emerald-400/40",
  },
];

const VCPersonas = () => {
  return (
    <section id="personas" className="relative py-32">
      <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-border to-transparent" />
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mb-16 text-center"
        >
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-accent">
            VC Styles
          </p>
          <h2 className="mb-4 text-4xl font-bold text-foreground md:text-5xl">
            Choose Your <span className="text-gradient-accent">Investor</span>
          </h2>
          <p className="mx-auto max-w-2xl text-lg text-muted-foreground">
            Each VC persona has a unique personality, questioning style, and focus areas.
          </p>
        </motion.div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {personas.map((persona, i) => (
            <motion.div
              key={persona.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className={`group flex flex-col rounded-xl border border-border bg-card p-7 transition-all duration-300 ${persona.borderColor}`}
            >
              <div className={`mb-4 ${persona.color}`}>
                <persona.icon className="h-8 w-8" />
              </div>
              <h3 className="mb-1 text-xl font-bold text-foreground">{persona.name}</h3>
              <p className="mb-3 text-xs font-medium text-muted-foreground">{persona.style}</p>
              <p className="mb-5 flex-1 text-sm leading-relaxed text-muted-foreground">{persona.description}</p>
              <div className="flex flex-wrap gap-2">
                {persona.traits.map((trait) => (
                  <span
                    key={trait}
                    className="rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground"
                  >
                    {trait}
                  </span>
                ))}
              </div>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="mt-16 text-center"
        >
          <Link to="/pitch">
            <Button variant="hero" size="lg">
              Pick a VC & Start Pitching
            </Button>
          </Link>
        </motion.div>
      </div>
    </section>
  );
};

export default VCPersonas;
