/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './components/Layout/Layout';
import { ConversationView } from './components/ConversationView/ConversationView';
import { NewSessionView } from './components/NewSessionView/NewSessionView';
import { CrossSessionSidebar } from './components/CrossSessionSidebar';
import { useConversations } from './contexts/ConversationsContext';
import { DevHub } from './components/DevHub/DevHub';
import { ChangelogPage } from './components/Changelog/ChangelogPage';
import { CollapsedGroupLab } from './components/CollapsedGroupCard/CollapsedGroupLab';
import { QueuedMessagesLab } from './components/ConversationView/QueuedMessagesLab';
import { AnnotatedMessageLab } from './components/MessageList/AnnotatedMessageLab';
import { MapIndexPage } from './components/LearningMap/MapIndexPage';
import { MapCanvasPage } from './components/LearningMap/MapCanvasPage';
import { FeedbackInboxPage } from './components/Feedback/FeedbackInboxPage';

import { ConversationsProvider } from './contexts/ConversationsContext';
import { ActivityStreamProvider } from './contexts/ActivityStreamContext';

import { PreferencesProvider } from './contexts/PreferencesContext';
import { ToastProvider } from './components/Toast/Toast';
import { TooltipProvider } from './components/ui/tooltip';
import { AttentionFaviconController } from './hooks/useAttentionFavicon';
import { useSessionTabNavigation } from './hooks/useSessionTabNavigation';
import { useSessionsSidebarState } from './hooks/useSessionsSidebarState';
import './styles/global.css';

// Initialize debug logger - captures console.warn to ~/lattice-debug.log
import './services/debug-logger';
import { api } from './services/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // 30 seconds before data is considered stale
      gcTime: 5 * 60 * 1000, // 5 minutes garbage collection
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

