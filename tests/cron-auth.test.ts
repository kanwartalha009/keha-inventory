/** /cron/* auth: bearer header only, constant-time compare, off without a secret. */
import { describe, expect, it } from "vitest";
import { cronAuthorized } from "../app/lib/cron-auth.server";

const req = (headers: Record<string, string> = {}, url = "https://x.test/cron/nova-outbox") => new Request(url, { headers });

describe("cron auth", () => {
  it("accepts the right bearer token only", () => {
    expect(cronAuthorized(req({ Authorization: "Bearer s3cret" }), "s3cret")).toBe(true);
    expect(cronAuthorized(req({ Authorization: "Bearer wrong!" }), "s3cret")).toBe(false);
    expect(cronAuthorized(req({ Authorization: "Bearer s3cre" }), "s3cret")).toBe(false);
  });
  it("ignores a token in the query string", () => {
    expect(cronAuthorized(req({}, "https://x.test/cron/nova-outbox?token=s3cret"), "s3cret")).toBe(false);
  });
  it("is off when no secret is configured", () => {
    expect(cronAuthorized(req({ Authorization: "Bearer " }), "")).toBe(false);
  });
});
