// Dove finisce un menu che appartiene a un pulsante.
//
// È la prova che tiene fermo il difetto di M9: ogni menu si apriva a `left: 8px`, staccato dalla
// sua ancora. La causa stava nel DOM, ma la **regola** sta in una funzione pura, e una regola si
// prova qui: se un giorno qualcuno la cambia, questi casi cadono prima che il difetto torni in
// una schermata.
import test from 'node:test';
import assert from 'node:assert/strict';

import { placeAnchored, GAP, GUTTER } from '../src/web/ui/anchor.mjs';

const schermo = (width, height) => ({ width, height });
const ancora = ({ top, left, width = 32, height = 32 }) => ({ top, left, right: left + width, bottom: top + height });

const dentro = (dove, size, viewport) => dove.left >= 0
  && dove.top >= 0
  && dove.left + Math.min(size.width, viewport.width - 2 * GUTTER) <= viewport.width + 1e-6
  && dove.top + dove.height <= viewport.height + 1e-6;

test('il menu sta attaccato alla sua ancora, non al bordo della pagina', () => {
  const dove = placeAnchored(ancora({ top: 300, left: 1060 }), { width: 328, height: 240 }, schermo(1440, 900));
  // Il bordo destro del menu su quello dell'ancora: è quello che si vuole vedere.
  assert.equal(dove.left, 1060 + 32 - 328);
  assert.equal(dove.top, 300 + 32 + GAP);
  assert.equal(dove.flip, false);
});

test('un menu alto vicino al fondo si ribalta sopra', () => {
  const dove = placeAnchored(ancora({ top: 820, left: 1200 }), { width: 240, height: 300 }, schermo(1440, 900));
  assert.equal(dove.flip, true);
  assert.ok(dove.top < 820, 'sopra l\'ancora');
  assert.ok(dentro(dove, { width: 240, height: 300 }, schermo(1440, 900)));
});

test('non si ribalta se sopra non c\'è più spazio che sotto', () => {
  // Ancora a metà schermo, menu altissimo: sotto ce n'è meno, ma sopra nemmeno. Si limita e scorre.
  const dove = placeAnchored(ancora({ top: 400, left: 100 }), { width: 240, height: 3000 }, schermo(1440, 900));
  assert.equal(dove.flip, false);
  assert.equal(dove.height, 900 - 2 * GUTTER);
  assert.equal(dove.scroll, true);
  assert.ok(dentro(dove, { width: 240, height: 3000 }, schermo(1440, 900)));
});

test('un\'ancora al bordo sinistro non manda il menu fuori schermo', () => {
  const dove = placeAnchored(ancora({ top: 100, left: 0 }), { width: 328, height: 200 }, schermo(1440, 900));
  assert.equal(dove.left, GUTTER);
  assert.ok(dentro(dove, { width: 328, height: 200 }, schermo(1440, 900)));
});

test('un\'ancora al bordo destro non manda il menu fuori schermo', () => {
  const dove = placeAnchored(ancora({ top: 100, left: 1408 }), { width: 328, height: 200 }, schermo(1440, 900));
  assert.equal(dove.left, 1440 - 328 - GUTTER);
  assert.ok(dentro(dove, { width: 328, height: 200 }, schermo(1440, 900)));
});

test('niente esce dallo schermo a nessuna delle sei larghezze', () => {
  const larghezze = [320, 390, 768, 1024, 1440, 1920];
  for (const larghezza of larghezze) {
    for (const alto of [0, 200, 700]) {
      for (const sinistra of [0, larghezza / 2, larghezza - 32]) {
        for (const misura of [[224, 180], [328, 520], [1400, 100]]) {
          const viewport = schermo(larghezza, 900);
          const size = { width: misura[0], height: misura[1] };
          const dove = placeAnchored(ancora({ top: alto, left: sinistra }), size, viewport);
          assert.ok(
            dentro(dove, size, viewport),
            `esce dallo schermo a ${larghezza}px: ${JSON.stringify({ dove, size, alto, sinistra })}`,
          );
        }
      }
    }
  }
});

test('un menu più largo dello schermo resta dentro e comincia dal margine', () => {
  const dove = placeAnchored(ancora({ top: 100, left: 200 }), { width: 1400, height: 200 }, schermo(320, 900));
  assert.equal(dove.left, GUTTER);
});

test('l\'altezza usata non supera mai lo spazio dello schermo', () => {
  const dove = placeAnchored(ancora({ top: 500, left: 100 }), { width: 224, height: 10 }, schermo(390, 844));
  assert.equal(dove.height, 10);
  assert.equal(dove.scroll, false);
  assert.equal(dove.top, 500 + 32 + GAP);
});
