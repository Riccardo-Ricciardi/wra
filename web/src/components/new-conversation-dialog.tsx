import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderGit2, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createConversation, useApp } from '@/lib/store';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewConversationDialog({ open, onOpenChange }: Props) {
  const projects = useApp((s) => s.projects);
  const navigate = useNavigate();
  const visible = projects.filter((p) => !p.hidden);
  const [path, setPath] = useState(visible[0]?.path ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !path) setPath(visible[0]?.path ?? '');
  }, [open, path, visible]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createConversation(path.trim(), name.trim() || undefined);
      onOpenChange(false);
      setName('');
      navigate(`/c/${session.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the conversation');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
          <DialogDescription>Pick a project. The agent starts when you send the first message.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid grid-cols-1 gap-4">
          {visible.length > 0 && (
            <div className="grid grid-cols-1 gap-2">
              <Label>Project</Label>
              <div className="grid grid-cols-1 max-h-48 gap-1 overflow-y-auto scrollbar-thin">
                {visible.map((project) => (
                  <button
                    key={project.key}
                    type="button"
                    onClick={() => setPath(project.path)}
                    className={cn(
                      'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                      path === project.path
                        ? 'border-foreground/30 bg-accent'
                        : 'border-transparent hover:bg-accent',
                    )}
                  >
                    <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{project.open}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2">
            <Label htmlFor="new-path">Folder</Label>
            <Input
              id="new-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="C:\\path\\to\\project"
              spellCheck={false}
            />
          </div>
          <div className="grid grid-cols-1 gap-2">
            <Label htmlFor="new-name">Name (optional)</Label>
            <Input
              id="new-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="What are we working on?"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !path.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Start
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
