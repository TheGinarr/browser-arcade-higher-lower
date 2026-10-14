/* ============================================================
   Higher Lower · game.js
   ------------------------------------------------------------
   SO FUNKTIONIERT DIESES SPIEL
   1. Das Deck ist ein Array aus 52 Karten-Objekten { wert, farbe }.
      Gezogen wird mit pop() (= letzte Karte entnehmen), also ohne
      Zurücklegen. Ist das Deck leer, wird neu gemischt.
   2. Die Regeln stehen in kleinen REINEN Funktionen (neuesDeck,
      mischen, tippBewerten, zaehleVerbleibende). Sie kennen kein DOM
      und lassen sich deshalb in Node testen.
   3. Auf dem Tisch liegen zwei Karten mit gleichem Aufbau: links die
      aktuelle (offen), rechts der Stapel (verdeckt). Zum Aufdecken
      wird die rechte Karte per CSS-3D-Flip umgedreht.
   4. Ein Tipp läuft als async-Funktion in Schritten ab (aufdecken →
      bewerten → Pause → weiter). Die Variable "phase" verhindert,
      dass man mitten in der Animation noch einmal tippt.
   5. Richtig = Kette +1, Unentschieden = Kette bleibt, Falsch = Ende
      über gameOverDialog() aus ../assets/ui.js (Topliste inklusive).
   6. ZWEI MODI, ein Tisch: "Arcade" (längste Kette, ohne Geld) und
      "Casino" (Spielgeld). Der Umschalter oben speichert den Modus;
      ?modus=casino in der URL wählt ihn direkt vor (für Verlinkungen).
   7. CASINO-MODUS: Einsatz wählen, dann HOCH, TIEF oder GLEICH tippen.
      Die Quote jedes Tipps wird aus den noch verdeckten Karten
      berechnet: Wahrscheinlichkeit = Treffer-Karten / Restkarten,
      faire Quote = 1 / Wahrscheinlichkeit, davon zahlt die Bank nur
      94 % (6 % Hausvorteil). Geld läuft NUR über ../assets/wallet.js.
      Gleicher Wert verliert bei HOCH/TIEF (anders als im Arcade-
      Modus) – dafür gibt es den GLEICH-Tipp mit hoher Quote.
   ============================================================ */

import { bewegungReduziert, zahlHochzaehlen, toplisteAnzeigen, gameOverDialog, stillEintragen } from "./assets/ui.js";
import { spielZuruecksetzen, topliste, lade, speichere } from "./assets/storage.js";
import {
  STARTGELD, kontostand, einsatzAbbuchen, rundeAbschliessen,
  istPleite, pleiteNeustart, walletHud, walletHudAktualisieren,
} from "./assets/wallet.js";

const SPIEL = "higher-lower";   // Schlüssel für storage.js (Arcade-Topliste + gewählter Modus)
const SPIEL_CASINO = "higher-lower-casino";   // eigener Schlüssel: Casino-Topliste (höchster Netto-Gewinn) + Chip
const CHIPS = [10, 25, 50, 100];              // erlaubte Einsätze im Casino-Modus
const MINDESTEINSATZ = CHIPS[0];              // darunter ist man pleite
const HAUSVORTEIL = 0.06;                     // die Bank zahlt 6 % unter der fairen Quote
const MINDESTQUOTE = 1.05;                    // so wenig zahlt auch der sicherste Tipp mindestens
const MODI = ["arcade", "casino"];
const FLIP_MS = 600;              // Dauer des Aufdeckens; passt zu transition in spiel.css (.karte-dreh)
const PAUSE_MS = 900;             // so lange bleibt das Ergebnis stehen, bevor es weitergeht

/* ============================================================
   TEIL 1: REINE SPIELLOGIK (ohne DOM)
   "export" steht nur da, damit Tests in Node die Funktionen
   importieren können. Im Browser wird es nicht gebraucht.
   ============================================================ */

/*
 * Die vier Farben. Das Symbol endet auf ︎ (Variation Selector-15):
 * Er sagt dem Browser "bitte als TEXT zeichnen, nicht als bunten Emoji".
 * Sonst würden ♥ und ♦ auf manchen Geräten als Emoji erscheinen und sich
 * nicht per CSS-"color" einfärben lassen.
 */
export const FARBEN = [
  { name: "Pik",    symbol: "♠︎", rot: false },
  { name: "Herz",   symbol: "♥︎", rot: true },
  { name: "Karo",   symbol: "♦︎", rot: true },
  { name: "Kreuz",  symbol: "♣︎", rot: false },
];

/* Werte: 2..10 sind Zahlenkarten, dann Bube=11, Dame=12, König=13, Ass=14 (höchste Karte). */
const WERT_KURZ = { 11: "B", 12: "D", 13: "K", 14: "A" };
const WERT_LANG = { 11: "Bube", 12: "Dame", 13: "König", 14: "Ass" };

