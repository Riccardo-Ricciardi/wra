import { useSyncExternalStore } from 'react';
import { get, post, setTokenGetter, ApiError } from './api';
import type { Approval, ChatMessage, Project, Session, SessionsPayload } from './types';

const TOKEN_KEY = 'cc-remote-token';

export interface AppState {
  token: string;
  connected: boolean;
  connectionLost: boolean;
  sessions: Session[];
  projects: Project[];
  approvals: Approval[];
  messages: Record<string, ChatMessage[]>;
  openId: string | null;
  error: string | null;
  loading: boolean;
  sending: boolean;
}

const initial: AppState = {
  token: typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) ?? '' : '',
  connected: false,
  connectionLost: false,
  sessions: [],
  projects: [],
  approvals: [],
  messages: {},
  openId: null,
  error: null,
  loading: true,
  sending: false,
};

let state: AppState = initial;
const listeners = new Set<() => void>();

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getState() {
  return state;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(initial),
  );
}

setTokenGetter(() => state.token);

// --- websocket -------------------------------------------------------------

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
let stopped = false;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function send(message: Record<string, unknown>) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function mergeMessages(sessionId: string, incoming: ChatMessage[], replace = false) {
  const current = state.messages[sessionId] ?? [];
  if (replace) {
    set({ messages: { ...state.messages, [sessionId]: incoming } });
    return;
  }
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  set({ messages: { ...state.messages, [sessionId]: [...byId.values()] } });
}

function handleMessage(raw: string) {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const t = message.t as string;
  if (t === 'welcome' || t === 'sessions') {
    set({ sessions: (message.sessions as Session[]) ?? state.sessions });
    return;
  }
  if (t === 'opened') {
    const session = message.session as Session;
    if (!session) return;
    const sessions = state.sessions.some((s) => s.sessionId === session.sessionId)
      ? state.sessions.map((s) => (s.sessionId === session.sessionId ? session : s))
      : [session, ...state.sessions];
    set({ sessions, openId: session.sessionId });
    return;
  }
  if (t === 'chat') {
    const sessionId = message.sessionId as string;
    const messages = (message.messages as ChatMessage[]) ?? [];
    mergeMessages(sessionId, messages, message.history === true);
    return;
  }
  if (t === 'approval') {
    const approval = message.approval as Approval;
    if (!approval) return;
    const others = state.approvals.filter((a) => a.id !== approval.id);
    set({ approvals: [...others, approval] });
    return;
  }
  if (t === 'approval_gone') {
    set({ approvals: state.approvals.filter((a) => a.id !== message.id) });
    return;
  }
  if (t === 'error') {
    set({ error: String(message.message ?? 'Something went wrong') });
    return;
  }
}

function connect() {
  if (!state.token) {
    set({ loading: false });
    return;
  }
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  stopped = false;
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl(), [`bearer.${state.token}`]);
  } catch {
    scheduleRetry();
    return;
  }
  socket = ws;

  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    failures = 0;
    set({ connected: true, connectionLost: false, loading: false, error: null });
    send({ t: 'hello', role: 'chat', sessionId: state.openId ?? undefined });
    void refresh();
  });

  ws.addEventListener('message', (event) => handleMessage(String(event.data)));

  ws.addEventListener('close', async (event) => {
    // An old socket must not touch the new one's state: `signIn` closes and reopens, and the
    // first one's `close` arrives afterwards.
    if (socket !== ws) return;
    socket = null;
    set({ connected: false, connectionLost: true });
    if (event.code === 1008) {
      rejectedToken();
      return;
    }
    // The server rejects a bad token by writing `HTTP/1.1 401` and closing: the browser reports
    // that as 1006, the same as a dropped network. The only way to tell them apart is to ask.
    if (await probeToken()) return;
    scheduleRetry();
  });

  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {
      // already closed
    }
  });
}

/** The token is no longer valid: leave and go back to the sign-in screen. */
function rejectedToken() {
  localStorage.removeItem(TOKEN_KEY);
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const old = socket;
  socket = null;
  try {
    old?.close();
  } catch {
    // already closed
  }
  set({ token: '', connected: false, connectionLost: false, loading: false, error: 'Your access token was rejected. Sign in again.' });
}

