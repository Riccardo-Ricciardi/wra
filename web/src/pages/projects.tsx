import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Eye,
  EyeOff,
  FolderGit2,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { createConversation, projectAction, useApp } from '@/lib/store';
import { relativeTime } from '@/lib/utils';
import type { Project } from '@/lib/types';

function ProjectRow({ project }: { project: Project }) {
  const navigate = useNavigate();
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const session = await createConversation(project.path);
      navigate(`/c/${session.sessionId}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card/40 px-3 py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <FolderGit2 className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{project.name}</span>
          {project.favorite && <Star className="size-3 fill-current text-warning" />}
          {project.hidden && <Badge variant="outline">Hidden</Badge>}
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{project.path}</p>
      </div>
      <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground sm:block">
        <p>{project.open} open</p>
        <p>{relativeTime(project.lastActivityAt)}</p>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void start()}>
        New
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Options for ${project.name}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setName(project.name);
              setRenameOpen(true);
            }}
          >
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void projectAction('update', { path: project.path, favorite: !project.favorite })}
          >
            <Star /> {project.favorite ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void projectAction('update', { path: project.path, hidden: !project.hidden })}
          >
            {project.hidden ? <Eye /> : <EyeOff />} {project.hidden ? 'Show' : 'Hide'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void projectAction('open', { path: project.path })}>
            <FolderOpen /> Open folder
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => {
              if (!window.confirm(`Forget ${project.name}? The folder and its conversations stay on disk.`)) return;
              void projectAction('remove', { path: project.path });
            }}
          >
            <Trash2 /> Forget
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void projectAction('update', { path: project.path, name });
              setRenameOpen(false);
            }}
            className="grid gap-3"
          >
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ProjectsPage() {
  const projects = useApp((s) => s.projects);
  const [addOpen, setAddOpen] = useState(false);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const visible = projects
    .filter((p) => showHidden || !p.hidden)
    .sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      const at = Date.parse(a.lastActivityAt ?? '') || 0;
      const bt = Date.parse(b.lastActivityAt ?? '') || 0;
      return bt - at;
    });

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await projectAction('add', { path: path.trim(), name: name.trim() });
      setAddOpen(false);
      setPath('');
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the project');
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-6 md:px-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">Folders your conversations live in.</p>
        </div>
        <Button className="gap-2" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          <span className="hidden sm:inline">Add</span>
        </Button>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          variant={showHidden ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setShowHidden((value) => !value)}
        >
          {showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {showHidden ? 'Hide hidden' : 'Show hidden'}
        </Button>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card">
              <FolderGit2 className="size-5 text-muted-foreground" />
            </div>
            <p className="mt-4 text-sm font-medium">No projects yet</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              Add a folder to start conversations in it.
            </p>
            <Button className="mt-4 gap-2" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              Add project
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 pb-4">
            {visible.map((project) => (
              <ProjectRow key={project.key} project={project} />
            ))}
          </div>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
            <DialogDescription>The folder must exist and be inside an allowed root.</DialogDescription>
          </DialogHeader>
          <form onSubmit={add} className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="project-path">Folder</Label>
              <Input
                id="project-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="C:\\path\\to\\project"
                spellCheck={false}
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="project-name">Name (optional)</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Project name"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!path.trim()}>
                Add
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