/** Beschriftung auf der Karte: "7", "10", "B", "D", "K", "A". */
export function kartenWertText(wert) {
  return WERT_KURZ[wert] ?? String(wert);
}

/** Ausgeschriebener Name für Screenreader/Meldungen: "Herz Dame". */
export function kartenName(karte) {
  return `${FARBEN[karte.farbe].name} ${WERT_LANG[karte.wert] ?? karte.wert}`;
}

/**
 * Baut ein frisches Deck: 13 Werte x 4 Farben = 52 Karten.
 * Optional ohne eine bestimmte Karte (`ohneKarte`): Wenn mittendrin neu
 * gemischt wird, liegt die aktuelle Karte ja schon auf dem Tisch und darf
 * nicht ein zweites Mal im Deck stecken.
 */
export function neuesDeck(ohneKarte = null) {
  const deck = [];
  for (let farbe = 0; farbe < FARBEN.length; farbe++) {
    for (let wert = 2; wert <= 14; wert++) {
      if (ohneKarte && ohneKarte.wert === wert && ohneKarte.farbe === farbe) continue;
      deck.push({ wert, farbe });
    }
  }
  return deck;
}

/**
 * Mischt nach Fisher-Yates und gibt eine gemischte KOPIE zurück.
 *
 * Idee: Von hinten nach vorne gehen. An Position i wird eine Karte
 * getauscht mit einer zufälligen Position j aus dem noch "ungemischten"
 * Bereich 0..i (inklusive i selbst!). Danach gehört Position i fest zum
 * gemischten Teil und wird nie wieder angefasst.
 * Ergebnis: jede der 52! Reihenfolgen ist gleich wahrscheinlich.
 *
 * WARUM nicht einfach sort(() => Math.random() - 0.5)?
 * Das sieht clever aus, ist aber ungleichmäßig: Sortieralgorithmen
 * erwarten einen widerspruchsfreien Vergleich. Mit Zufall dazwischen
 * bleiben manche Karten viel öfter an ihrem alten Platz.
 *
 * `zufall` ist austauschbar (Standard Math.random) – für Tests.
 */
export function mischen(karten, zufall = Math.random) {
  const kopie = [...karten];                              // Original nicht verändern
  for (let i = kopie.length - 1; i > 0; i--) {
    const j = Math.floor(zufall() * (i + 1));             // 0 … i
    [kopie[i], kopie[j]] = [kopie[j], kopie[i]];          // Tauschen (Array-Destructuring)
  }
  return kopie;
}

/**
 * Bewertet einen Tipp. Rückgabe: "richtig" | "gleich" | "falsch".
 *
 * UNENTSCHIEDEN bei gleichem Wert: Weder "höher" noch "tiefer" stimmt,
 * also wäre "falsch" unfair (der Spieler konnte nichts dafür, es gibt ja
 * 3 weitere Karten mit demselben Wert) – und "richtig" wäre geschenkt.
 * Deshalb: neutral. Die Kette bleibt, es geht einfach weiter.
 */
export function tippBewerten(aktuellerWert, naechsterWert, tipp) {
  if (naechsterWert === aktuellerWert) return "gleich";
  const warHoeher = naechsterWert > aktuellerWert;
  return (tipp === "hoch") === warHoeher ? "richtig" : "falsch";
}

/**
 * Zählt, wie viele Karten im (verdeckten) Deck höher, tiefer oder gleich
 * einem Wert sind. Der Casino-Modus berechnet daraus die Auszahlungsquoten
 * (siehe quoteBerechnen) – auch die hohe Quote des GLEICH-Tipps.
 */
export function zaehleVerbleibende(deck, wert) {
  let hoeher = 0;
  let tiefer = 0;
  let gleich = 0;
  for (const karte of deck) {
    if (karte.wert > wert) hoeher++;
    else if (karte.wert < wert) tiefer++;
    else gleich++;
  }
  return { hoeher, tiefer, gleich };
}

/* ------------------------------------------------------------
   Casino-Logik (ebenfalls rein und testbar)
   ------------------------------------------------------------ */

/**
 * Berechnet die Quote eines Tipps.
 *
 * WAHRSCHEINLICHKEIT: p = treffer / restkarten
 *   (z. B. 20 passende von 51 Karten → p = 20/51 ≈ 39 %)
 * FAIRE QUOTE: 1 / p = restkarten / treffer
 *   (20/51 → 2,55). Bei dieser Quote käme auf lange Sicht genau der Einsatz
 *   zurück: Gewinn und Verlust glichen sich aus.
 * HAUSVORTEIL: Die Bank zahlt nur 94 % der fairen Quote (Quote x 0,94).
 *   Pro 100 Einsatz bleiben ihr auf lange Sicht also 6.
 * Danach wird auf 2 Nachkommastellen gerundet und die Mindestquote 1,05
 * erzwungen (sonst zahlt ein fast sicherer Tipp praktisch nichts).
 *
 * Gibt null zurück, wenn der Tipp unmöglich ist (0 Treffer-Karten).
 */
