import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

const steps = [
  { num: "01", title: "Set Up Your Profile", desc: "Enter your startup name, industry, stage, and funding goal." },
  { num: "02", title: "Choose Your VC", desc: "Select from multiple investor personas with unique styles." },
  { num: "03", title: "Pitch Live", desc: "Activate your webcam and mic. Present your startup to the VC." },
  { num: "04", title: "Get Scored", desc: "Receive detailed feedback, scores, and actionable improvements." },
];

const HowItWorks = () => {
  return (
    <section id="how-it-works" className="relative py-32">
      <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-border to-transparent" />
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mb-16 text-center"
        >
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-primary">
            How It Works
          </p>
          <h2 className="mb-4 text-4xl font-bold text-foreground md:text-5xl">
            Four Steps to <span className="text-gradient-primary">Investor Ready</span>
          </h2>
        </motion.div>

        <div className="mx-auto grid max-w-4xl gap-8 md:grid-cols-2">
          {steps.map((step, i) => (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, x: i % 2 === 0 ? -20 : 20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.15 }}
              className="flex gap-5 rounded-xl border border-border bg-card p-6"
            >
              <span className="text-3xl font-extrabold text-gradient-primary">{step.num}</span>
              <div>
                <h3 className="mb-1 text-lg font-semibold text-foreground">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mt-24 text-center"
        >
          <div className="mx-auto max-w-2xl rounded-2xl border border-primary/20 bg-primary/5 p-12">
            <h3 className="mb-4 text-3xl font-bold text-foreground">
              Ready to Face the Investors?
            </h3>
            <p className="mb-8 text-muted-foreground">
              Your next fundraise starts with better preparation. Practice until you're unshakable.
            </p>
            <Link to="/pitch">
              <Button variant="hero" size="xl">
                Launch Pitch Session
                <ArrowRight className="ml-1 h-5 w-5" />
              </Button>
            </Link>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default HowItWorks;
