import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { addDocumentResponseHeaders } from "./shopify.server";
import { startScheduler } from "./services/scheduler.server";

// In-process cron (outbox retries, balance reminders, GDPR purge) — Railway
// runs this web service 24/7, so it schedules its own idempotent jobs.
startScheduler();

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  // Always send the fully rendered document (2026-10-11). With onShellReady,
  // a slow first byte (e.g. through the Cloudflare proxy) made React stream a
  // pending boundary after </html>; its $RC fix-up then printed a stray "$" on
  // every page. The app has no deferred data, so waiting costs nothing.
  const callbackName = "onAllReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
