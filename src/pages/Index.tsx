import Navbar from "@/components/layout/Navbar";
import Hero from "@/components/landing/Hero";
import Features from "@/components/landing/Features";
import VCPersonas from "@/components/landing/VCPersonas";
import HowItWorks from "@/components/landing/HowItWorks";
import { Zap } from "lucide-react";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <Hero />
      <Features />
      <VCPersonas />
      <HowItWorks />

      {/* Footer */}
      <footer className="border-t border-border py-12">
        <div className="container mx-auto flex flex-col items-center gap-4 px-6 text-center">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-primary">
              <Zap className="h-3.5 w-3.5 text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground">PitchVC AI</span>
          </div>
          <p className="text-xs text-muted-foreground">
            © 2026 PitchVC AI. Practice pitching. Raise smarter.
          </p>
        </div>
      </footer>
    </div>
  );
};

export default Index;
