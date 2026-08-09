import z from "zod";

export const openExternalLinkInputSchema = z.object({
  url: z.url().refine((url) => {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Only HTTP and HTTPS URLs can be opened externally"),
});