/** `true` se il server dice che il token è sbagliato. Una rete caduta non è un rifiuto. */
async function probeToken(): Promise<boolean> {
  try {
    const response = await fetch('/healthz', { headers: { 'x-cc-remote-token': state.token } });
    if (response.status === 401) {
      rejectedToken();
      return true;
    }
  } catch {
    // server irraggiungibile: si riprova
  }
  return false;
}

function scheduleRetry() {
  if (stopped || retryTimer || socket) return;
  failures += 1;
  const delay = Math.min(1200 * failures, 8000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

export function start() {
  connect();
}

export function stop() {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  socket?.close();
  socket = null;
}

export function signIn(token: string) {
  const clean = token.trim();
  if (!clean) return;
  localStorage.setItem(TOKEN_KEY, clean);
  set({ token: clean, error: null, loading: true });
  stop();
  stopped = false;
  failures = 0;
  connect();
}

/**
 * A link may carry the token (`?token=...`), which is how the server gates the classic UI and how
 * `wra web` can open an authenticated session. Adopt it once, then take it out of the address bar:
 * an access token should not stay in the history or in a shared screenshot.
 */
export function adoptTokenFromUrl() {
  if (typeof location === 'undefined' || state.token) return false;
  const url = new URL(location.href);
  const token = url.searchParams.get('token');
  if (!token) return false;
  url.searchParams.delete('token');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  signIn(token);
  return true;
}

export function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  stop();
  set({ ...initial, token: '', loading: false });
}

// --- data ------------------------------------------------------------------

export async function refresh() {
  try {
    const payload = await get<SessionsPayload>('/local/sessions');
    set({
      sessions: payload.sessions ?? [],
      projects: payload.projects ?? [],
      approvals: payload.approvals ?? [],
      loading: false,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      rejectedToken();
      return;
    }
    set({ error: error instanceof Error ? error.message : 'Could not load conversations' });
  }
}

export function openSession(sessionId: string) {
  set({ openId: sessionId });
  send({ t: 'open', sessionId });
}

export function closeSession() {
  set({ openId: null });
}

export async function sendMessage(text: string) {
  const sessionId = state.openId;
  const message = text.trim();
  if (!sessionId || !message) return;
  set({ sending: true, error: null });
  try {
    await post('/local/talk', { sessionId, message });
  } catch (error) {
    set({ error: error instanceof Error ? error.message : 'Message not sent' });
  } finally {
    set({ sending: false });
  }
}

export async function decideApproval(id: string, behavior: 'allow' | 'deny') {
  try {
    await post(`/local/approvals/${id}`, { behavior });
    set({ approvals: state.approvals.filter((a) => a.id !== id) });
  } catch (error) {
    set({ error: error instanceof Error ? error.message : 'Could not answer the request' });
  }
}

export async function sessionAction(
  sessionId: string,
  action: string,
  body: Record<string, unknown> = {},
) {
  try {
    const result = await post<{ session?: Session }>(`/local/sessions/${sessionId}/${action}`, body);
    if (result.session) {
      set({
        sessions: state.sessions.map((s) => (s.sessionId === sessionId ? result.session! : s)),
      });
    }
    return result;
  } catch (error) {
    set({ error: error instanceof Error ? error.message : 'Action failed' });
    throw error;
  }
}

export async function projectAction(action: string, body: Record<string, unknown> = {}) {
  try {
    const result = await post<{ projects?: Project[] }>(`/local/projects/${action}`, body);
    if (result.projects) set({ projects: result.projects });
    return result;
  } catch (error) {
    set({ error: error instanceof Error ? error.message : 'Action failed' });
    throw error;
  }
}

export async function createConversation(projectPath: string, name?: string) {
  try {
    const result = await post<{ session: Session }>('/local/sessions', { projectPath, name });
    set({ sessions: [result.session, ...state.sessions] });
    openSession(result.session.sessionId);
    return result.session;
  } catch (error) {
    set({ error: error instanceof Error ? error.message : 'Could not start a conversation' });
    throw error;
  }
}

export function clearError() {
  set({ error: null });
}
