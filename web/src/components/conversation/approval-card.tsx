import { ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { decideApproval } from '@/lib/store';
import type { Approval } from '@/lib/types';

function summary(approval: Approval): string {
  const input = approval.input as Record<string, unknown>;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  return '';
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const detail = summary(approval);
  return (
    <div className="my-2 rounded-xl border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-start gap-2.5">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Needs approval</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The agent wants to use <span className="font-mono text-foreground">{approval.toolName}</span>
          </p>
          {detail && (
            <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[12px] scrollbar-thin">
              {detail}
            </pre>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => void decideApproval(approval.id, 'allow')}>
              Allow
            </Button>
            <Button size="sm" variant="outline" onClick={() => void decideApproval(approval.id, 'deny')}>
              Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
