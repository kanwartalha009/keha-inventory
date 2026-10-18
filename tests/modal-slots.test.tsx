import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Modal } from "../app/components/wc";

// Live check 2026-10-18: in the embedded admin, App Bridge draws <s-modal> outside the iframe and only
// keeps <s-button> elements that carry `slot` themselves; buttons inside <s-box slot=…> were dropped.
describe("Modal action slots", () => {
  it("puts slot on the buttons themselves, never on a wrapper", () => {
    const html = renderToStaticMarkup(
      <Modal
        open
        onClose={() => {}}
        heading="Explore with sample data?"
        primaryAction={<s-button variant="primary">Load sample data</s-button>}
        secondaryActions={
          <>
            <s-button>Copy message</s-button>
            {false}
            <s-button>Cancel</s-button>
          </>
        }
      >
        <s-paragraph>Body</s-paragraph>
      </Modal>,
    );
    expect(html).toContain('<s-button variant="primary" slot="primary-action">Load sample data</s-button>');
    expect(html.match(/<s-button slot="secondary-actions">/g)?.length).toBe(2);
    expect(html).not.toContain("<s-box");
  });
  it("renders no action slot when there is none", () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}} heading="Why this action">
        <s-paragraph>Body</s-paragraph>
      </Modal>,
    );
    expect(html).not.toContain("slot=");
  });
});
