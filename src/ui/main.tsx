import { t } from './i18n.ts';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { serverState } from './server-state.ts';
import { App } from './App.tsx';
import './fonts/fonts.css';
import './appearance.css';
import './style.css';
import './shell.css';
import './file-viewer.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="fatal">
        <h1>{t('页面暂时无法显示')}</h1>
        <p>{t('已保存的数据仍在本机，可以重新加载后继续。')}</p>
        <button onClick={() => location.reload()}>{t('重新加载')}</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <QueryClientProvider client={serverState}>
      <App />
    </QueryClientProvider>
  </ErrorBoundary>,
);
