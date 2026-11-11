// Filtro dell'output che arriva dal PTY prima di mandarlo a un terminale vero.
//
// Perché serve — e non è una precauzione teorica, è **la causa** per cui Ctrl+Q non staccava.
//
// ConPTY (il PTY di Windows) scrive `ESC[?9001h` come primissimi byte di ogni sessione: è la
// richiesta di «win32-input-mode», cioè «da adesso mandami i tasti come sequenze, non come
// byte». `rc attach` rigira al terminale locale tutto quello che arriva dal PTY, quindi quella
// richiesta arriva a Windows Terminal **come se fosse sua**: da quel momento ogni tasto viene
// codificato `ESC[81;0;17;1;40;1_` invece che come `0x11`, e `detachAt` non trova più niente.
//
// A spegnerla ci penserebbe `ESC[?9001l`, che il TUI scrive all'avvio — ma conhost se lo mangia
// e non lo lascia passare. Quindi resta accesa per tutta la vita della sessione, per chiunque si
// agganci, e anche nel replay che si riceve agganciandosi dopo.
//
// La richiesta è del PTY **per il suo programma**, non nostra: il terminale locale non parla con
// quel programma, parla con noi. Si toglie. (È quello che fanno tmux e i forwarder di PTY seri.)
//
// ponytail: si filtra solo `?9001h`/`?9001l`, non tutte le sequenze che cambiano la modalità
// della tastiera. Le altre o servono (mouse, focus) o non toccano i byte di controllo che ci
// interessano. Se ne comparisse un'altra che rompe lo stacco, la si aggiunge qui.

const MARKER = '\x1b[?9001';
const ENDINGS = ['h', 'l'];

/** Quanti caratteri in coda sono l'inizio di una sequenza: vanno tenuti per il pezzo dopo. */
function partialMarker(tail) {
  for (let keep = Math.min(MARKER.length - 1, tail.length); keep > 0; keep -= 1) {
    if (tail.endsWith(MARKER.slice(0, keep))) return keep;
  }
  return 0;
}

/**
 * Toglie le richieste di win32-input-mode da un pezzo di output.
 *
 * Un PTY non è tenuto a rispettare i confini di quello che scrive: la sequenza può arrivare
 * spezzata in due pezzi. La coda incompleta non si manda — si tiene da parte e si completa col
 * pezzo dopo, altrimenti `…\x1b[?90` + `01h…` passerebbe intero ed è esattamente il caso che
 * questo filtro esiste per evitare.
 *
 * Se il flusso finisce in mezzo a una sequenza, quei pochi byte si buttano: sono l'inizio di una
 * richiesta che non è mai arrivata, e mandarli servirebbe solo a scrivere mezzo comando sul
 * terminale di chi guarda.
 *
 * @param {string} text
 * @param {string} [carry]  la coda lasciata in sospeso dal pezzo precedente
 * @returns {{text: string, carry: string}}
 */
export function stripInputMode(text, carry = '') {
  const joined = carry + text;
  let out = '';
  let index = 0;

  while (index < joined.length) {
    const at = joined.indexOf(MARKER, index);
    if (at === -1) {
      const tail = joined.slice(index);
      const keep = partialMarker(tail);
      return { text: out + (keep ? tail.slice(0, tail.length - keep) : tail), carry: keep ? tail.slice(tail.length - keep) : '' };
    }
    out += joined.slice(index, at);
    const rest = joined.slice(at);
    if (rest.length < MARKER.length + 1) return { text: out, carry: rest };
    if (!ENDINGS.includes(rest[MARKER.length])) {
      // Non è la sequenza che conosciamo: si lascia passare com'è, un carattere per volta.
      out += rest[0];
      index = at + 1;
      continue;
    }
    index = at + MARKER.length + 1; // `?9001h` o `?9001l`: si buttano tutte e due
  }

  return { text: out, carry: '' };
}

/** Un filtro con la sua memoria, per un flusso solo: `write(data)` → quello che va mandato. */
export function createInputModeFilter() {
  let carry = '';
  return {
    write(data) {
      const result = stripInputMode(data, carry);
      carry = result.carry;
      return result.text;
    },
  };
}
