import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  FolderGit2,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Plus,
  Settings,
  Sun,
  WifiOff,
} from 'lucide-react';
import { BrandMark } from '@/components/brand';
import { NewConversationDialog } from '@/components/new-conversation-dialog';
import { StatusDot, sessionStatus } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { signOut, useApp } from '@/lib/store';
import { useTheme } from '@/lib/theme';
import { cn, relativeTime, titleOf } from '@/lib/utils';
import type { Session } from '@/lib/types';

const navItems = [
  { to: '/', label: 'Conversations', icon: MessageSquare, end: true },
  { to: '/projects', label: 'Projects', icon: FolderGit2, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
];

function ConversationRow({ session, onNavigate }: { session: Session; onNavigate?: () => void }) {
  const status = sessionStatus(session);
  return (
    <NavLink
      to={`/c/${session.sessionId}`}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
          isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )
      }
    >
      <StatusDot tone={status.tone} pulse={session.busy} />
      <span className="min-w-0 flex-1 truncate">{titleOf(session)}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
        {relativeTime(session.lastActivityAt ?? session.createdAt)}
      </span>
    </NavLink>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const connected = useApp((s) => s.connected);
  const { theme, setTheme } = useTheme();
  const [newOpen, setNewOpen] = useState(false);
  const navigate = useNavigate();

  const recent = [...sessions]
    .filter((s) => !s.archived)
    .sort((a, b) => {
      const at = Date.parse(a.lastActivityAt ?? a.createdAt) || 0;
      const bt = Date.parse(b.lastActivityAt ?? b.createdAt) || 0;
      return bt - at;
    })
    .slice(0, 30);

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <BrandMark className="size-5" />
        <span className="text-sm font-semibold tracking-tight">WRA</span>
      </div>

      <div className="px-3">
        <Button className="w-full justify-start gap-2" onClick={() => setNewOpen(true)}>
          <Plus className="size-4" />
          New conversation
        </Button>
      </div>

      <nav className="mt-4 grid gap-0.5 px-3" aria-label="Main">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )
            }
          >
            <item.icon className="size-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-5 flex items-center justify-between px-4 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Recent
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 scrollbar-thin">
        <div className="grid grid-cols-1 gap-0.5 pb-3">
          {recent.length === 0 && (
            <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">No conversations yet.</p>
          )}
          {recent.map((session) => (
            <ConversationRow key={session.sessionId} session={session} onNavigate={onNavigate} />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 border-t border-border px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <StatusDot tone={connected ? 'success' : 'destructive'} />
          {connected ? 'Connected' : 'Offline'}
        </span>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
            >
              {theme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Theme: {theme}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Sign out"
              onClick={() => {
                signOut();
                navigate('/');
              }}
            >
              <LogOut className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sign out</TooltipContent>
        </Tooltip>
      </div>

      <NewConversationDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const connectionLost = useApp((s) => s.connectionLost);
  const connected = useApp((s) => s.connected);

  return (
    <div className="flex h-full">
      <aside className="hidden w-[280px] shrink-0 overflow-hidden border-r border-border bg-card/40 md:block">
        <SidebarContent />
      </aside>

      <Dialog open={drawer} onOpenChange={setDrawer}>
        <DialogContent className="left-0 top-0 h-full max-h-none! w-[300px] max-w-[85vw] translate-x-0 translate-y-0 overflow-hidden rounded-none border-y-0 border-l-0 p-0">
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <SidebarContent onNavigate={() => setDrawer(false)} />
        </DialogContent>
      </Dialog>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <Button variant="ghost" size="icon-sm" aria-label="Open navigation" onClick={() => setDrawer(true)}>
            <Menu className="size-5" />
          </Button>
          <BrandMark className="size-4" />
          <span className="text-sm font-semibold">WRA</span>
          <span className="flex-1" />
          {!connected && <WifiOff className="size-4 text-destructive" aria-label="Offline" />}
        </header>

        {connectionLost && connected === false && (
          <div className="flex items-center gap-2 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning">
            <WifiOff className="size-3.5" />
            Connection lost. Reconnecting…
          </div>
        )}

        <main key={location.pathname} className="min-h-0 flex-1 animate-in">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
