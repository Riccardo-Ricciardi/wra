import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Loader2, MessageCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get } from '@/lib/api';
import { sessionAction } from '@/lib/store';
import { shortId } from '@/lib/utils';
import type { Session, StatusPayload } from '@/lib/types';

interface Props {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChatGptDialog({ session, open, onOpenChange }: Props) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [allowed, setAllowed] = useState(session.mcpAllowed);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAllowed(session.mcpAllowed);
    setConfirm('');
    setError(null);
    get<StatusPayload>('/healthz')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [open, session.mcpAllowed]);

  const bypass = session.permissionMode === 'bypassPermissions';
  const needsConfirm = bypass && allowed;
  const confirmToken = session.name || shortId(session.sessionId);
  const endpoint = status?.oauth?.resource ?? `${location.origin}/mcp`;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await sessionAction(session.sessionId, 'mcp', {
        allowed,
        confirm: needsConfirm ? confirm : undefined,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change access');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy. Select the address and copy it manually.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4" />
            Connect to ChatGPT
          </DialogTitle>
          <DialogDescription>
            Let ChatGPT read and continue this conversation through the MCP bridge.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4">
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-xs font-medium text-muted-foreground">MCP endpoint</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{endpoint}</code>
              <Button variant="ghost" size="icon-sm" onClick={() => void copy()} aria-label="Copy endpoint">
                {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              In ChatGPT, add this as a custom connector. You will sign in with your WRA token and approve
              access once.
            </p>
          </div>

          {status && !status.mcp && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                The MCP bridge is off on this server. Set <code className="font-mono">CR_ISSUER_URL</code> and{' '}
                <code className="font-mono">CR_RESOURCE_URL</code>, then restart.
              </span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Allow ChatGPT to use this conversation</p>
              <p className="text-xs text-muted-foreground">
                {allowed ? 'ChatGPT can read and continue it.' : 'Only you can use it.'}
              </p>
            </div>
            <Switch checked={allowed} onCheckedChange={setAllowed} disabled={!status?.mcp} />
          </div>

          {bypass && allowed && (
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <div className="flex items-start gap-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  This conversation bypasses permissions. Exposing it lets ChatGPT run tools without asking. Type{' '}
                  <span className="font-mono font-semibold">{confirmToken}</span> to confirm.
                </span>
              </div>
              <Input
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder={confirmToken}
                aria-label="Confirmation"
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy || (needsConfirm && confirm.trim() !== confirmToken)}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChatGptLink({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" className="gap-1.5" aria-label="Connect to ChatGPT" onClick={() => setOpen(true)}>
        <MessageCircle className="size-3.5" />
        <span className="hidden sm:inline">ChatGPT</span>
        {session.mcpReachable && <span className="size-1.5 rounded-full bg-success" />}
      </Button>
      <ChatGptDialog session={session} open={open} onOpenChange={setOpen} />
    </>
  );
}
