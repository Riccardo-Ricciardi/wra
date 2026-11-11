// "Controlled automatic MCP": which permission requests can be granted on their own.
//
// The idea is a single one, and its strength lies in what it **does not** do: a permission is
// granted without asking only when the tool's entire effect is **a path**, and that path can be
// verified. `Edit`/`Write`/`Read` have a `file_path` field: there is nothing to interpret there —
// the path is resolved, checked for being inside the project, and checked for no component being a
// link. Everything else is not guessed.
//
// What never enters this list, on purpose:
//
//   * **`Bash`** (and every tool that executes code). Its input is a command string: deciding
//     whether it is harmless means reading the text, and a text filter can be bypassed (`;`,
//     backticks, `$(...)`, a script file, a binary compiled yesterday). A permission granted by a
//     filter is not a boundary: it is a hope. So Bash always asks.
//   * **Path lists that are not there.** `Glob`/`Grep` take a *pattern*, which can contain `..` or
//     an absolute path: the same story as text. They ask.
//   * **Credentials and security configuration**, even inside the project: `.env`, private keys,
//     `.claude/`, `.git/`, `.mcp.json`. Those are the places from which the rules are changed
//     instead of followed — a `.claude/settings.json` written by the project can grant itself
//     permissions this policy does not see.
//
// The default is **ask**: every doubt, every missing field, every path that cannot be verified
// ends in "I am not deciding", that is, in the person's dialog. A security policy that errs must
// cost a question, never a permission.
import path from 'node:path';
import { isInside, linkInPath, normalizePath } from '../core/paths.mjs';

/**
 * The tools whose entire effect is **one** path, and the field that contains it. Outside this
 * list nothing is granted on its own.
 */
const PATH_TOOLS = new Map([
  ['Read', 'file_path'],
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);

/** Folders that are never touched automatically: they are the rules of the game, not the game. */
const RESERVED_DIRS = new Set(['.claude', '.git', '.cc-remote', '.ssh', '.aws', '.gnupg']);

/** Files named like this because they contain a secret or change what the agent can do. */
const RESERVED_FILES = new Set(['.mcp.json', '.npmrc', '.netrc', '.htpasswd', 'credentials', 'credentials.json']);
const SECRET_PATTERNS = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
];

const isSecretName = (name) => RESERVED_FILES.has(name.toLowerCase()) || SECRET_PATTERNS.some((pattern) => pattern.test(name));

/**
 * The name as the filesystem understands it, not as it is written.
 *
 * On Windows a path can carry the name of a **stream**: `.env::$DATA` is the main content of
 * `.env`, and `id_rsa:note` is a stream inside `id_rsa` (verified: with `.env::$DATA` the text
 * ends up inside `.env`). The check here is done on the **name**, so a name that looks like
 * nothing would pass: the stream part is cut off before looking.
 *
 * Trailing dots and spaces are removed out of caution, not because they are needed: Node leaves
 * them alone (with `fs` a file named `.env ` is a **different** file from `.env` — verified), but
 * other tools normalize them, and a name that *looks* like `.env` to someone else must not pass
 * through here.
 */
const realName = (piece) => String(piece).split(':')[0].replace(/[. ]+$/, '');

/**
 * A name that **looks like a short 8.3 alias**. On Windows a file can have two names, and the
 * second one (`ENV~1` for `.env`) is a path to the same file: verified, writing `ENV~1` puts the
 * text inside `.env`. Here the alias is not resolved — resolving it would mean asking the
 * filesystem which file it really is, and erring costs a permission instead of a question. We ask.
 *
 * The shape is the one Windows generates: up to six characters of the long name, `~`, a number, and
 * the extension if any (`CREDEN~1.JSO`). It applies to a folder too, so every component of the
 * path is checked, not just the last. A file actually named `a~1` will ask: that is the price, and
 * it is the right price.
 */
const looksLikeShortAlias = (piece) => /^[^.]{1,6}~\d/.test(String(piece));

/**
 * Is the permission granted on its own? `null` means **no**: ask the person.
 *
 * @param {object} input
 * @param {object} input.session    the conversation view (`registry.get`)
 * @param {boolean} [input.projectAuto] the project switch, for those who chose nothing on the
 *   individual conversation
 * @param {string} input.toolName
 * @param {object} [input.input]    the `tool_input` as it arrives from the hook
 * @returns {{behavior: 'allow', reason: string}|null}
 */
export function decideAutoApproval({ session, projectAuto = false, toolName, input = {} } = {}) {
  if (!session) return null;
  // Off, archived, or in bypass: bypass does not even go through the hook (there is no permission
  // to ask), so a "yes" from here would be an answer to a question nobody asked — and the person
  // would believe the boundary was working.
  if (session.archived) return null;
  if (session.permissionMode === 'bypassPermissions') return null;

  // The conversation switch wins over the project one; neither is on until someone turns it on.
  const enabled = session.autoApprove ?? projectAuto;
  if (enabled !== true) return null;

  const field = PATH_TOOLS.get(toolName);
  if (!field) return null;

  const raw = input?.[field];
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const project = session.projectPath;
  if (typeof project !== 'string' || !project.trim()) return null;

  // A relative path is read **relative to the conversation's project**, not relative to where the
  // server runs: they are two different folders, and confusing them would mean verifying one path
  // and granting another.
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(project, raw);
  if (!isInside(resolved, project)) return null;

  // No component of the path under the project can be a link: a link inside the project points
  // wherever it wants, and "inside the project" would stop being true without the path saying so.
  // It also applies to files that do not exist yet: the component that already exists is checked.
  if (linkInPath(resolved, normalizePath(project))) return null;

  const pieces = path.relative(project, resolved).split(path.sep).filter(Boolean);
  if (pieces.some((piece) => RESERVED_DIRS.has(realName(piece).toLowerCase()))) return null;
  if (pieces.some(looksLikeShortAlias)) return null;
  if (isSecretName(realName(pieces.at(-1) ?? ''))) return null;

  return { behavior: 'allow', reason: `${toolName} inside the project, no reserved path` };
}

/**
 * The policy as the server uses it: the conversation view and the project switch are read
 * **now**, on every request. That is what makes revocation immediate: turning the switch off takes
 * effect from the next request, without restarting anything.
 *
 * @param {object} input
 * @param {(sessionId: string) => object|null} input.sessionFor
 * @param {(projectPath: string) => ({autoApprove?: boolean}|null)} [input.projectFor]
 */
export function createAutoPolicy({ sessionFor, projectFor = () => null } = {}) {
  return ({ sessionId, toolName, input }) => {
    const session = sessionFor(sessionId);
    if (!session) return null;
    const project = projectFor(session.projectPath);
    return decideAutoApproval({ session, projectAuto: project?.autoApprove === true, toolName, input });
  };
}