import { cn } from '@/lib/utils';
import type { Session } from '@/lib/types';

export function sessionStatus(session: Session): {
  label: string;
  tone: 'success' | 'warning' | 'muted' | 'destructive';
} {
  if (session.busy) return { label: 'Thinking', tone: 'warning' };
  if (session.state === 'running') return { label: 'Ready', tone: 'success' };
  if (session.state === 'exited') return { label: 'Idle', tone: 'muted' };
  return { label: 'Idle', tone: 'muted' };
}

const tones = {
  success: 'bg-success',
  warning: 'bg-warning',
  muted: 'bg-muted-foreground/50',
  destructive: 'bg-destructive',
};

export function StatusDot({ tone, pulse }: { tone: keyof typeof tones; pulse?: boolean }) {
  return (
    <span className="relative flex size-2">
      {pulse && (
        <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', tones[tone])} />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', tones[tone])} />
    </span>
  );
}
