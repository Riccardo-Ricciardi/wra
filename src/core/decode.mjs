// Il formato del transcript è interno a Claude Code e cambia fra versioni: la documentazione
// lo dice ("scripts that parse these files directly can break on any release"). Per questo
// tutto ciò che dipende da quel formato passa da qui: se cambia, si cambia questo file e le
// sue fixtures, e il resto del progetto non se ne accorge.
//
// Il terminale non c'entra mai: sono byte di un PTY. Se il formato cambia, il danno è la
// vista chat e la conferma dei turni, e si vede subito (selfCheck rumoroso + match che scade).
export {
  slugForProjectDir,
  discoverCandidates,
  readRecentEntries,
  userPromptText,
  isToolResult,
  assistantText,
  assistantToolNames,
  stopReason,
  isTurnOpen,
  TailingReader,
  ReplyAssembler,
} from './transcript.mjs';

import { readRecentEntries, userPromptText, assistantText, isToolResult, stopReason } from './transcript.mjs';

/**
 * Dice se il decoder capisce ancora il formato: si guardano le ultime entry di un transcript.
 * `ok: false` con un motivo chiaro è meglio di una chat che resta vuota senza spiegazione.
 */
export function selfCheck(file, { bytes = 256 * 1024 } = {}) {
  const entries = readRecentEntries(file, bytes);
  if (!entries.length) {
    return { ok: false, reason: 'no recently readable entries', prompts: 0, replies: 0, turns: 0 };
  }

  let prompts = 0;
  let replies = 0;
  let turns = 0;
  for (const entry of entries) {
    if (userPromptText(entry) && !isToolResult(entry)) prompts += 1;
    if (assistantText(entry)) replies += 1;
    if (stopReason(entry) === 'end_turn') turns += 1;
  }

  if (!prompts) return { ok: false, reason: 'no user prompt recognised', prompts, replies, turns };
  if (!replies) return { ok: false, reason: 'no reply recognised', prompts, replies, turns };
  return { ok: true, reason: 'ok', prompts, replies, turns };
}