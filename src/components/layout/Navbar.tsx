import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Zap } from "lucide-react";

const Navbar = () => {
  const location = useLocation();
  const isLanding = location.pathname === "/";

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 glass-strong">
      <div className="container mx-auto flex h-16 items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-primary">
            <Zap className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="text-lg font-bold tracking-tight text-foreground">
            Pitch<span className="text-gradient-primary">VC</span>
          </span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {isLanding && (
            <>
              <a href="#features" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                Features
              </a>
              <a href="#personas" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                VC Styles
              </a>
              <a href="#how-it-works" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                How It Works
              </a>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Link to="/dashboard">
            <Button variant="ghost" size="sm">Dashboard</Button>
          </Link>
          <Link to="/pitch">
            <Button variant="hero" size="sm">Start Pitching</Button>
          </Link>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
