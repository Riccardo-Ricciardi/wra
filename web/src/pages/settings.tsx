import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Database,
  Download,
  Loader2,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Wifi,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { get, post } from '@/lib/api';
import { projectAction, signOut, useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { StatusPayload } from '@/lib/types';

interface BackupEntry {
  name: string;
  at?: string;
  size?: number;
}

interface BackupsPayload {
  folder: string;
  backups: BackupEntry[];
}

interface AdminStatus {
  version: string;
  checks: { name: string; ok: boolean; detail?: string }[];
  paths: Record<string, string>;
  effective: Record<string, unknown>;
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid grid-cols-1 gap-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Connections() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = useApp((s) => s.connected);

  useEffect(() => {
    get<StatusPayload>('/healthz')
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not read server status'));
  }, []);

  return (
    <div className="grid grid-cols-1 gap-6">
      <Section title="Server" description="Where this dashboard is running.">
        <div className="grid grid-cols-1 gap-2 rounded-xl border border-border p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Connection</span>
            <Badge variant={connected ? 'success' : 'destructive'}>
              {connected ? 'Connected' : 'Offline'}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Address</span>
            <code className="font-mono text-xs">{location.host}</code>
          </div>
          {status && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Conversations</span>
              <span className="tabular-nums">{status.sessions.length}</span>
            </div>
          )}
        </div>
      </Section>

      <Section title="ChatGPT bridge" description="The MCP endpoint ChatGPT connects to.">
        <div className="grid grid-cols-1 gap-2 rounded-xl border border-border p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Bridge</span>
            <Badge variant={status?.mcp ? 'success' : 'outline'}>{status?.mcp ? 'On' : 'Off'}</Badge>
          </div>
          {status?.oauth && (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Endpoint</span>
                <code className="min-w-0 truncate font-mono text-xs">{status.oauth.resource}</code>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Host</span>
                <code className="font-mono text-xs">{status.oauth.host ?? '—'}</code>
              </div>
            </>
          )}
          {!status?.mcp && (
            <p className="text-xs text-muted-foreground">
              Set <code className="font-mono">CR_ISSUER_URL</code> and <code className="font-mono">CR_RESOURCE_URL</code>{' '}
              to turn it on.
            </p>
          )}
        </div>
      </Section>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Section title="This browser">
        <Button variant="outline" className="w-fit" onClick={signOut}>
          Sign out
        </Button>
      </Section>
    </div>
  );
}

