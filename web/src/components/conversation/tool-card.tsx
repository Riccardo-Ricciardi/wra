import { useState } from 'react';
import {
  Bot,
  ChevronRight,
  FilePen,
  FileText,
  FolderSearch,
  Globe,
  Loader2,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MessagePart, ToolResult } from '@/lib/types';

type ToolPart = Extract<MessagePart, { kind: 'tool' }>;

const icons: Record<string, typeof Wrench> = {
  Bash: Terminal,
  Read: FileText,
  Write: FilePen,
  Edit: FilePen,
  MultiEdit: FilePen,
  Grep: Search,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Bot,
};

function summaryOf(part: ToolPart): string {
  const input = part.input as Record<string, unknown> | null;
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.description === 'string') return input.description;
  return '';
}

function Diff({ result }: { result: ToolResult }) {
  if (!result.patch?.length) return null;
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-muted/40 font-mono text-[12px] leading-relaxed">
      {result.patch.map((hunk, h) => (
        <div key={h}>
          <div className="border-b border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
            @@ -{hunk.oldStart ?? '?'} +{hunk.newStart ?? '?'} @@
          </div>
          {hunk.lines.map((line, n) => (
            <div
              key={n}
              className={cn(
                'whitespace-pre px-2',
                line.startsWith('+') && 'bg-success/10 text-success',
                line.startsWith('-') && 'bg-destructive/10 text-destructive',
                !line.startsWith('+') && !line.startsWith('-') && 'text-muted-foreground',
              )}
            >
              {line || ' '}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const Icon = icons[part.name] ?? Wrench;
  const summary = summaryOf(part);
  const running = part.result === null;
  const failed = part.result?.isError === true;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-card/50">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
        aria-expanded={open}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{part.name}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{summary}</span>
        )}
        <span className="flex-1" />
        {running && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        {failed && <span className="shrink-0 text-[11px] font-medium text-destructive">Failed</span>}
        {part.result && !failed && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {part.result.added !== undefined && part.result.added > 0 && (
              <span className="text-success">+{part.result.added} </span>
            )}
            {part.result.removed !== undefined && part.result.removed > 0 && (
              <span className="text-destructive">-{part.result.removed}</span>
            )}
          </span>
        )}
      </button>

      {open && (
        <div className="grid gap-2 border-t border-border px-3 py-2.5">
          {part.inputTruncated ? (
            <p className="text-xs text-muted-foreground">Input is too large to show in full.</p>
          ) : (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[12px] leading-relaxed scrollbar-thin">
              {JSON.stringify(part.input, null, 2)}
            </pre>
          )}
          {part.result && (
            <>
              {part.result.patch?.length ? (
                <Diff result={part.result} />
              ) : part.result.text ? (
                <pre
                  className={cn(
                    'max-h-64 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[12px] leading-relaxed scrollbar-thin',
                    part.result.isError && 'text-destructive',
                  )}
                >
                  {part.result.text}
                </pre>
              ) : null}
              {part.result.truncated && (
                <p className="text-[11px] text-muted-foreground">Output truncated.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
