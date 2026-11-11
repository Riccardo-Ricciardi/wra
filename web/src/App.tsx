import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { X } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { ErrorBoundary } from '@/components/error-boundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConversationsPage } from '@/pages/conversations';
import { ConversationPage } from '@/pages/conversation';
import { ProjectsPage } from '@/pages/projects';
import { SettingsPage } from '@/pages/settings';
import { LoginPage } from '@/pages/login';
import { WelcomePage } from '@/pages/welcome';
import { clearError, start, useApp } from '@/lib/store';

function ErrorToast() {
  const error = useApp((s) => s.error);
  if (!error) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-start gap-2 rounded-xl border border-destructive/40 bg-popover p-3 text-sm shadow-lg animate-in">
      <span className="min-w-0 flex-1 text-destructive">{error}</span>
      <button
        type="button"
        onClick={clearError}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

export function App() {
  const token = useApp((s) => s.token);

  useEffect(() => {
    if (token) start();
  }, [token]);

  if (!token) {
    return (
      <TooltipProvider delayDuration={300}>
        <LoginPage />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <ErrorBoundary>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<ConversationsPage />} />
          <Route path="c/:id" element={<ConversationPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="welcome" element={<WelcomePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      </ErrorBoundary>
      <ErrorToast />
    </TooltipProvider>
  );
}
