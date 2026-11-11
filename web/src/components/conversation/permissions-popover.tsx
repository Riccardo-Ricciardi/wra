import { useState } from 'react';
import { Check, Shield, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { sessionAction, useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { PermissionMode, Session } from '@/lib/types';

const modes: { value: PermissionMode; label: string; description: string; icon: typeof Shield }[] = [
  { value: 'default', label: 'Ask', description: 'Approve each tool before it runs.', icon: Shield },
  { value: 'acceptEdits', label: 'Accept edits', description: 'File edits run without asking.', icon: ShieldCheck },
  { value: 'plan', label: 'Plan', description: 'Read-only. The agent proposes, never changes.', icon: Sparkles },
  {
    value: 'bypassPermissions',
    label: 'Bypass',
    description: 'Every tool runs without asking. High risk.',
    icon: ShieldAlert,
  },
];

export function PermissionsPopover({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const autoApprove = useApp((s) => s.projects.find((p) => p.key === session.projectKey)?.autoApprove ?? false);
  const effectiveAuto = session.autoApprove ?? autoApprove;

  const setMode = async (mode: PermissionMode) => {
    if (mode === session.permissionMode) return;
    setBusy(true);
    try {
      await sessionAction(session.sessionId, 'permissions', { mode });
    } finally {
      setBusy(false);
    }
  };

  const setAuto = async (enabled: boolean) => {
    setBusy(true);
    try {
      await sessionAction(session.sessionId, 'auto', { enabled });
    } finally {
      setBusy(false);
    }
  };

  const current = modes.find((m) => m.value === session.permissionMode) ?? modes[0];
  const Icon = current.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" aria-label={`Permissions: ${current.label}`}>
          <Icon className={cn('size-3.5', session.permissionMode === 'bypassPermissions' && 'text-destructive')} />
          <span className="hidden sm:inline">{current.label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="grid grid-cols-1 gap-3">
          <div>
            <p className="text-sm font-medium">Permissions</p>
            <p className="text-xs text-muted-foreground">What the agent may do without asking.</p>
          </div>

          <div className="grid grid-cols-1 gap-1">
            {modes.map((mode) => (
              <button
                key={mode.value}
                type="button"
                disabled={busy}
                onClick={() => void setMode(mode.value)}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                  session.permissionMode === mode.value ? 'bg-accent' : 'hover:bg-accent/60',
                )}
              >
                <mode.icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    mode.value === 'bypassPermissions' ? 'text-destructive' : 'text-muted-foreground',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{mode.label}</span>
                  <span className="block text-xs text-muted-foreground">{mode.description}</span>
                </span>
                {session.permissionMode === mode.value && <Check className="mt-0.5 size-4 shrink-0" />}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Auto-approve</p>
              <p className="text-xs text-muted-foreground">Let safe tools run on their own.</p>
            </div>
            <Switch checked={effectiveAuto} disabled={busy} onCheckedChange={(value) => void setAuto(value)} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
