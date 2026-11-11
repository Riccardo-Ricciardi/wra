import { useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { MessageSquare, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusDot, sessionStatus } from '@/components/status-dot';
import { NewConversationDialog } from '@/components/new-conversation-dialog';
import { useApp } from '@/lib/store';
import { dayBucket, projectName, relativeTime, titleOf } from '@/lib/utils';
import type { Session } from '@/lib/types';
import { onboardingDone } from '@/pages/welcome';

const order = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];

function Row({ session, onOpen }: { session: Session; onOpen: () => void }) {
  const status = sessionStatus(session);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-3 text-left transition-colors hover:border-border hover:bg-accent/40"
    >
      <StatusDot tone={status.tone} pulse={session.busy} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{titleOf(session)}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {projectName(session.projectPath)}
          {session.permissionMode === 'bypassPermissions' && ' · bypass'}
          {session.mcpReachable && ' · ChatGPT'}
        </span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {relativeTime(session.lastActivityAt ?? session.createdAt)}
      </span>
    </button>
  );
}

export function ConversationsPage() {
  const sessions = useApp((s) => s.sessions);
  const loading = useApp((s) => s.loading);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [newOpen, setNewOpen] = useState(false);

  const groups = useMemo(() => {
    const filtered = sessions
      .filter((s) => !s.archived)
      .filter((s) => {
        if (!query.trim()) return true;
        const q = query.toLowerCase();
        return (
          titleOf(s).toLowerCase().includes(q) ||
          s.projectPath.toLowerCase().includes(q) ||
          (s.label ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const at = Date.parse(a.lastActivityAt ?? a.createdAt) || 0;
        const bt = Date.parse(b.lastActivityAt ?? b.createdAt) || 0;
        return bt - at;
      });

    const map = new Map<string, Session[]>();
    for (const session of filtered) {
      const bucket = dayBucket(session.lastActivityAt ?? session.createdAt);
      if (!map.has(bucket)) map.set(bucket, []);
      map.get(bucket)!.push(session);
    }
    return order.filter((name) => map.has(name)).map((name) => ({ name, items: map.get(name)! }));
  }, [sessions, query]);

  if (!loading && sessions.length === 0 && !onboardingDone()) {
    return <Navigate to="/welcome" replace />;
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-6 md:px-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Conversations</h1>
          <p className="mt-1 text-sm text-muted-foreground">Pick up where you left off, or start something new.</p>
        </div>
        <Button className="gap-2" onClick={() => setNewOpen(true)}>
          <Plus className="size-4" />
          <span className="hidden sm:inline">New</span>
        </Button>
      </div>

      <div className="relative mt-5">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations"
          className="pl-9"
          aria-label="Search conversations"
        />
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {loading && (
          <div className="grid grid-cols-1 gap-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        )}

        {!loading && groups.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card">
              <MessageSquare className="size-5 text-muted-foreground" />
            </div>
            <p className="mt-4 text-sm font-medium">
              {query ? 'No conversations match' : 'No conversations yet'}
            </p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              {query
                ? 'Try a different search.'
                : 'Start one and it will appear here, on every device you use.'}
            </p>
            {!query && (
              <Button className="mt-4 gap-2" onClick={() => setNewOpen(true)}>
                <Plus className="size-4" />
                New conversation
              </Button>
            )}
          </div>
        )}

        {!loading &&
          groups.map((group) => (
            <section key={group.name} className="mb-5">
              <h2 className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                {group.name}
              </h2>
              <div className="grid grid-cols-1 gap-0.5">
                {group.items.map((session) => (
                  <Row
                    key={session.sessionId}
                    session={session}
                    onOpen={() => navigate(`/c/${session.sessionId}`)}
                  />
                ))}
              </div>
            </section>
          ))}
      </div>

      <NewConversationDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
