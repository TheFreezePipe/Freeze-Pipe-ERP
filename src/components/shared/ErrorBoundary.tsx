import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { captureException } from "@/lib/observability";

/**
 * Catches render-time errors below a route and shows a recoverable message
 * instead of nuking the entire React tree to a black screen. React Query
 * errors that bubble up (the default for useQuery with throwOnError: true),
 * unhandled nulls in JSX, and TypeErrors from stale data shapes all land here.
 *
 * Placement: wrap the element of each top-level Route (or one wrapper
 * around <Outlet />) so errors stay scoped to that page rather than killing
 * the layout / sidebar too.
 */
interface Props {
  children: ReactNode;
  /** Optional label shown in the error banner, e.g. the page name. */
  fallbackContext?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    // Report render crashes to Sentry (live via observability.ts when a
    // DSN is configured; console in dev). The boundary's fallbackContext
    // is included so errors group by page/section.
    captureException(error, {
      tags: { boundary: this.props.fallbackContext ?? "unknown" },
      extra: { componentStack: info.componentStack },
    });
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <div className="rounded-full bg-red-500/10 p-3 mb-4">
          <AlertTriangle className="h-8 w-8 text-red-400" />
        </div>
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        {this.props.fallbackContext && (
          <p className="text-xs text-muted-foreground mt-1">
            while rendering <span className="font-mono">{this.props.fallbackContext}</span>
          </p>
        )}
        <p className="text-sm text-red-400 mt-3 max-w-lg break-words">
          {error.message || String(error)}
        </p>
        {info?.componentStack && (
          <details className="mt-4 max-w-2xl w-full">
            <summary className="text-xs text-muted-foreground cursor-pointer">Stack</summary>
            <pre className="mt-2 text-[10px] text-muted-foreground text-left overflow-x-auto p-3 rounded border border-border bg-muted/30">
              {info.componentStack}
            </pre>
          </details>
        )}
        <div className="flex gap-2 mt-6">
          <Button variant="outline" size="sm" onClick={this.reset}>
            <RefreshCcw className="mr-1.5 h-4 w-4" />
            Try again
          </Button>
          <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </div>
      </div>
    );
  }
}
