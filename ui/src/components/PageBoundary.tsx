import { Component, type ReactNode } from "react";

/** Keeps one broken page (a render error, a chunk that failed to load) from blanking the
 *  whole window: the shell, approvals drawer and other tabs stay usable. Keyed by view
 *  in App so switching tabs gives the page a fresh try. */
export class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page-error">
        <h3>This page hit an error</h3>
        <p>{error.message}</p>
        <button className="act" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
