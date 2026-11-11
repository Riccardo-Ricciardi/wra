/**
 * L'ambiente di chi lancia le prove non è l'ambiente della prova.
 *
 * Questa macchina **è** anche quella che fa girare cc-remote, quindi chi sviluppa ha in giro
 * `CR_SINGLE_HOST=1`, `CR_MCP_HOST=…`, `CR_REMOTE_PERMISSIONS=1`, `CR_CLAUDE_CMD=…`. Un test che
 * lancia `serve.mjs` con `...process.env` se li porta dietro **tutti**, e finisce per provare un
 * server diverso da quello che crede: con la modalità a un hostname solo accesa, `/` sull'host
 * pubblico risponde 200 — ed è giusto che risponda. A essere sbagliata è la prova, che credeva di
 * essere in modalità a due hostname.
 *
 * Quindi si parte da un ambiente **senza** niente di cc-remote, e si scrive solo quello che la
 * prova vuole. `PATH`, `TEMP`, `USERPROFILE` e il resto restano quelli veri: servono al processo,
 * non alla configurazione.
 *
 * Sei prove fallivano per questo, sempre le stesse, su `main` come sui rami — ed erano sei prove
 * che dicevano il vero su una configurazione che nessuno aveva chiesto.
 */
export function serverEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CR_')) delete env[key];
  }
  return { ...env, ...overrides };
}
