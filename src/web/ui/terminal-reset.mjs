// Le sequenze che rimettono a posto un terminale.
//
// Si scrivono **sempre** quando si lascia una conversazione, e non per educazione: il TUI remoto
// accende schermo alternativo, mouse, report del fuoco e bracketed paste, e se muore senza
// spegnerli il terminale di chi guarda resta in quello stato — le sequenze del mouse vanno a
// finire nel nulla, il cursore non si vede, la cronologia non scorre: sembra bloccato. Non si sa
// cosa abbia acceso, quindi si spegne tutto.
//
// Sta in `web/` perché lo usano tutti e due i terminali che mostrano una conversazione: la
// finestra di `rc attach` (`src/cli/attach.mjs`) e la scheda Terminale del browser (`app.js`).
// Una definizione sola, così non possono divergere.

export const TERMINAL_RESET = [
  '\x1b[?1049l', // esci dallo schermo alternativo (e la cronologia torna leggibile)
  '\x1b[?25h',   // mostra il cursore
  '\x1b[?1000l', '\x1b[?1002l', '\x1b[?1003l', '\x1b[?1006l', // mouse
  '\x1b[?1004l', // report del fuoco
  '\x1b[?2004l', // bracketed paste
  '\x1b[0m',     // colori
].join('');
