import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Rendered instead of the 3D scene when WebGL fails (no GPU, context lost, driver bug). */
  fallback: (error: Error) => ReactNode;
}

interface State {
  error: Error | null;
}

/** A broken 3D context must never take the whole app down: fall back to the list view. */
export class SceneBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('3D scene failed:', error, info.componentStack);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
