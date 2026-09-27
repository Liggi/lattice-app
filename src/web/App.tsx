import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import ChatApp from './chat/ChatApp';
import { ErrorBoundary, AppErrorFallback } from './chat/components/ErrorBoundary';
import { AuthGate } from './chat/components/AuthGate/AuthGate';

function App(): JSX.Element {
  return (
    <ErrorBoundary
      name="App"
      fallback={(error, reset) => <AppErrorFallback error={error} reset={reset} />}
    >
      <Router
        // No startTransition: it caused multi-second navigation delays, as
        // React deferred navigations indefinitely while other work was pending
        useTransitions={false}
      >
        <Routes>
          <Route path="/*" element={<AuthGate><ChatApp /></AuthGate>} />
        </Routes>
      </Router>
    </ErrorBoundary>
  );
}

export default App;