export function quoteBerechnen(restkarten, treffer) {
  if (treffer <= 0 || restkarten <= 0) return null;
  const fair = restkarten / treffer;
  const mitHausvorteil = fair * (1 - HAUSVORTEIL);
  // Mindestquote 1,05 – aber NIE über die faire Quote hinaus: sonst
  // hätte der Spieler bei fast sicheren Tipps (p > 95 %) plötzlich
  // einen Vorteil gegenüber der Bank, und der Hausvorteil wäre weg.
  const quote = Math.min(fair, Math.max(MINDESTQUOTE, mitHausvorteil));
  return Math.round(quote * 100) / 100;
}

/**
 * Quoten für alle drei Tipps auf einmal. `wert` ist die offene Karte,
 * `deck` das verdeckte Restdeck. Unmögliche Tipps haben die Quote null.
 */
export function quotenFuerDeck(deck, wert) {
  const z = zaehleVerbleibende(deck, wert);
  return {
    hoch: quoteBerechnen(deck.length, z.hoeher),
    tief: quoteBerechnen(deck.length, z.tiefer),
    gleich: quoteBerechnen(deck.length, z.gleich),
  };
}

/**
 * Hat der Tipp im CASINO-Modus getroffen? Rückgabe true/false.
 * Wichtig: Bei gleichem Wert verliert ein HOCH- oder TIEF-Tipp (kein
 * Unentschieden wie im Arcade-Modus). Nur "gleich" trifft dann.
 */
export function casinoTippTrifft(aktuellerWert, naechsterWert, tipp) {
  if (tipp === "gleich") return naechsterWert === aktuellerWert;
  if (tipp === "hoch") return naechsterWert > aktuellerWert;
  return naechsterWert < aktuellerWert;     // "tief"
}

/** BRUTTO-Auszahlung bei Treffer: Einsatz x Quote, auf ganze Spielgeld-Einheiten gerundet. */
export function auszahlungBerechnen(einsatz, quote) {
  return Math.round(einsatz * quote);
}