function Permissions() {
  const projects = useApp((s) => s.projects);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (path: string, enabled: boolean) => {
    setBusy(path);
    try {
      await projectAction('update', { path, autoApprove: enabled });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6">
      <Section
        title="How permissions work"
        description="Each conversation has its own mode. These are the defaults for new conversations in a project."
      >
        <div className="grid grid-cols-1 gap-2 text-sm">
          {[
            ['Ask', 'Approve each tool before it runs.'],
            ['Accept edits', 'File edits run without asking.'],
            ['Plan', 'Read-only. The agent proposes, never changes.'],
            ['Bypass', 'Every tool runs without asking. High risk.'],
          ].map(([label, description]) => (
            <div key={label} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
              <Shield className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Auto-approve by project" description="Safe tools run on their own in these projects.">
        <div className="grid grid-cols-1 gap-1">
          {projects.filter((p) => !p.hidden).map((project) => (
            <div key={project.key} className="flex items-center justify-between gap-3 rounded-lg px-1 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{project.name}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">{project.path}</p>
              </div>
              <Switch
                checked={project.autoApprove}
                disabled={busy === project.path}
                onCheckedChange={(value) => void toggle(project.path, value)}
              />
            </div>
          ))}
          {projects.length === 0 && <p className="text-xs text-muted-foreground">No projects yet.</p>}
        </div>
      </Section>
    </div>
  );
}

function Backups() {
  const [data, setData] = useState<BackupsPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () =>
    get<BackupsPayload>('/local/admin/backups')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load backups'));

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await post<BackupsPayload>('/local/admin/backups');
      setData(result);
      setNotice('Backup created.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a backup');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ ok: boolean; bad: string[] }>('/local/admin/backups/verify', { name });
      setNotice(result.ok ? 'Backup is intact.' : `Backup has problems: ${result.bad.join(', ')}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify the backup');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (name: string) => {
    if (!window.confirm(`Restore ${name}? Current state is replaced.`)) return;
    setBusy(true);
    setError(null);
    try {
      await post('/local/admin/backups/restore', { name, confirm: name });
      setNotice('Restored. Restart the server to apply.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore the backup');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      <Section title="Backups" description="Copies of the registry, settings and access state.">
        <div className="flex items-center gap-2">
          <Button onClick={() => void create()} disabled={busy} className="gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Database className="size-4" />}
            Create backup
          </Button>
          <Button variant="outline" onClick={() => void load()} disabled={busy} className="gap-2">
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </div>
        {data && <p className="font-mono text-[11px] text-muted-foreground">{data.folder}</p>}
      </Section>

      {notice && (
        <p className="flex items-center gap-2 text-sm text-success">
          <Check className="size-4" /> {notice}
        </p>
      )}
      {error && (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <X className="size-4" /> {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-1">
        {data?.backups.length === 0 && <p className="text-xs text-muted-foreground">No backups yet.</p>}
        {data?.backups.map((backup) => (
          <div key={backup.name} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{backup.name}</span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void verify(backup.name)}>
              Verify
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore(backup.name)}>
              Restore
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

async function downloadExport() {
  const response = await fetch('/local/admin/export', {
    headers: { 'x-cc-remote-token': localStorage.getItem('cc-remote-token') ?? '' },
  });
  if (!response.ok) return;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'wra-diagnostics.json';
  link.click();
  URL.revokeObjectURL(url);
}

function Advanced() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    get<AdminStatus>('/local/admin/status?setup=0')
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not read diagnostics'));

  useEffect(() => {
    void load();
  }, []);

  const restart = async () => {
    if (!window.confirm('Restart the server? Conversations stay in the registry.')) return;
    setBusy(true);
    try {
      await post('/local/admin/restart', { confirm: 'riavvia' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restart');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6">
      <Section title="Diagnostics" description="What the server checks about itself.">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} className="gap-2">
            <RefreshCw className="size-3.5" /> Recheck
          </Button>
          <Button variant="outline" size="sm" onClick={() => void restart()} disabled={busy} className="gap-2">
            <AlertTriangle className="size-3.5" /> Restart server
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="grid grid-cols-1 gap-1">
          {status?.checks.map((check) => (
            <div key={check.name} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <span
                className={cn(
                  'mt-1 size-2 shrink-0 rounded-full',
                  check.ok ? 'bg-success' : 'bg-destructive',
                )}
              />
              <div className="min-w-0">
                <p className="font-medium">{check.name}</p>
                {check.detail && <p className="truncate text-xs text-muted-foreground">{check.detail}</p>}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {status && (
        <Section title="Paths">
          <div className="grid grid-cols-1 gap-1 rounded-xl border border-border p-3">
            {Object.entries(status.paths).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between gap-3 text-xs">
                <span className="shrink-0 text-muted-foreground">{key}</span>
                <code className="min-w-0 truncate font-mono">{value}</code>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Export">
        <Button variant="outline" className="w-fit gap-2" onClick={() => void downloadExport()}>
          <Download className="size-4" /> Download diagnostics
        </Button>
      </Section>
    </div>
  );
}

export function SettingsPage() {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-6 md:px-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Connections, permissions, backups and diagnostics.</p>
      </div>

      <Tabs defaultValue="connections" className="mt-5 flex min-h-0 flex-1 flex-col">
        <TabsList className="h-auto min-h-9 w-full flex-wrap justify-start">
          <TabsTrigger value="connections" className="gap-1.5">
            <Wifi className="size-3.5" /> Connections
          </TabsTrigger>
          <TabsTrigger value="permissions" className="gap-1.5">
            <Shield className="size-3.5" /> Permissions
          </TabsTrigger>
          <TabsTrigger value="backups" className="gap-1.5">
            <Database className="size-3.5" /> Backups
          </TabsTrigger>
          <TabsTrigger value="advanced" className="gap-1.5">
            <SlidersHorizontal className="size-3.5" /> Advanced
          </TabsTrigger>
        </TabsList>
        <Separator className="mt-3" />
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin pt-4">
          <TabsContent value="connections" className="mt-0">
            <Connections />
          </TabsContent>
          <TabsContent value="permissions" className="mt-0">
            <Permissions />
          </TabsContent>
          <TabsContent value="backups" className="mt-0">
            <Backups />
          </TabsContent>
          <TabsContent value="advanced" className="mt-0">
            <Advanced />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
