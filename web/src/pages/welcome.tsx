import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, FolderOpen, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { get } from '@/lib/api';
import { createConversation, projectAction, useApp } from '@/lib/store';
import { cn } from '@/lib/utils';

const DONE_KEY = 'wra-onboarding-done';

export function onboardingDone() {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return false;
  }
}

function markDone() {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    // private window: the flow simply shows again next time
  }
}

interface SetupStep {
  id: string;
  what: string;
  ok: boolean;
  detail: string;
}

const STEPS = ['Welcome', 'Agent', 'Workspace', 'Remote', 'First chat'] as const;

export function WelcomePage() {
  const navigate = useNavigate();
  const sessions = useApp((s) => s.sessions);
  const [step, setStep] = useState(0);
  const [agent, setAgent] = useState<SetupStep | null>(null);
  const [checking, setChecking] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessions.length > 0 && !path) setPath(sessions[0].projectPath);
  }, [sessions, path]);

  const checkAgent = async () => {
    setChecking(true);
    setError(null);
    try {
      const status = await get<{ setup?: { steps: SetupStep[] } }>('/local/admin/status');
      setAgent(status.setup?.steps.find((entry) => entry.id === 'claude') ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the setup status');
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (step === 1 && !agent && !checking) void checkAgent();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = async () => {
    if (!path.trim()) {
      setError('Choose a folder that already exists on this machine');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await projectAction('add', { path: path.trim() });
      const session = await createConversation(path.trim());
      markDone();
      navigate(`/c/${session.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the conversation');
    } finally {
      setBusy(false);
    }
  };

  const skip = () => {
    markDone();
    navigate('/');
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col justify-center px-4 py-10 md:px-8">
      <ol className="mb-8 flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        {STEPS.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full border text-[10px]',
                index < step && 'border-primary bg-primary text-primary-foreground',
                index === step && 'border-primary text-primary',
                index > step && 'border-border',
              )}
            >
              {index < step ? <Check className="size-3" /> : index + 1}
            </span>
            <span className={cn(index === step ? 'text-foreground' : 'hidden sm:inline')}>{label}</span>
            {index < STEPS.length - 1 && <span className="text-border">—</span>}
          </li>
        ))}
      </ol>

      <div className="rounded-2xl border border-border bg-card p-6 md:p-8">
        {step === 0 && (
          <section>
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="size-5" />
            </div>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">Welcome to WRA</h1>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Your projects, conversations and the agent that works on them — from this machine, the
              browser, or the phone. Five short steps, everything optional except the first
              conversation.
            </p>
            <div className="mt-6 flex gap-2">
              <Button onClick={() => setStep(1)} className="gap-2">
                Get started <ArrowRight className="size-4" />
              </Button>
              <Button variant="ghost" onClick={skip}>
                Skip for now
              </Button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section>
            <h1 className="text-xl font-semibold tracking-tight">Agent detection</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              WRA runs the Claude Code CLI you already have. It does not install or update it.
            </p>
            <div
              className={cn(
                'mt-5 flex items-start gap-3 rounded-xl border p-4 text-sm',
                agent?.ok ? 'border-border bg-background' : 'border-warning/40 bg-warning/10',
              )}
            >
              <span className="mt-0.5">
                {checking ? <Loader2 className="size-4 animate-spin" /> : agent?.ok ? <Check className="size-4" /> : '!'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{agent?.what ?? 'Checking the agent command…'}</span>
                <span className="mt-0.5 block break-all text-xs text-muted-foreground">
                  {agent?.detail ?? 'One moment.'}
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => void checkAgent()} disabled={checking}>
                Check again
              </Button>
            </div>
            {!agent?.ok && !checking && (
              <p className="mt-3 text-xs text-muted-foreground">
                Install Claude Code, then press Check again. Nothing else needs administrator rights.
              </p>
            )}
            <div className="mt-6 flex gap-2">
              <Button onClick={() => setStep(2)} className="gap-2">
                Continue <ArrowRight className="size-4" />
              </Button>
              <Button variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            <h1 className="text-xl font-semibold tracking-tight">Select a workspace</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The folder where the agent works. It must already exist; WRA never creates or moves
              files here.
            </p>
            <div className="mt-5 grid gap-2">
              <Label htmlFor="workspace">Project folder</Label>
              <div className="flex gap-2">
                <Input
                  id="workspace"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="C:\\Users\\you\\Projects\\my-project"
                  autoFocus
                />
                <Button variant="secondary" onClick={() => void projectAction('add', { path: path.trim() }).catch(() => undefined)} disabled={!path.trim()}>
                  <FolderOpen className="size-4" />
                  Add
                </Button>
              </div>
              {sessions.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {[...new Set(sessions.map((session) => session.projectPath))].slice(0, 6).map((entry) => (
                    <button
                      key={entry}
                      type="button"
                      onClick={() => setPath(entry)}
                      className="max-w-full truncate rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {entry}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-6 flex gap-2">
              <Button onClick={() => setStep(3)} className="gap-2" disabled={!path.trim()}>
                Continue <ArrowRight className="size-4" />
              </Button>
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section>
            <h1 className="text-xl font-semibold tracking-tight">Remote connections</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Optional. Tailscale, Cloudflare and ChatGPT live in Settings, and none of them is
              needed to work locally. No domain, no OAuth, no MCP.
            </p>
            <div className="mt-5 rounded-xl border border-border bg-background p-4 text-sm">
              <p className="font-medium">Working locally is the default.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                You can add outside access later without touching the conversations you make now.
              </p>
            </div>
            <div className="mt-6 flex gap-2">
              <Button onClick={() => setStep(4)} className="gap-2">
                Continue <ArrowRight className="size-4" />
              </Button>
              <Button variant="ghost" onClick={() => navigate('/settings')}>
                Open Settings
              </Button>
              <Button variant="ghost" onClick={() => setStep(2)}>
                Back
              </Button>
            </div>
          </section>
        )}

        {step === 4 && (
          <section>
            <h1 className="text-xl font-semibold tracking-tight">Start your first conversation</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              A conversation is one agent session in <code className="text-foreground">{path || 'your project'}</code>.
              The agent starts when you send the first message.
            </p>
            <div className="mt-6 flex gap-2">
              <Button onClick={() => void finish()} className="gap-2" disabled={busy || !path.trim()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                Start the first conversation
              </Button>
              <Button variant="ghost" onClick={skip}>
                Finish without starting
              </Button>
            </div>
          </section>
        )}

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