/** Quote hübsch für die Anzeige: 1,71 · 15,3 · 2 (deutsches Komma, überflüssige Nullen weg). */
export function quoteText(quote) {
  return quote.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/* ============================================================
   TEIL 2: KARTEN-DOM (Bauen und Füllen)
   ============================================================ */

/** Kleiner Helfer: Element mit Klassen erzeugen (spart Schreibarbeit). */
function neuesElement(tag, klassen, text = "") {
  const el = document.createElement(tag);
  el.className = klassen;
  if (text) el.textContent = text;
  return el;
}

/** Baut eine Ecke (oben/unten) mit Wert und Symbol. */
function eckeBauen(lage) {
  const ecke = neuesElement("div", `ecke ${lage}`);
  const wert = neuesElement("span", "ecke-wert");
  const symbol = neuesElement("span", "ecke-symbol");
  ecke.append(wert, symbol);
  return { ecke, wert, symbol };
}

/**
 * Baut EINE Spielkarte als DOM und gibt Referenzen auf die Teile zurück.
 * Aufbau:
 *   .karte-szene            (perspective)
 *     .karte-dreh           (wird gedreht, preserve-3d)
 *       .flaeche.hinten     Kartenrücken
 *       .flaeche.vorne      Wert + Symbol
 * Links und rechts auf dem Tisch ist es derselbe Bauplan – deshalb eine Funktion.
 */
function karteBauen(aufgedeckt) {
  const szene = neuesElement("div", "karte-szene");
  const dreh = neuesElement("div", "karte-dreh");
  const hinten = neuesElement("div", "flaeche hinten");
  const vorne = neuesElement("div", "flaeche vorne");

  const oben = eckeBauen("oben");
  const unten = eckeBauen("unten");
  const mitte = neuesElement("div", "mitte");
  vorne.append(oben.ecke, mitte, unten.ecke);

  dreh.append(hinten, vorne);
  szene.append(dreh);
  if (aufgedeckt) dreh.classList.add("aufgedeckt");

  return { szene, dreh, vorne, oben, unten, mitte };
}

/**
 * Schreibt eine Karte auf die Vorderseite. `daten = null` leert sie.
 * Alles per textContent – dynamische Werte kommen nie in innerHTML.
 */
function karteFuellen(karte, daten) {
  const farbe = daten ? FARBEN[daten.farbe] : null;
  const wertText = daten ? kartenWertText(daten.wert) : "";
  const symbol = farbe ? farbe.symbol : "";

  karte.oben.wert.textContent = wertText;
  karte.oben.symbol.textContent = symbol;
  karte.unten.wert.textContent = wertText;
  karte.unten.symbol.textContent = symbol;
  karte.mitte.textContent = symbol;
  karte.vorne.classList.toggle("rot", Boolean(farbe?.rot));
}

/**
 * Startet eine CSS-Animation (über eine Klasse) garantiert NEU.
 * Problem: Fügt man eine Klasse hinzu, die schon da ist, passiert nichts.
 * Also erst entfernen, dann einen "Reflow" erzwingen (offsetWidth lesen
 * zwingt den Browser, das Layout jetzt zu berechnen und damit die alte
 * Animation zu vergessen) und dann wieder hinzufügen.
 */
function animationNeuStarten(element, klasse) {
  element.classList.remove(klasse);
  void element.offsetWidth;
  element.classList.add(klasse);
}

/** Wartet `ms` Millisekunden – als Promise, damit man "await warte(…)" schreiben kann. */
function warte(ms) {
  return new Promise((fertig) => setTimeout(fertig, ms));
}

/* ============================================================
   TEIL 3: DAS SPIEL IM BROWSER
   ============================================================ */

function starteSpiel() {
  // ----- Elemente einmal suchen und merken -----
  const ketteElement = document.getElementById("hud-kette");
  const rekordElement = document.getElementById("hud-rekord");
  const restElement = document.getElementById("hud-rest");
  const meldungElement = document.getElementById("meldung");
  const deckHinweisElement = document.getElementById("deck-hinweis");
  const stapelElement = document.getElementById("stapel");
  const toplisteElement = document.getElementById("topliste");
  const hochKnopf = document.getElementById("tipp-hoch");
  const tiefKnopf = document.getElementById("tipp-tief");
  const neueRundeKnopf = document.getElementById("neue-runde");

  // Elemente, die nur für Modus-Umschalter und Casino-Modus gebraucht werden
  const modusKnoepfe = [...document.querySelectorAll(".modus-leiste [data-modus]")];
  const gleichKnopf = document.getElementById("tipp-gleich");
  const restCasinoElement = document.getElementById("hud-rest-casino");
  const gewinnElement = document.getElementById("gewinn");
  const chipKnoepfe = [...document.querySelectorAll("#chips .chip")];
  const toplisteTitel = document.getElementById("topliste-titel");
  const resetKnopf = document.getElementById("reset");
  const resetHinweis = document.getElementById("reset-hinweis");
  const tippKnoepfe = { hoch: hochKnopf, tief: tiefKnopf, gleich: gleichKnopf };
  const quoteElemente = {
    hoch: hochKnopf.querySelector(".tipp-quote"),
    tief: tiefKnopf.querySelector(".tipp-quote"),
    gleich: gleichKnopf.querySelector(".tipp-quote"),
  };

  // Beide Karten bauen und einsetzen
  const aktuelleKarte = karteBauen(true);      // links: liegt offen da
  const naechsteKarte = karteBauen(false);     // rechts: verdeckter Stapel
  document.getElementById("halter-aktuell").append(aktuelleKarte.szene);
  document.getElementById("halter-naechste").append(naechsteKarte.szene);
  aktuelleKarte.szene.setAttribute("role", "img");               // für Screenreader als Bild mit Beschriftung
  naechsteKarte.szene.setAttribute("aria-hidden", "true");       // verdeckt = nichts vorzulesen

  // ----- Spielzustand -----
  let deck = [];            // verdeckte Karten; die oberste ist die LETZTE im Array
  let aktuelle = null;      // die offene Karte
  let kette = 0;            // aktuelle Serie richtiger Tipps
  let phase = "wartet";     // "wartet" (Tipp möglich) | "aufdecken" (Animation) | "vorbei" (nur Arcade)
  let modus = modusAusUrl() ?? gespeicherterModus();   // "arcade" | "casino"
  let einsatz = ladeEinsatz();                         // Casino: gewählter Chip
  let quoten = { hoch: null, tief: null, gleich: null }; // Casino: aktuelle Quoten
  let walletHudGebaut = false;                         // das Wallet-HUD wird erst im Casino-Modus aufgebaut

  // ---------------------------------------------------------
  // Anzeigen
  // ---------------------------------------------------------

  /** Meldung unter den Karten; `art` färbt sie (neutral/richtig/gleich/falsch). */
  function meldungSetzen(text, art = "neutral") {
    meldungElement.textContent = text;
    meldungElement.dataset.art = art;
  }

  function restkartenAnzeigen() {
    restElement.textContent = deck.length;
    restCasinoElement.textContent = deck.length;
    // Stapel wird flacher, je weniger Karten übrig sind (reine Optik)
    stapelElement.dataset.schichten = deck.length >= 20 ? "2" : deck.length >= 6 ? "1" : "0";
  }

  function rekordWert() {
    // Die Topliste ist absteigend sortiert → Platz 1 = Rekord-Kette.
    return topliste(SPIEL)[0]?.punkte ?? 0;
  }

  function seiteAktualisieren() {
    if (modus === "casino") {
      // Casino: Topliste zeigt die größten Netto-Gewinne eines Tipps
      toplisteAnzeigen(toplisteElement, SPIEL_CASINO, (p) => `+${p.toLocaleString("de-DE")}`);
      return;
    }
    rekordElement.textContent = rekordWert();
    toplisteAnzeigen(toplisteElement, SPIEL, (p) => `Kette: ${p}`);
  }

  function aktuelleKarteAnzeigen(mitEffekt) {
    karteFuellen(aktuelleKarte, aktuelle);
    aktuelleKarte.szene.setAttribute("aria-label", `Aktuelle Karte: ${kartenName(aktuelle)}`);
    if (mitEffekt) animationNeuStarten(aktuelleKarte.szene, "karte-neu");
  }

  /**
   * Stellt den Stapel zurück auf "verdeckt". Der Flip rückwärts soll NICHT
   * zu sehen sein, darum wird die Transition kurz abgeschaltet
   * (.ohne-uebergang), dann per Reflow "festgeschrieben" und wieder an.
   */
  function stapelZuruecksetzen() {
    naechsteKarte.dreh.classList.add("ohne-uebergang");
    naechsteKarte.dreh.classList.remove("aufgedeckt");
    void naechsteKarte.dreh.offsetWidth;
    naechsteKarte.dreh.classList.remove("ohne-uebergang");

    naechsteKarte.szene.classList.remove("richtig", "gleich", "falsch");
    karteFuellen(naechsteKarte, null);                          // alte Werte nicht im DOM stehen lassen
    animationNeuStarten(naechsteKarte.szene, "austeilen");
  }

  function knoepfeEinstellen() {
    // Modus nicht mitten in einem Tipp wechseln (der Einsatz wäre sonst schon abgebucht)
    for (const knopf of modusKnoepfe) knopf.disabled = phase === "aufdecken";
    if (modus === "casino") {
      casinoKnoepfeEinstellen();
      return;
    }
    const kannTippen = phase === "wartet";
    hochKnopf.disabled = !kannTippen;
    tiefKnopf.disabled = !kannTippen;
    // Nach dem Spielende (z. B. Dialog mit Esc geschlossen) kommt man hier trotzdem weiter
    hochKnopf.hidden = phase === "vorbei";
    tiefKnopf.hidden = phase === "vorbei";
    neueRundeKnopf.hidden = phase !== "vorbei";
  }

  // ---------------------------------------------------------
  // Spielablauf
  // ---------------------------------------------------------

  function neuesSpiel() {
    deck = mischen(neuesDeck());
    aktuelle = deck.pop();                       // erste Karte liegt offen
    kette = 0;
    phase = "wartet";

    aktuelleKarteAnzeigen(true);
    stapelZuruecksetzen();
    zahlHochzaehlen(ketteElement, 0);
    restkartenAnzeigen();
    deckHinweisElement.textContent = "";
    meldungSetzen("Kommt die nächste Karte höher oder tiefer?");
    seiteAktualisieren();
    knoepfeEinstellen();
  }

  /**
   * Ein Tipp. "async" erlaubt es, mit "await warte(…)" Pausen einzubauen,
   * ohne den Browser zu blockieren (die Seite bleibt bedienbar, nur
   * dieser Ablauf "schläft" kurz).
   */
  async function tippen(tipp) {
    if (modus === "casino") return casinoTippen(tipp);
    if (tipp === "gleich") return;               // GLEICH gibt es nur im Casino-Modus
    if (phase !== "wartet") return;              // mitten in der Animation: Eingabe ignorieren
    phase = "aufdecken";
    knoepfeEinstellen();

    // Alte Ergebnis-Effekte entfernen, sonst überschreibt z. B. .austeilen das Schütteln
    naechsteKarte.szene.classList.remove("austeilen", "richtig", "gleich", "falsch");
    deckHinweisElement.textContent = "";

    // 1. Oberste Karte ziehen und auf die Vorderseite schreiben ...
    const gezogen = deck.pop();
    karteFuellen(naechsteKarte, gezogen);
    restkartenAnzeigen();
    // 2. ... und umdrehen: Die Klasse startet die CSS-3D-Transition
    naechsteKarte.dreh.classList.add("aufgedeckt");
    await warte(bewegungReduziert() ? 0 : FLIP_MS);

    // 3. Bewerten
    const ausgang = tippBewerten(aktuelle.wert, gezogen.wert, tipp);
    const name = kartenName(gezogen);

    if (ausgang === "falsch") {
      phase = "vorbei";
      naechsteKarte.szene.classList.add("falsch");               // roter Blitz + Schütteln
      meldungSetzen(`Falsch! Die Karte war ${name}.`, "falsch");
      knoepfeEinstellen();
      await warte(bewegungReduziert() ? 400 : PAUSE_MS);

      const dialog = gameOverDialog({
        spiel: SPIEL,
        punkte: kette,
        punkteText: `Kette: ${kette}`,
        richtung: "hoch",
        format: (p) => `Kette: ${p}`,   // Topliste im Dialog hübsch anzeigen
        neustart: neuesSpiel,
      });
      // Topliste + Rekord neu zeigen, sobald der Dialog zu ist (evtl. gab es einen Eintrag)
      dialog.addEventListener("close", seiteAktualisieren);
      return;
    }

    if (ausgang === "richtig") {
      kette++;
      zahlHochzaehlen(ketteElement, kette, 250);
      naechsteKarte.szene.classList.add("richtig");
      meldungSetzen(`Richtig! Es war ${name}.`, "richtig");
    } else {
      naechsteKarte.szene.classList.add("gleich");
      meldungSetzen(`Unentschieden: ${name} hat denselben Wert. Die Kette bleibt.`, "gleich");
    }
    await warte(bewegungReduziert() ? 400 : PAUSE_MS);

    // 4. Weiter: Die aufgedeckte Karte wird zur aktuellen
    aktuelle = gezogen;
    if (deck.length === 0) {
      // Deck leer → frisch mischen. Die offene Karte bleibt draußen,
      // sonst gäbe es sie doppelt auf dem Tisch.
      deck = mischen(neuesDeck(aktuelle));
      deckHinweisElement.textContent = `Das Deck war leer – neu gemischt (${deck.length} Karten).`;
      animationNeuStarten(deckHinweisElement, "einblenden");
    }
    aktuelleKarteAnzeigen(true);
    stapelZuruecksetzen();
    restkartenAnzeigen();
    meldungSetzen("Höher oder tiefer?");
    phase = "wartet";
    knoepfeEinstellen();
  }

  // ---------------------------------------------------------
  // Casino-Modus
  // ---------------------------------------------------------

  /** Gespeicherten Chip laden – nur erlaubte Werte, sonst 50. */
  function ladeEinsatz() {
    const gespeichert = lade(SPIEL_CASINO, "einsatz", 50);
    return CHIPS.includes(gespeichert) ? gespeichert : 50;
  }

  /** Neues Casino-Spiel: Deck mischen, erste Karte offen, Quoten berechnen. */
  function casinoStart() {
    if (!walletHudGebaut) {
      walletHud(document.getElementById("wallet-hud"));
      walletHudGebaut = true;
    } else {
      walletHudAktualisieren(false);
    }
    deck = mischen(neuesDeck());
    aktuelle = deck.pop();
    phase = "wartet";
    einsatz = ladeEinsatz();
    einsatzAnpassen();

    aktuelleKarteAnzeigen(true);
    stapelZuruecksetzen();
    restkartenAnzeigen();
    deckHinweisElement.textContent = "";
    gewinnSetzen(null);
    quotenAktualisieren();
    meldungSetzen("Wähle einen Einsatz und tippe: HOCH, TIEF oder GLEICH?");
    seiteAktualisieren();
    knoepfeEinstellen();
    if (istPleite(MINDESTEINSATZ)) pleiteDialogZeigen();
  }

  /** Ist der gewählte Chip teurer als das Konto, wird der größte bezahlbare gewählt. */
  function einsatzAnpassen() {
    const stand = kontostand();
    if (einsatz > stand) {
      einsatz = [...CHIPS].reverse().find((c) => c <= stand) ?? MINDESTEINSATZ;
    }
  }

  function einsatzWaehlen(wert) {
    einsatz = wert;
    einsatzAnpassen();
    speichere(SPIEL_CASINO, "einsatz", einsatz);
    knoepfeEinstellen();
  }

  /** "+75" / "−50" über den Tipp-Knöpfen; null leert die Anzeige. */
  function gewinnSetzen(netto) {
    gewinnElement.className = "gewinn-anzeige";
    if (netto === null) {
      gewinnElement.textContent = "";
    } else if (netto > 0) {
      gewinnElement.textContent = `+${netto.toLocaleString("de-DE")}`;
      gewinnElement.classList.add("plus");
      if (!bewegungReduziert()) gewinnElement.classList.add("blitz");
    } else {
      gewinnElement.textContent = `−${(-netto).toLocaleString("de-DE")}`;   // echtes Minuszeichen (U+2212)
      gewinnElement.classList.add("minus");
    }
  }

  /** Quoten aus dem Restdeck berechnen und auf die Knöpfe schreiben. */
  function quotenAktualisieren() {
    quoten = quotenFuerDeck(deck, aktuelle.wert);
    for (const tipp of Object.keys(quoten)) {
      const q = quoten[tipp];
      quoteElemente[tipp].textContent = q === null ? "nicht möglich" : `×${quoteText(q)}`;
    }
  }

  function casinoKnoepfeEinstellen() {
    const stand = kontostand();
    const bereit = phase === "wartet";
    for (const knopf of chipKnoepfe) {
      const wert = Number(knopf.dataset.wert);
      knopf.disabled = !bereit || wert > stand;
      knopf.setAttribute("aria-pressed", String(wert === einsatz));
    }
    // Ein Tipp ist gesperrt, wenn es keine Treffer-Karte mehr gibt (Quote null)
    for (const [tipp, knopf] of Object.entries(tippKnoepfe)) {
      knopf.hidden = false;
      knopf.disabled = !bereit || quoten[tipp] === null || einsatz > stand;
    }
    neueRundeKnopf.hidden = true;
  }

  /**
   * Ein Casino-Tipp. Ablauf: Einsatz abbuchen → Karte ziehen und aufdecken →
   * bewerten → Auszahlung gutschreiben → nächste Karte wird zur offenen Karte.
   */
  async function casinoTippen(tipp) {
    if (phase !== "wartet") return;
    const quote = quoten[tipp];                  // die Quote gilt zum Zeitpunkt des Tipps
    if (quote === null) return;                  // unmöglicher Tipp
    if (!einsatzAbbuchen(einsatz)) {
      meldungSetzen("Dafür reicht dein Spielgeld nicht. Wähle einen kleineren Einsatz.", "falsch");
      einsatzAnpassen();
      knoepfeEinstellen();
      return;
    }
    const gesetzt = einsatz;
    phase = "aufdecken";
    walletHudAktualisieren();                    // der Einsatz verlässt sichtbar das Konto
    gewinnSetzen(null);
    knoepfeEinstellen();
    naechsteKarte.szene.classList.remove("austeilen", "richtig", "gleich", "falsch");
    deckHinweisElement.textContent = "";

    // Karte ziehen und mit der vorhandenen 3D-Flip-Animation aufdecken
    const gezogen = deck.pop();
    karteFuellen(naechsteKarte, gezogen);
    restkartenAnzeigen();
    naechsteKarte.dreh.classList.add("aufgedeckt");
    await warte(bewegungReduziert() ? 0 : FLIP_MS);

    // Bewerten und Geld verbuchen
    const treffer = casinoTippTrifft(aktuelle.wert, gezogen.wert, tipp);
    const auszahlung = treffer ? auszahlungBerechnen(gesetzt, quote) : 0;
    rundeAbschliessen(gesetzt, auszahlung);
    walletHudAktualisieren();
    const netto = auszahlung - gesetzt;
    const name = kartenName(gezogen);
    const tippName = tipp.toUpperCase();

    gewinnSetzen(netto);
    if (treffer) {
      naechsteKarte.szene.classList.add("richtig");
      meldungSetzen(`Treffer! ${name}. ${tippName} zahlt ×${quoteText(quote)}.`, "richtig");
    } else {
      naechsteKarte.szene.classList.add("falsch");
      if (gezogen.wert === aktuelle.wert) {
        meldungSetzen(`Gleicher Wert (${name}): ${tippName} verliert. Dafür gibt es GLEICH.`, "falsch");
      } else {
        meldungSetzen(`Daneben! Die Karte war ${name}.`, "falsch");
      }
    }
    await warte(bewegungReduziert() ? 400 : PAUSE_MS);

    // Weiter: Die aufgedeckte Karte wird zur offenen Karte
    aktuelle = gezogen;
    if (deck.length === 0) {
      deck = mischen(neuesDeck(aktuelle));
      deckHinweisElement.textContent = `Das Deck war leer – neu gemischt (${deck.length} Karten).`;
      animationNeuStarten(deckHinweisElement, "einblenden");
    }
    aktuelleKarteAnzeigen(true);
    stapelZuruecksetzen();
    restkartenAnzeigen();
    quotenAktualisieren();
    meldungSetzen("Nächster Tipp: HOCH, TIEF oder GLEICH?");
    phase = "wartet";
    einsatzAnpassen();
    knoepfeEinstellen();

    // Top-3-Gewinn? STILL eintragen und nur die Seiten-Topliste
    // auffrischen – kein Dialog, keine Aufforderung mitten im Spiel.
    if (netto > 0 && stillEintragen(SPIEL_CASINO, netto) !== null) {
      seiteAktualisieren();
    }
    if (istPleite(MINDESTEINSATZ)) {
      pleiteDialogZeigen();
    }
  }

  /** "Pleite! Neues Startgeld." – lässt sich nur per Knopf schließen. */
  function pleiteDialogZeigen() {
    if (document.getElementById("pleite-dialog")) return;
    const dialog = document.createElement("dialog");
    dialog.className = "spiel-dialog";
    dialog.id = "pleite-dialog";
    // Nur feste Texte im HTML; die Zahl kommt per textContent
    dialog.innerHTML = `
      <h2>Pleite!</h2>
      <p>Dein Spielgeld ist aufgebraucht. Du bekommst neues Startgeld:</p>
      <p class="gross"></p>
      <div class="aktionen">
        <button class="knopf primaer" data-rolle="neu">Neues Startgeld</button>
        
      </div>`;
    dialog.querySelector(".gross").textContent = STARTGELD.toLocaleString("de-DE");
    dialog.querySelector('[data-rolle="neu"]').addEventListener("click", () => {
      pleiteNeustart();
      walletHudAktualisieren();
      dialog.close();
      dialog.remove();
      einsatzAnpassen();
      knoepfeEinstellen();
      meldungSetzen("Neues Startgeld ist da. Viel Glück!");
    });
    // Esc würde den Dialog ohne Neustart schließen → verhindern
    dialog.addEventListener("cancel", (e) => e.preventDefault());
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector("button")?.focus();
  }

  // ---------------------------------------------------------
  // Modus-Umschalter
  // ---------------------------------------------------------

  /**
   * Zeigt nur die Bereiche des aktuellen Modus. Elemente mit data-nur="casino"
   * oder data-nur="arcade" im HTML werden hier per hidden ein- und ausgeblendet.
   */
  function modusAnwenden() {
    for (const el of document.querySelectorAll("[data-nur]")) {
      el.hidden = el.dataset.nur !== modus;
    }
    for (const knopf of modusKnoepfe) {
      knopf.setAttribute("aria-pressed", String(knopf.dataset.modus === modus));
    }
    const casino = modus === "casino";
    toplisteTitel.textContent = casino ? "Größte Gewinne · Top 3" : "Lokale Top 3 · Längste Ketten";
    resetKnopf.textContent = casino ? "Topliste zurücksetzen" : "Spielstand zurücksetzen";
    resetHinweis.hidden = !casino;
  }

  function modusWechseln(neuerModus) {
    if (neuerModus === modus || phase === "aufdecken") return;
    modus = neuerModus;
    speichere(SPIEL, "modus", modus);
    urlAktualisieren(modus);
    modusAnwenden();
    if (modus === "casino") {
      casinoStart();
    } else {
      for (const element of Object.values(quoteElemente)) element.textContent = "";
      gewinnSetzen(null);
      neuesSpiel();
    }
  }

  // ---------------------------------------------------------
  // Eingabe
  // ---------------------------------------------------------
  hochKnopf.addEventListener("click", () => tippen("hoch"));
  tiefKnopf.addEventListener("click", () => tippen("tief"));
  gleichKnopf.addEventListener("click", () => tippen("gleich"));
  neueRundeKnopf.addEventListener("click", neuesSpiel);
  for (const knopf of modusKnoepfe) {
    knopf.addEventListener("click", () => modusWechseln(knopf.dataset.modus));
  }
  for (const knopf of chipKnoepfe) {
    knopf.addEventListener("click", () => einsatzWaehlen(Number(knopf.dataset.wert)));
  }

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;            // Browser-Kürzel nicht stören
    if (document.querySelector("dialog[open]")) return;        // Dialog offen → Tasten gehören ihm
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    const taste = e.key?.toLowerCase();
    if (taste === "arrowup" || taste === "w") {
      e.preventDefault();                                      // Seite nicht scrollen
      tippen("hoch");
    } else if (taste === "arrowdown" || taste === "s") {
      e.preventDefault();
      tippen("tief");
    } else if (taste === "g" && modus === "casino") {
      tippen("gleich");
    }
  });

  resetKnopf.addEventListener("click", () => {
    if (modus === "casino") {
      spielZuruecksetzen(SPIEL_CASINO);  // löscht Casino-Topliste + gespeicherten Chip (NICHT das Spielgeld)
      speichere(SPIEL_CASINO, "einsatz", einsatz);
    } else {
      spielZuruecksetzen(SPIEL);         // löscht die Arcade-Topliste (und den gemerkten Modus)
      speichere(SPIEL, "modus", modus);
    }
    seiteAktualisieren();                // leere Topliste + Rekord 0 anzeigen; die laufende Runde geht weiter
  });

  // ----- Start -----
  modusAnwenden();
  if (modus === "casino") casinoStart();
  else neuesSpiel();
}

/* ------------------------------------------------------------
   Modus aus URL oder Speicher (außerhalb von starteSpiel, weil
   sie keinen Spielzustand brauchen)
   ------------------------------------------------------------ */

/** ?modus=casino in der URL wählt den Modus vor (für Links vom Hub). */
function modusAusUrl() {
  try {
    const wunsch = new URLSearchParams(window.location.search).get("modus");
    return MODI.includes(wunsch) ? wunsch : null;
  } catch {
    return null;
  }
}

function gespeicherterModus() {
  const gespeichert = lade(SPIEL, "modus", "arcade");
  return MODI.includes(gespeichert) ? gespeichert : "arcade";
}

/** Hält die Adresszeile zum Modus passend, damit ein Neuladen im selben Modus landet. */
function urlAktualisieren(modus) {
  try {
    const url = new URL(window.location.href);
    if (modus === "casino") url.searchParams.set("modus", "casino");
    else url.searchParams.delete("modus");
    window.history.replaceState(null, "", url);
  } catch { /* bewusst ignoriert */ }
}

// Nur im Browser starten. In Node (Tests) gibt es kein "document" –
// dort werden nur die reinen Funktionen oben importiert.
if (typeof document !== "undefined") {
  starteSpiel();
}
