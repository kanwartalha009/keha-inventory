/**
 * Translations shared across the app: navigation, generic buttons, Home and
 * Settings. English text is the key (see app/lib/i18n.tsx).
 */
import type { Tr } from "./i18n";

export const COMMON_TR: Record<string, Tr> = {
  // ---- Navigation ----
  "Home": { es: "Inicio", fr: "Accueil", de: "Start", it: "Home", pt: "Início", nl: "Home", pl: "Start" },
  "Settings": { es: "Ajustes", fr: "Paramètres", de: "Einstellungen", it: "Impostazioni", pt: "Definições", nl: "Instellingen", pl: "Ustawienia" },
  "Plans": { es: "Planes", fr: "Forfaits", de: "Tarife", it: "Piani", pt: "Planos", nl: "Abonnementen", pl: "Plany" },

  // ---- Generic ----
  "Cancel": { es: "Cancelar", fr: "Annuler", de: "Abbrechen", it: "Annulla", pt: "Cancelar", nl: "Annuleren", pl: "Anuluj" },
  "Try again": { es: "Inténtalo de nuevo", fr: "Réessayer", de: "Erneut versuchen", it: "Riprova", pt: "Tentar novamente", nl: "Opnieuw proberen", pl: "Spróbuj ponownie" },
  "This is usually a brief connection hiccup — your store and settings are unaffected. Try again in a moment.": { es: "Suele ser un fallo de conexión breve: tu tienda y tus ajustes no se ven afectados. Inténtalo de nuevo en un momento.", fr: "Il s'agit généralement d'un bref souci de connexion — votre boutique et vos paramètres ne sont pas affectés. Réessayez dans un instant.", de: "Meist ist das ein kurzer Verbindungsfehler – dein Shop und deine Einstellungen sind nicht betroffen. Versuche es gleich noch einmal.", it: "Di solito è un breve problema di connessione — il tuo negozio e le impostazioni non sono interessati. Riprova tra un momento.", pt: "Normalmente é uma falha breve de ligação — a sua loja e definições não são afetadas. Tente novamente daqui a pouco.", nl: "Meestal is dit een korte verbindingsstoring — je winkel en instellingen blijven ongemoeid. Probeer het zo opnieuw.", pl: "To zwykle chwilowy problem z połączeniem — sklep i ustawienia pozostają nienaruszone. Spróbuj ponownie za chwilę." },

  // ---- Home ----
  "Reading your store…": { es: "Leyendo tu tienda…", fr: "Lecture de votre boutique…", de: "Dein Shop wird gelesen …", it: "Lettura del tuo negozio…", pt: "A ler a sua loja…", nl: "Je winkel wordt gelezen…", pl: "Odczytujemy Twój sklep…" },
  "Your money-at-stake numbers and this week's actions will appear here once your products, stock and sales are read.": { es: "Tu dinero en juego y las acciones de esta semana aparecerán aquí en cuanto leamos tus productos, tu stock y tus ventas.", fr: "Votre argent en jeu et les actions de la semaine s'afficheront ici dès que vos produits, votre stock et vos ventes auront été lus.", de: "Dein Geld im Spiel und die Aufgaben dieser Woche erscheinen hier, sobald deine Produkte, dein Bestand und deine Verkäufe gelesen sind.", it: "I tuoi soldi in gioco e le azioni di questa settimana appariranno qui appena avremo letto prodotti, stock e vendite.", pt: "O seu dinheiro em jogo e as ações desta semana aparecem aqui assim que lermos os seus produtos, stock e vendas.", nl: "Je geld op het spel en de acties van deze week verschijnen hier zodra je producten, voorraad en verkopen zijn gelezen.", pl: "Twoje pieniądze na szali i działania na ten tydzień pojawią się tutaj, gdy odczytamy Twoje produkty, stany i sprzedaż." },

  // ---- Settings ----
  "Language": { es: "Idioma", fr: "Langue", de: "Sprache", it: "Lingua", pt: "Idioma", nl: "Taal", pl: "Język" },
  "App language": { es: "Idioma de la aplicación", fr: "Langue de l'application", de: "App-Sprache", it: "Lingua dell'app", pt: "Idioma da aplicação", nl: "App-taal", pl: "Język aplikacji" },
  "Only changes the app for you in this browser. Emails use your store's language.": { es: "Solo cambia la app para ti en este navegador. Los emails usan el idioma de tu tienda.", fr: "Ne change l'application que pour vous, dans ce navigateur. Les e-mails utilisent la langue de votre boutique.", de: "Ändert die App nur für dich in diesem Browser. E-Mails verwenden die Sprache deines Shops.", it: "Cambia l'app solo per te in questo browser. Le email usano la lingua del tuo negozio.", pt: "Só altera a app para si neste navegador. Os emails usam o idioma da sua loja.", nl: "Wijzigt de app alleen voor jou in deze browser. E-mails gebruiken de taal van je winkel.", pl: "Zmienia aplikację tylko dla Ciebie w tej przeglądarce. E-maile używają języka Twojego sklepu." },
};
