// Le rotte del server, in un posto solo.
//
// Prima erano dodici `fetch` sparsi dentro le funzioni che disegnano: cambiare una rotta voleva
// dire cercarla fra i `render`. Qui il trasporto è uno, il token è **iniettato** invece che letto
// da un globale, e `fetch` è un parametro — quindi si può provare senza un server e senza un
// browser.

/**
 * @param {object} input
 * @param {() => string} input.tokenOf   da dove viene il token, adesso
 * @param {typeof fetch} [input.fetchImpl]
 */
export function createApi({ tokenOf, fetchImpl = fetch }) {
  /**
   * Una chiamata. Il corpo dell'errore del server è la spiegazione che si mostra all'utente —
   * «questa chat salta i permessi: riportala alla modalità normale…» — quindi passa così com'è:
   * riscriverla qui vorrebbe dire avere due versioni della stessa frase.
   */
  async function api(route, { method = 'GET', body = null } = {}) {
    const headers = { 'x-cc-remote-token': tokenOf() };
    if (body) headers['content-type'] = 'application/json';
    const response = await fetchImpl(route, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(json?.error ?? `errore ${response.status}`);
    return json;
  }

  return {
    api,
    get: (route) => api(route),
    post: (route, body) => api(route, { method: 'POST', body }),
  };
}
