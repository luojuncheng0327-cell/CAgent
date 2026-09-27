import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './fonts/fonts.css';
import './appearance.css';
import './style.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="fatal">
        <h1>页面暂时无法显示</h1>
        <p>已保存的数据仍在本机，可以重新加载后继续。</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
