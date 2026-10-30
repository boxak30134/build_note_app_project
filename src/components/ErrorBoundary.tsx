import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 오류 시 대체 UI. 생략하면 기본 안내 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** 이 키가 바뀌면 오류 상태를 초기화 */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

/** 한 영역의 렌더링 오류가 앱 전체를 하얀 화면으로 만들지 않도록 격리 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[EduInk] 렌더링 오류', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-slate-500">
        <p>이 영역을 표시하는 중 오류가 발생했습니다.</p>
        <p className="max-w-md break-words font-mono text-xs text-red-500">{error.message}</p>
        <button className="btn-primary" onClick={this.reset}>
          다시 시도
        </button>
      </div>
    );
  }
}
