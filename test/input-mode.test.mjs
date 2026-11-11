import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputModeFilter, stripInputMode } from '../src/core/input-mode.mjs';

// Il filtro che ha reso possibile Ctrl+Q.
//
// ConPTY chiede al terminale di passare a «win32-input-mode» appena parte, e quella richiesta
// (`ESC[?9001h`) finiva dritta nel terminale di chi si aggancia: da lì in poi i tasti arrivano
// come sequenze e non più come byte, quindi `0x11` non esisteva più. Qui si prova che la
// richiesta venga tolta — e che toglierla non porti via altro.

const ON = '\x1b[?9001h';
const OFF = '\x1b[?9001l';

test('la richiesta di win32-input-mode non passa', () => {
  assert.equal(stripInputMode(ON).text, '');
  assert.equal(stripInputMode(OFF).text, '');
  assert.equal(stripInputMode(`${ON}ciao`).text, 'ciao');
  assert.equal(stripInputMode(`prima${ON}in mezzo${OFF}dopo`).text, 'primain mezzodopo');
  // Quella che conptY manda davvero all'avvio, insieme al resto.
  assert.equal(stripInputMode(`\x1b[?9001h\x1b[?1004h\x1b[2J`).text, '\x1b[?1004h\x1b[2J');
});

test('una sequenza spezzata in due pezzi non passa nemmeno lei', () => {
  // Il caso che conta: un PTY non è tenuto a rispettare i confini di quello che scrive.
  for (let cut = 1; cut < ON.length; cut += 1) {
    const first = stripInputMode(ON.slice(0, cut));
    const second = stripInputMode(ON.slice(cut) + 'ciao', first.carry);
    assert.equal(`${first.text}${second.text}`, 'ciao', `taglio a ${cut}: è passato qualcosa`);
    assert.equal(second.carry, '');
  }
  // E la stessa cosa con la coda che finisce per sbaglio come l'inizio di una sequenza.
  const partial = stripInputMode('testo\x1b[?');
  assert.equal(partial.text, 'testo');
  assert.equal(partial.carry, '\x1b[?');
  assert.equal(stripInputMode('9001habc', partial.carry).text, 'abc');
});

test('non si porta via quello che non è la sequenza', () => {
  // `?9002h` non è quella richiesta: si lascia stare.
  assert.equal(stripInputMode('\x1b[?9002h').text, '\x1b[?9002h');
  assert.equal(stripInputMode('\x1b[?9001x').text, '\x1b[?9001x');
  // I byte di controllo veri restano intatti: Ctrl+C deve continuare ad arrivare a Claude.
  assert.equal(stripInputMode('a\x03b\x11c').text, 'a\x03b\x11c');
  assert.equal(stripInputMode('niente da filtrare').text, 'niente da filtrare');
});

test('un filtro per flusso: la memoria non si mescola e non perde niente', () => {
  const one = createInputModeFilter();
  const other = createInputModeFilter();
  assert.equal(one.write(`${ON}ciao`), 'ciao');
  assert.equal(one.write('mondo'), 'mondo');
  assert.equal(other.write('\x1b[?90'), '', 'la coda resta in attesa');
  assert.equal(one.write('altro'), 'altro', 'e non finisce nel flusso sbagliato');
  assert.equal(other.write('01hresto'), 'resto');
  // Un flusso che finisce in mezzo a una sequenza non ha niente da recuperare: sono i primi
  // byte di una richiesta che non è arrivata, e buttarli è la cosa giusta da fare.
  assert.equal(one.write('\x1b[?90'), '', 'resta in attesa');
});

test('testo normale: si comporta come se il filtro non ci fosse', () => {
  const filter = createInputModeFilter();
  const messy = ['\x1b[2J\x1b[H', 'riga uno\r\n', 'riga due\r\n', '\x1b[1;32mverde\x1b[0m'];
  for (const chunk of messy) assert.equal(filter.write(chunk), chunk);
});
