# Product

## Register

product

## Users

Il proprietario di questa macchina, e le poche persone a cui la mostra. Tre contesti veri, e sono
diversi:

- **Al PC, la sera.** Una finestra larga, il terminale accanto, più conversazioni aperte insieme.
  Sa cos'è Claude Code. Vuole trovare la conversazione giusta e vedere se qualcosa aspetta lui.
- **Dal telefono, in piedi.** Una mano sola, 390px, spesso con la rete che va e viene. Vuole
  leggere cosa ha risposto l'agente e approvare, o rispondere. Non vuole configurare niente.
- **Chi non conosce Claude Code.** La persona a cui il proprietario manda il link. Non sa cosa sia
  una «modalità di permesso», non ha mai aperto PowerShell, e non deve impararlo per usare questa
  pagina.

Il lavoro da fare, su ogni schermata, è sempre uno di questi due: **trovare una conversazione** fra
molte, o **capire e decidere cosa può fare l'agente** in quella aperta.

## Product Purpose

cc-remote è la finestra su conversazioni di Claude Code che girano su **questa** macchina, dal
browser e dal telefono. Non è un'interfaccia che parla a un servizio: quello che si vede è un
processo vero, con i privilegi dell'utente di Windows, che legge e scrive file veri.

Esiste perché il terminale è il posto giusto per lavorare e il posto sbagliato per *sorvegliare*:
si vuole poter guardare da un'altra stanza cosa sta facendo l'agente, e rispondere a una richiesta
di permesso senza tornare alla scrivania.

Riesce quando: una persona apre la pagina e in dieci secondi sa **cosa sta guardando**, **cosa può
fare l'agente lì dentro**, e **dove si cambia**. Fallisce quando bisogna sapere come si chiama una
modalità per capire se è accesa.

## Brand Personality

**Preciso, calmo, onesto.**

- **Preciso** — dice numeri veri e stati veri. Niente «sto pensando» inventato: l'unico segnale di
  attività è quello che il coordinatore dei turni sa davvero.
- **Calmo** — non allarma e non rassicura. Un permesso saltato si vede, non lampeggia.
- **Onesto** — non promette una sicurezza che non c'è. Se una modalità è pericolosa, lo scrive con
  le parole che servono, e non la chiama «sandbox».

La voce è quella di un buon strumento di misura: dice il valore, e non commenta.

## Anti-references

- **Sé stessa, oggi.** L'impressione da evitare è quella che il proprietario ha descritto: «un
  pannello tecnico sperimentale». In concreto: tutto alla stessa dimensione, targhette che
  chiedono di sapere una parola, comandi tutti uguali.
- **La dashboard a riquadri.** Griglia di card con il numero grande e l'etichetta piccola sotto
  (`06-pannello-stato-1440.png` è esattamente questo). Vale anche per il modello «sidebar + card +
  grafici».
- **Il tema scuro da strumento per sviluppatori.** Neon su nero, accenti saturi, monospaziato
  ovunque. cc-remote ha un terminale dentro, e questo non è un motivo per sembrare un terminale.
- **I default di una libreria di componenti.** Il grigio-su-bianco con un accento decorativo, i
  raggi tutti uguali, l'ombra identica su ogni cosa.
- **La pagina di marketing.** Frasi che vendono, sezioni numerate `01 / 02 / 03`, occhielli in
  maiuscoletto sopra ogni titolo.

## Design Principles

1. **Lo stato si vede, non si deduce.** Quello che l'agente può fare in una conversazione si legge
   dalla forma e dal colore, non da una parola che va conosciuta. Se per capirlo bisogna leggere
   una targhetta, la targhetta è il difetto.
2. **Il default deve sembrare il default.** «Normale» è la modalità di partenza e deve avere
   l'aspetto della normalità: spenta, neutra, senza contrassegni. Tutto ciò che si allontana da lì
   prende un segno che cresce con il privilegio.
3. **La decisione pesante costa di più.** Attivare il bypass o esporre una chat a un modello
   remoto sono le due azioni più gravi dell'interfaccia e non possono costare lo stesso gesto di
   «copia l'id». Non si difendono con un colore: si difendono con una schermata che dice cosa si
   sta accettando.
4. **Il numero c'è, e non urla.** Conteggi, date, id, percorsi e nomi di modalità sono **dati**:
   hanno una voce propria (monospaziata), stanno in secondo piano, e non si arrotondano né si
   nascondono. Un filtro senza il suo numero è un filtro di cui non ci si fida.
5. **Quello che non c'è non si inventa.** Nessun segnaposto, nessuno stato finto, nessuna parola
   che promette più di quello che il sistema fa. `docs/SECURITY.md` è la fonte, e l'interfaccia
   non può contraddirla.

## Accessibility & Inclusion

- **WCAG 2.1 AA**, e il contrasto si **misura sui nodi resi**, non solo sulle coppie di token
  (vedi `docs/AUDIT-M6.md` §6: il controllo sui token passava mentre quattro coppie vere stavano
  a 4.28–4.49).
- **Bersagli da dito ≥ 44px** sotto i 60rem. Oggi ne resta uno solo sotto soglia (il campo di
  ricerca, 38px) e va alzato.
- **Tastiera ovunque**, con un ordine di tabulazione sensato e `:focus-visible` su tutto. Oggi 171
  elementi raggiungibili e zero senza nome accessibile: va mantenuto.
- **`prefers-reduced-motion`** e **`prefers-contrast: more`** rispettati, come oggi.
- **Zoom al 200%** senza perdita di contenuto o di comandi.
- **Niente è comunicato dal solo colore**: ogni stato ha anche una parola o una forma, perché il
  daltonismo è comune e il rosso/verde è la coppia che si perde per prima.
- **Il telefono non è la versione ridotta**: le azioni che si fanno da lì (leggere, rispondere,
  approvare, cambiare modalità) hanno lo stesso peso di quelle da PC.
