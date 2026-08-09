import { describe, expect, it } from "vitest";
import type { SharePhoto } from "@/services/share-page";
import { buildSharePageHtml } from "@/services/share-page";

describe("share page HTML security", () => {
  it("keeps photo metadata from terminating the inline script", () => {
    const malicious = "</script><script>window.pwned=1</script>";
    const photo: SharePhoto = {
      aperture: "",
      camera: malicious,
      dateTaken: "",
      filename: malicious,
      focalLength: "",
      height: 1,
      iso: "",
      lens: "",
      shutter: "",
      tags: [malicious],
      thumbnailBase64: "",
      width: 1,
    };

    const html = buildSharePageHtml([photo]);
    expect(html).not.toContain(malicious);
    expect(html).toContain("\\u003c/script\\u003e");
  });
});
