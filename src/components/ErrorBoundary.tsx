import React from "react";

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  errorMessage?: string;
  errorStack?: string;
  componentStack?: string;
};

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    // eslint-disable-next-line no-console
    console.error("Runtime error in UI", error, info);

    const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown error");
    const componentStack =
      typeof (info as any)?.componentStack === "string" ? String((info as any).componentStack) : undefined;

    this.setState({
      errorMessage: err.message,
      errorStack: err.stack,
      componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background px-6 py-10 text-foreground">
          <div className="mx-auto max-w-xl rounded-lg border border-border bg-card p-6">
            <h1 className="text-lg font-semibold">Runtime error – check console</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The app hit an unexpected runtime error while rendering this page.
            </p>

            <div className="mt-4 rounded-md border border-border bg-background p-3 text-xs text-foreground">
              <div className="font-semibold">First error</div>
              <pre className="mt-2 whitespace-pre-wrap break-words">
                {this.state.errorMessage || "(no message)"}
              </pre>
              {this.state.errorStack ? (
                <>
                  <div className="mt-3 font-semibold">Stack</div>
                  <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">
                    {this.state.errorStack}
                  </pre>
                </>
              ) : null}
              {this.state.componentStack ? (
                <>
                  <div className="mt-3 font-semibold">Component stack</div>
                  <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">
                    {this.state.componentStack}
                  </pre>
                </>
              ) : null}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
