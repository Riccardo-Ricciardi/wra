import { useState } from 'react';
import { ArrowRight, KeyRound } from 'lucide-react';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signIn, useApp } from '@/lib/store';

export function LoginPage() {
  const [token, setToken] = useState('');
  const error = useApp((s) => s.error);

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2">
          <BrandMark className="size-6" />
          <span className="text-base font-semibold tracking-tight">WRA</span>
        </div>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste the token printed by <code className="font-mono text-xs">wra start</code>. It lives in{' '}
          <code className="font-mono text-xs">~/.cc-remote/token</code>.
        </p>

        <form
          className="mt-6 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            signIn(token);
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="token">Access token</Label>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="token"
                autoComplete="current-password"
                className="pl-9"
                autoFocus
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={!token.trim()} className="gap-2">
            Continue <ArrowRight className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
