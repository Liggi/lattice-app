import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import ChatApp from './chat/ChatApp';
import { ErrorBoundary, AppErrorFallback } from './chat/components/ErrorBoundary';

function App(): JSX.Element {
  return (
    <ErrorBoundary
      name="App"
      fallback={(error, reset) => <AppErrorFallback error={error} reset={reset} />}
    >
      <Router
        future={{
          // v7_startTransition disabled - was causing multi-second navigation delays
          // React deferred navigations indefinitely while other work was pending
          v7_startTransition: false,
          v7_relativeSplatPath: true,
        }}
      >
        <Routes>
          <Route path="/*" element={<ChatApp />} />
        </Routes>
      </Router>
    </ErrorBoundary>
  );
}

export default App;
