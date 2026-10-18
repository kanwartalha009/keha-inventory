/**
 * Settings → Alerts translations (spec §5.5, §11, task 2.6): instant alerts and
 * Slack. The Monday email fields reuse the Settings strings in i18n-common.
 * English text is the key (see app/lib/i18n.tsx). Tone: tú (es), vous (fr),
 * du (de), tu (it), European Portuguese, je (nl), informal Polish.
 */
import type { Tr } from "./i18n";

export const ALERTS_TR: Record<string, Tr> = {
  // ---- Instant alerts ----
  "Instant alerts": { es: "Alertas inmediatas", fr: "Alertes instantanées", de: "Sofortbenachrichtigungen", it: "Avvisi immediati", pt: "Alertas imediatos", nl: "Directe meldingen", pl: "Natychmiastowe alerty" },
  "Send instant alerts": { es: "Enviar alertas inmediatas", fr: "Envoyer des alertes instantanées", de: "Sofortbenachrichtigungen senden", it: "Invia avvisi immediati", pt: "Enviar alertas imediatos", nl: "Directe meldingen sturen", pl: "Wysyłaj natychmiastowe alerty" },
  // Section description (one sentence) and the checkbox details, split from one long text (2026-10-17).
  "When a best seller will run out before new stock can arrive, or a busy product sells out.": {
    es: "Cuando un producto estrella se vaya a agotar antes de que pueda llegar stock nuevo, o se agote un producto con muchas visitas.",
    fr: "Quand un best-seller va être en rupture avant l'arrivée du nouveau stock, ou qu'un produit très visité est épuisé.",
    de: "Wenn ein Bestseller ausverkauft sein wird, bevor neue Ware ankommen kann, oder ein viel besuchtes Produkt ausverkauft ist.",
    it: "Quando un best seller finirà prima che possa arrivare nuovo stock, o un prodotto molto visitato va esaurito.",
    pt: "Quando um best-seller vai esgotar antes de poder chegar stock novo, ou um produto muito visitado esgota.",
    nl: "Als een bestseller op raakt voordat er nieuwe voorraad kan zijn, of een veelbezocht product uitverkocht raakt.",
    pl: "Gdy bestseller skończy się, zanim zdąży dotrzeć nowy towar, albo wyprzeda się często odwiedzany produkt.",
  },
  "By email to the addresses above, and to Slack when it's connected. At most once per product per week.": {
    es: "Por email a las direcciones de arriba, y a Slack si está conectado. Como máximo una vez por producto y semana.",
    fr: "Par e-mail aux adresses ci-dessus, et sur Slack s'il est connecté. Au plus une fois par produit et par semaine.",
    de: "Per E-Mail an die Adressen oben und in Slack, wenn es verbunden ist. Höchstens einmal pro Produkt und Woche.",
    it: "Via email agli indirizzi sopra e su Slack se è collegato. Al massimo una volta per prodotto a settimana.",
    pt: "Por email para os endereços acima e para o Slack, se estiver ligado. No máximo uma vez por produto por semana.",
    nl: "Per e-mail naar de adressen hierboven, en naar Slack als het gekoppeld is. Hooguit één keer per product per week.",
    pl: "E-mailem na adresy powyżej oraz na Slacka, jeśli jest połączony. Najwyżej raz na produkt w tygodniu.",
  },

  // ---- Slack ----
  "Slack webhook URL": { es: "URL del webhook de Slack", fr: "URL du webhook Slack", de: "Slack-Webhook-URL", it: "URL del webhook di Slack", pt: "URL do webhook do Slack", nl: "Slack-webhook-URL", pl: "URL webhooka Slack" },
  "In Slack, add an incoming webhook for the channel you want, then paste its link here and save. We store it encrypted.": {
    es: "En Slack, añade un webhook entrante para el canal que quieras, pega aquí su enlace y guarda. Lo guardamos cifrado.",
    fr: "Dans Slack, ajoutez un webhook entrant pour le canal souhaité, puis collez son lien ici et enregistrez. Nous le stockons chiffré.",
    de: "Lege in Slack einen eingehenden Webhook für den gewünschten Kanal an, füge den Link hier ein und speichere. Wir speichern ihn verschlüsselt.",
    it: "In Slack, aggiungi un webhook in entrata per il canale che vuoi, poi incolla qui il link e salva. Lo conserviamo cifrato.",
    pt: "No Slack, adicione um webhook de entrada para o canal que quiser, cole aqui a ligação e guarde. Guardamo-la encriptada.",
    nl: "Voeg in Slack een inkomende webhook toe voor het kanaal dat je wilt, plak de link hier en sla op. We bewaren hem versleuteld.",
    pl: "W Slacku dodaj przychodzący webhook dla wybranego kanału, wklej tu jego link i zapisz. Przechowujemy go zaszyfrowany.",
  },
  "Secure storage isn't set up for this app yet, so this can't be saved. Contact Keha support.": {
    es: "El almacenamiento seguro aún no está configurado en esta app, así que esto no se puede guardar. Contacta con el soporte de Keha.",
    fr: "Le stockage sécurisé n'est pas encore configuré pour cette application, cela ne peut donc pas être enregistré. Contactez le support Keha.",
    de: "Der sichere Speicher ist für diese App noch nicht eingerichtet, daher kann das nicht gespeichert werden. Wende dich an den Keha-Support.",
    it: "L'archiviazione sicura non è ancora configurata per questa app, quindi non è possibile salvare. Contatta l'assistenza Keha.",
    pt: "O armazenamento seguro ainda não está configurado nesta app, por isso não é possível guardar. Contacte o suporte da Keha.",
    nl: "Veilige opslag is nog niet ingesteld voor deze app, dus dit kan niet worden opgeslagen. Neem contact op met Keha-support.",
    pl: "Bezpieczne przechowywanie nie jest jeszcze skonfigurowane w tej aplikacji, więc nie można tego zapisać. Skontaktuj się z pomocą Keha.",
  },
  "Paste a Slack incoming webhook URL. It starts with https://hooks.slack.com/services/": { es: "Pega la URL de un webhook entrante de Slack. Empieza por https://hooks.slack.com/services/", fr: "Collez l'URL d'un webhook entrant Slack. Elle commence par https://hooks.slack.com/services/", de: "Füge die URL eines eingehenden Slack-Webhooks ein. Sie beginnt mit https://hooks.slack.com/services/", it: "Incolla l'URL di un webhook in entrata di Slack. Inizia con https://hooks.slack.com/services/", pt: "Cole o URL de um webhook de entrada do Slack. Começa por https://hooks.slack.com/services/", nl: "Plak de URL van een inkomende Slack-webhook. Die begint met https://hooks.slack.com/services/", pl: "Wklej URL przychodzącego webhooka Slack. Zaczyna się od https://hooks.slack.com/services/" },
  "Connected": { es: "Conectado", fr: "Connecté", de: "Verbunden", it: "Collegato", pt: "Ligado", nl: "Gekoppeld", pl: "Połączono" },
  "Not working": { es: "No funciona", fr: "Ne fonctionne pas", de: "Funktioniert nicht", it: "Non funziona", pt: "Não funciona", nl: "Werkt niet", pl: "Nie działa" },
  "Send a test message": { es: "Enviar un mensaje de prueba", fr: "Envoyer un message de test", de: "Testnachricht senden", it: "Invia un messaggio di prova", pt: "Enviar uma mensagem de teste", nl: "Testbericht sturen", pl: "Wyślij wiadomość testową" },
  "Disconnect": { es: "Desconectar", fr: "Déconnecter", de: "Trennen", it: "Scollega", pt: "Desligar", nl: "Ontkoppelen", pl: "Rozłącz" },
  "Send the weekly summary to Slack": { es: "Enviar el resumen semanal a Slack", fr: "Envoyer le résumé hebdomadaire sur Slack", de: "Wochenübersicht an Slack senden", it: "Invia il riepilogo settimanale su Slack", pt: "Enviar o resumo semanal para o Slack", nl: "Weekoverzicht naar Slack sturen", pl: "Wysyłaj podsumowanie tygodnia na Slacka" },
  "The same numbers and top actions as the email, shorter.": { es: "Las mismas cifras y acciones principales que el email, más breve.", fr: "Les mêmes chiffres et actions prioritaires que l'e-mail, en plus court.", de: "Dieselben Zahlen und wichtigsten Aufgaben wie in der E-Mail, nur kürzer.", it: "Gli stessi numeri e le azioni principali dell'email, più in breve.", pt: "Os mesmos números e ações principais do email, mais curto.", nl: "Dezelfde cijfers en belangrijkste acties als in de e-mail, korter.", pl: "Te same liczby i najważniejsze działania co w e-mailu, w skrócie." },
  "Test message sent. Check your Slack channel.": { es: "Mensaje de prueba enviado. Revisa tu canal de Slack.", fr: "Message de test envoyé. Vérifiez votre canal Slack.", de: "Testnachricht gesendet. Sieh in deinem Slack-Kanal nach.", it: "Messaggio di prova inviato. Controlla il tuo canale Slack.", pt: "Mensagem de teste enviada. Veja o seu canal do Slack.", nl: "Testbericht verstuurd. Kijk in je Slack-kanaal.", pl: "Wiadomość testowa wysłana. Sprawdź swój kanał w Slacku." },
  "Slack is disconnected.": { es: "Slack está desconectado.", fr: "Slack est déconnecté.", de: "Slack ist getrennt.", it: "Slack è scollegato.", pt: "O Slack está desligado.", nl: "Slack is ontkoppeld.", pl: "Slack został rozłączony." },
  "Slack didn't answer. Try again in a minute.": { es: "Slack no ha respondido. Inténtalo de nuevo en un minuto.", fr: "Slack n'a pas répondu. Réessayez dans une minute.", de: "Slack hat nicht geantwortet. Versuche es in einer Minute erneut.", it: "Slack non ha risposto. Riprova tra un minuto.", pt: "O Slack não respondeu. Tente novamente daqui a um minuto.", nl: "Slack gaf geen antwoord. Probeer het over een minuut opnieuw.", pl: "Slack nie odpowiedział. Spróbuj ponownie za minutę." },
  "Slack stopped accepting our messages": { es: "Slack ha dejado de aceptar nuestros mensajes", fr: "Slack n'accepte plus nos messages", de: "Slack nimmt unsere Nachrichten nicht mehr an", it: "Slack non accetta più i nostri messaggi", pt: "O Slack deixou de aceitar as nossas mensagens", nl: "Slack neemt onze berichten niet meer aan", pl: "Slack przestał przyjmować nasze wiadomości" },
  "Slack no longer accepts this webhook URL. Create a new incoming webhook in Slack and connect it again.": { es: "Slack ya no acepta esta URL de webhook. Crea un nuevo webhook entrante en Slack y vuelve a conectarlo.", fr: "Slack n'accepte plus cette URL de webhook. Créez un nouveau webhook entrant dans Slack et reconnectez-le.", de: "Slack nimmt diese Webhook-URL nicht mehr an. Lege in Slack einen neuen eingehenden Webhook an und verbinde ihn erneut.", it: "Slack non accetta più questo URL del webhook. Crea un nuovo webhook in entrata in Slack e collegalo di nuovo.", pt: "O Slack já não aceita este URL de webhook. Crie um novo webhook de entrada no Slack e ligue-o novamente.", nl: "Slack accepteert deze webhook-URL niet meer. Maak in Slack een nieuwe inkomende webhook en koppel die opnieuw.", pl: "Slack nie akceptuje już tego URL webhooka. Utwórz nowy przychodzący webhook w Slacku i połącz go ponownie." },
  "Slack can't post to the channel this link belongs to. It may have been deleted or archived. Create a webhook for another channel.": {
    es: "Slack no puede publicar en el canal de este enlace. Puede que se haya eliminado o archivado. Crea un webhook para otro canal.",
    fr: "Slack ne peut pas publier dans le canal de ce lien. Il a peut-être été supprimé ou archivé. Créez un webhook pour un autre canal.",
    de: "Slack kann nicht in den Kanal dieses Links posten. Er wurde vielleicht gelöscht oder archiviert. Lege einen Webhook für einen anderen Kanal an.",
    it: "Slack non può pubblicare nel canale di questo link. Potrebbe essere stato eliminato o archiviato. Crea un webhook per un altro canale.",
    pt: "O Slack não consegue publicar no canal desta ligação. Pode ter sido eliminado ou arquivado. Crie um webhook para outro canal.",
    nl: "Slack kan niet posten in het kanaal van deze link. Misschien is het verwijderd of gearchiveerd. Maak een webhook voor een ander kanaal.",
    pl: "Slack nie może publikować na kanale tego linku. Mógł zostać usunięty lub zarchiwizowany. Utwórz webhook dla innego kanału.",
  },
  "We can't read the saved link any more. Disconnect and connect Slack again.": {
    es: "Ya no podemos leer el enlace guardado. Desconecta y vuelve a conectar Slack.",
    fr: "Nous ne pouvons plus lire le lien enregistré. Déconnectez puis reconnectez Slack.",
    de: "Wir können den gespeicherten Link nicht mehr lesen. Trenne Slack und verbinde es erneut.",
    it: "Non riusciamo più a leggere il link salvato. Scollega e ricollega Slack.",
    pt: "Já não conseguimos ler a ligação guardada. Desligue e volte a ligar o Slack.",
    nl: "We kunnen de opgeslagen link niet meer lezen. Ontkoppel Slack en koppel het opnieuw.",
    pl: "Nie możemy już odczytać zapisanego linku. Rozłącz i połącz Slacka ponownie.",
  },
  "Slack refused the last message. Send a test message, or connect Slack again.": {
    es: "Slack rechazó el último mensaje. Envía un mensaje de prueba o vuelve a conectar Slack.",
    fr: "Slack a refusé le dernier message. Envoyez un message de test ou reconnectez Slack.",
    de: "Slack hat die letzte Nachricht abgelehnt. Sende eine Testnachricht oder verbinde Slack erneut.",
    it: "Slack ha rifiutato l'ultimo messaggio. Invia un messaggio di prova o ricollega Slack.",
    pt: "O Slack recusou a última mensagem. Envie uma mensagem de teste ou volte a ligar o Slack.",
    nl: "Slack heeft het laatste bericht geweigerd. Stuur een testbericht of koppel Slack opnieuw.",
    pl: "Slack odrzucił ostatnią wiadomość. Wyślij wiadomość testową albo połącz Slacka ponownie.",
  },
};