// Wrapper that renders CrossSessionSidebar outside the keyed ConversationView
// This prevents sidebar from remounting (and losing scroll position) on session changes
function ConversationViewWrapper(): JSX.Element {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();

  useSessionTabNavigation(conversationId);

  // Sidebar state lives here so it persists across session changes
  const { sidebarOpen, openSidebar, closeSidebar, toggleSidebar } = useSessionsSidebarState();

  // Legacy sessions (Claude UUIDs, codex-*, etc.) are migrated on-demand into unified
  // conversations with a stable conv-* ID. Redirect early so the rest of the UI
  // only has to reason about unified IDs.
  useEffect(() => {
    if (!conversationId) return;

    if (conversationId.startsWith('conv-')) return;
    if (conversationId.startsWith('pending-')) {
      void navigate('/', { replace: true });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const resolved = await api.resolveUnifiedConversationId(conversationId);
        if (cancelled) return;
        if (resolved.conversationId && resolved.conversationId.startsWith('conv-')) {
          void navigate(`/c/${resolved.conversationId}`, { replace: true });
          return;
        }
        void navigate('/', { replace: true });
      } catch (_error) {
        if (cancelled) return;
        void navigate('/', { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, navigate]);

  const resolvingLegacy = !!conversationId && !conversationId.startsWith('conv-');

  return (
    <div className="h-full flex overflow-hidden">
      <CrossSessionSidebar
        currentSessionId={conversationId}
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        onOpen={openSidebar}
      />
      {resolvingLegacy ? (
        <main
          className="flex-1 min-w-0 flex items-center justify-center text-fg-2"
          aria-label="Conversation view"
        >
          <div className="text-sm">Resolving legacy session...</div>
        </main>
      ) : (
        <ConversationView
          key={conversationId}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
        />
      )}
    </div>
  );
}

// Redirect from / to the first session, or show empty state with sidebar
function HomeRedirect(): JSX.Element {
  const navigate = useNavigate();
  const { conversations, loading } = useConversations();

  useSessionTabNavigation(undefined);

  const { sidebarOpen, openSidebar, closeSidebar, toggleSidebar } = useSessionsSidebarState();

  useEffect(() => {
    if (loading) return;

    const activeSessions = conversations
      .filter(c => (
        !c.archived
        && c.status !== 'pending'
        && c.conversationId.startsWith('conv-')
      ))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (activeSessions.length > 0) {
      void navigate(`/c/${activeSessions[0].conversationId}`, { replace: true });
    }
  }, [conversations, loading, navigate]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-fg-3 text-sm">Loading sessions...</div>
      </div>
    );
  }

  return (
    <div className="h-full flex overflow-hidden">
      <CrossSessionSidebar
        currentSessionId={undefined}
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        onOpen={openSidebar}
      />
      <NewSessionView
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
      />
    </div>
  );
}

function NewSessionWrapper(): JSX.Element {
  useSessionTabNavigation(undefined);

  const { sidebarOpen, openSidebar, closeSidebar, toggleSidebar } = useSessionsSidebarState();

  return (
    <div className="h-full flex overflow-hidden">
      <CrossSessionSidebar
        currentSessionId={undefined}
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        onOpen={openSidebar}
      />
      <NewSessionView
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
      />
    </div>
  );
}

function FeedbackInboxWrapper(): JSX.Element {
  useSessionTabNavigation(undefined);

  const { sidebarOpen, openSidebar, closeSidebar, toggleSidebar } = useSessionsSidebarState();

  return (
    <div className="h-full flex overflow-hidden">
      <CrossSessionSidebar
        currentSessionId={undefined}
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        onOpen={openSidebar}
      />
      <FeedbackInboxPage sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
    </div>
  );
}

function ChatApp(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <ActivityStreamProvider>
        <PreferencesProvider>
              <ConversationsProvider>
                  <TooltipProvider>
                  <ToastProvider>
                    <AttentionFaviconController />
                    <Routes>
                      {/* Home is the most recent session. */}
                      <Route path="/" element={
                        <Layout>
                          <HomeRedirect />
                        </Layout>
                      } />
                      <Route path="/sessions" element={
                        <Layout>
                          <HomeRedirect />
                        </Layout>
                      } />
                      <Route path="/new" element={
                        <Layout>
                          <NewSessionWrapper />
                        </Layout>
                      } />
                      <Route path="/feedback" element={
                        <Layout>
                          <FeedbackInboxWrapper />
                        </Layout>
                      } />
                      <Route path="/c/:conversationId" element={
                        <Layout>
                          <ConversationViewWrapper />
                        </Layout>
                      } />
                      {/* Old bookmarks for the deleted review and cross-session
                          analysis pages (their backend was removed months ago;
                          every call the page made 404'd). Land on home. */}
                      <Route path="/session/:sessionId/review" element={
                        <Navigate to="/" replace />
                      } />
                      <Route path="/analysis/cross-session" element={
                        <Navigate to="/" replace />
                      } />
                      <Route path="/lab/collapsed-group" element={
                        <CollapsedGroupLab />
                      } />
                      <Route path="/lab/queued-messages" element={
                        <QueuedMessagesLab />
                      } />
                      <Route path="/lab/annotated-message" element={
                        <AnnotatedMessageLab />
                      } />
                      {/* Learning map */}
                      <Route path="/map" element={
                        <MapIndexPage />
                      } />
                      <Route path="/map/:mapId" element={
                        <MapCanvasPage />
                      } />
                      <Route path="/map/:mapId/article/:articleId" element={
                        <MapCanvasPage />
                      } />
                      <Route path="/dev" element={
                        <DevHub />
                      } />
                      <Route path="/changelog" element={
                        <Layout>
                          <ChangelogPage />
                        </Layout>
                      } />
                      <Route path="*" element={
                        <div className="p-8 text-white">
                          <h1>404 - Route not found</h1>
                          <p>Path: {window.location.pathname}</p>
                        </div>
                      } />
                    </Routes>
                  </ToastProvider>
                  </TooltipProvider>
              </ConversationsProvider>
        </PreferencesProvider>
      </ActivityStreamProvider>
    </QueryClientProvider>
  );
}

export default ChatApp;
