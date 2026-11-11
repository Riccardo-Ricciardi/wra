import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { sendMessage, useApp } from '@/lib/store';
import { cn } from '@/lib/utils';

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('');
  const sending = useApp((s) => s.sending);
  const busy = useApp((s) => s.sessions.find((x) => x.sessionId === sessionId)?.busy ?? false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setText('');
    await sendMessage(value);
  };

  return (
    <div className="border-t border-border bg-background/80 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur md:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
          <textarea
            ref={ref}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={1}
            placeholder={busy ? 'The agent is working…' : 'Message the agent…'}
            aria-label="Message"
            className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] outline-none placeholder:text-muted-foreground"
          />
          <Button
            size="icon"
            className={cn('size-9 shrink-0 rounded-xl', !text.trim() && 'opacity-40')}
            disabled={!text.trim() || sending}
            onClick={() => void submit()}
            aria-label="Send"
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </Button>
        </div>
        <p className="mt-1.5 hidden text-center text-[11px] text-muted-foreground md:block">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}
