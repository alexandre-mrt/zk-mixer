import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary] Uncaught error:", error, info);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
          <div className="w-full max-w-md rounded-xl border border-red-800 bg-red-950 p-6 text-center shadow-lg">
            <h2 className="mb-2 text-lg font-semibold text-red-300">
              Something went wrong
            </h2>
            <p className="mb-4 text-sm text-red-400">
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded-lg border border-red-700 bg-red-900 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-800"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
