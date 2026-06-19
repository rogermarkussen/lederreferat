# LM-referatsøk

Statisk søkeapp for ledermøtereferater. Appen kan publiseres på GitHub Pages og trenger ikke Python eller backend i normal bruk.

## Bruk

Start en enkel lokal server ved utvikling:

```bash
python3 -m http.server 8765
```

Åpne:

```text
http://127.0.0.1:8765/app/
```

I appen:

1. Trykk `Åpne referatmappe`.
2. Velg den lokale mappen der PDF-referatene ligger.
3. Appen indekserer PDF-ene i nettleseren med PDF.js.
4. Når indekseringen er ferdig, lagres indeksen i `localStorage`.
5. Ved neste åpning lastes cached indeks først. Hvis nettleseren fortsatt har mappetilgang, sjekkes PDF-filene automatisk mot cached indeks. Appen sammenligner filnavn, filstørrelse og `lastModified`; nye, fjernede eller endrede PDF-er utløser ny indeksering med en gang.

Selve mappehandle-en kan ikke lagres i `localStorage` av nettlesersikkerhetsgrunner. Den lagres derfor i IndexedDB, mens foldermetadata og ferdig indeks lagres i `localStorage`.

## Oppgaver

Fanen `Oppgaver` bruker aksjonspunktene (`AP...`) som parseren finner i referatene. Ved indeksering opprettes mappen `__oppgavedata__` i referatmappen, med filen `oppgaver.json`.

Hvis `oppgaver.json` allerede finnes, overskriver ikke indekseringen eksisterende oppgaver. Den legger bare til nye AP-er fra nye eller endrede referater. Manuelle endringer som status, ansvarlig, frist og tilleggsinfo lagres tilbake i samme fil.

Oppgavevisningen kan filtreres på åpne, utførte og alle oppgaver, og på ansvarlig. Søket dekker AP-id, oppgavetekst, ansvarlig, frist, sakstittel, kontekst og tilleggsinfo.

## Nettleserkrav

Mappevalg bruker File System Access API med lese- og skrivetilgang. Bruk Chrome eller Edge. På GitHub Pages må appen kjøres over HTTPS, som GitHub Pages gjør automatisk.

## Søk

Søk kan deles direkte:

```text
http://127.0.0.1:8765/app/?q=nødnett
http://127.0.0.1:8765/app/?q=AP17-1
http://127.0.0.1:8765/app/?q=2.60
```

Rangeringen er deterministisk. Eksakt AP-id og saksnummer gir streng match. Ellers vektes treff i denne rekkefølgen:

1. Saksnummer og AP-id
2. Sakstittel
3. Aksjonspunkt og ansvarlig
4. Vedtak og oppfølging
5. Brødtekst

## Filer

- `app/index.html` - statisk HTML
- `app/styles.css` - grensesnitt
- `app/app.js` - PDF-indeksering, lokal cache og søk
- `__oppgavedata__/oppgaver.json` - oppgavedata som appen oppretter i valgt referatmappe
- `scripts/build_index.py` - eldre utviklingsscript for sammenligning, ikke nødvendig for appen
