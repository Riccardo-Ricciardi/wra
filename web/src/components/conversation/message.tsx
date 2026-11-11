import { useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { Markdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import type { ChatMessage, MessagePart } from '@/lib/types';
import { ToolCard } from './tool-card';

function Thinking({ text, durationMs }: { text: string; durationMs: number | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        <Brain className="size-3.5" />
        Thought{durationMs ? ` for ${Math.round(durationMs / 1000)}s` : ''}
      </button>
      {open && (
        <div className="mt-1.5 border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}

function Part({ part }: { part: MessagePart }) {
  if (part.kind === 'text') return <Markdown text={part.text} />;
  if (part.kind === 'thinking') return <Thinking text={part.text} durationMs={part.durationMs} />;
  return <ToolCard part={part} />;
}

export function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end py-2">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[15px] text-secondary-foreground">
          {message.parts.map((part, index) =>
            part.kind === 'text' ? <Markdown key={index} text={part.text} /> : null,
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="py-2">
      <div className="text-[15px] text-foreground">
        {message.parts.map((part, index) => (
          <Part key={index} part={part} />
        ))}
      </div>
    </div>
  );
}
