import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Archive,
  ArrowLeft,
  MoreHorizontal,
  Pencil,
  Star,
  TerminalSquare,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { StatusDot } from '@/components/status-dot';
import { Message } from '@/components/conversation/message';
import { Composer } from '@/components/conversation/composer';
import { ApprovalCard } from '@/components/conversation/approval-card';
import { PermissionsPopover } from '@/components/conversation/permissions-popover';
import { ChatGptLink } from '@/components/conversation/chatgpt-dialog';
const TerminalView = lazy(() =>
  import('@/components/conversation/terminal-view').then((m) => ({ default: m.TerminalView })),
);
import { closeSession, openSession, refresh, sessionAction, useApp } from '@/lib/store';
import { projectName, titleOf } from '@/lib/utils';
import type { ChatMessage } from '@/lib/types';

const EMPTY_MESSAGES: ChatMessage[] = [];

export function ConversationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const session = useApp((s) => s.sessions.find((x) => x.sessionId === id));
  const messages = useApp((s) => s.messages[id]) ?? EMPTY_MESSAGES;
  const allApprovals = useApp((s) => s.approvals);
  const approvals = useMemo(
    () => allApprovals.filter((a) => a.sessionId === id),
    [allApprovals, id],
  );
  const connected = useApp((s) => s.connected);
  const connectionLost = useApp((s) => s.connectionLost);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!id) return;
    openSession(id);
    return () => closeSession();
  }, [id]);

  useEffect(() => {
    if (stick.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, approvals]);

  const status = useMemo(() => {
    if (!session) return null;
    if (!connected) return { label: 'Connection lost', tone: 'destructive' as const, pulse: false };
    if (approvals.length > 0) return { label: 'Needs approval', tone: 'warning' as const, pulse: false };
    if (session.busy) return { label: 'Thinking', tone: 'warning' as const, pulse: true };
    return null;
  }, [session, connected, approvals.length]);

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm font-medium">Conversation not found</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          It may have been removed, or the server has not loaded it yet.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            Back to conversations
          </Button>
        </div>
      </div>
    );
  }

  const rename = async () => {
    await sessionAction(session.sessionId, 'rename', { name });
    setRenameOpen(false);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 md:px-5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          aria-label="Back"
          onClick={() => navigate('/')}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{titleOf(session)}</h1>
          <p className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
            <span className="truncate">{projectName(session.projectPath)}</span>
            {status && (
              <>
                <span aria-hidden="true">·</span>
                <StatusDot tone={status.tone} pulse={status.pulse} />
                <span>{status.label}</span>
              </>
            )}
            {session.permissionMode === 'bypassPermissions' && (
              <Badge variant="destructive" className="ml-1">
                Bypass
              </Badge>
            )}
          </p>
        </div>

        <PermissionsPopover session={session} />
        <ChatGptLink session={session} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Conversation options">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                setName(session.name ?? '');
                setRenameOpen(true);
              }}
            >
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void sessionAction(session.sessionId, 'favorite', { favorite: !session.favorite })}
            >
              <Star /> {session.favorite ? 'Unpin' : 'Pin'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTerminalOpen(true)}>
              <TerminalSquare /> Advanced terminal
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                void sessionAction(session.sessionId, 'archive', { archived: true });
                navigate('/');
              }}
            >
              <Archive /> Archive
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => {
                if (!window.confirm('Remove this conversation from the list? The transcript stays on disk.')) return;
                void sessionAction(session.sessionId, 'forget');
                navigate('/');
              }}
            >
              <Trash2 /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {connectionLost && !connected && (
        <div className="flex items-center gap-2 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning">
          <WifiOff className="size-3.5" />
          Connection lost. Reconnecting…
          <Button variant="ghost" size="sm" className="ml-auto h-6 text-xs" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="min-h-0 flex-1 overflow-y-auto scrollbar-thin"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-4 md:px-6">
          {messages.length === 0 && !session.busy && (
            <div className="py-20 text-center">
              <p className="text-sm font-medium">Start the conversation</p>
              <p className="mt-1 text-xs text-muted-foreground">
                The agent resumes automatically when you send a message.
              </p>
            </div>
          )}
          {messages.length === 0 && session.busy && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <span className="size-2 animate-pulse rounded-full bg-warning" />
              Thinking…
            </div>
          )}
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <Composer sessionId={session.sessionId} />

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
            className="grid gap-3"
          >
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="Name" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={terminalOpen} onOpenChange={setTerminalOpen}>
        <DialogContent className="max-w-4xl p-0">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>Advanced terminal</DialogTitle>
          </DialogHeader>
          <div className="h-[60vh] overflow-hidden rounded-b-xl bg-black p-2">
            {terminalOpen && (
              <Suspense fallback={<div className="size-full" />}>
                <TerminalView sessionId={session.sessionId} />
              </Suspense>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
