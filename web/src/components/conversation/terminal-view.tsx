import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useApp } from '@/lib/store';

export function TerminalView({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const token = useApp((s) => s.token);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !token) return;

    const term = new Terminal({
      fontFamily: '"Geist Mono", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#000000', foreground: '#e5e5e5' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws`, [`bearer.${token}`]);

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          t: 'hello',
          role: 'terminal',
          sessionId,
          cols: term.cols,
          rows: term.rows,
        }),
      );
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.t === 'output') term.write(message.data);
        if (message.t === 'error') term.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
      } catch {
        // ignore malformed frames
      }
    });

    const dataListener = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'input', data }));
    });

    const resize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      observer.disconnect();
      dataListener.dispose();
      socket.close();
      term.dispose();
    };
  }, [sessionId, token]);

  return <div ref={hostRef} className="size-full" />;
}
