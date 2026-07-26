import { describe, expect, it, vi } from "vitest";
import {
  buildExiftoolArgFile,
  extractRawPreview,
} from "../../../scripts/raw-preview.mjs";

type RunExiftool = NonNullable<Parameters<typeof extractRawPreview>[1]>;

describe("RAW preview worker helper", () => {
  it("passes non-ASCII filenames through a UTF-8 ExifTool argfile", () => {
    const filePath = "D:/8806/7.20无云满霞/DSC01907.ARW";
    const preview = Buffer.from("jpeg-preview");
    const runExiftool = vi.fn<RunExiftool>(() => preview);

    expect(extractRawPreview(filePath, runExiftool)).toBe(preview);
    expect(runExiftool).toHaveBeenCalledTimes(1);

    const [, args, options] = runExiftool.mock.calls[0];
    expect(args).toEqual(["-charset", "filename=UTF8", "-@", "-"]);
    expect(args).not.toContain(filePath);
    expect(options.input).toEqual(buildExiftoolArgFile("JpgFromRaw", filePath));
    expect(options.input.toString("utf8")).toContain(filePath);
  });

  it("falls back to PreviewImage when JpgFromRaw is unavailable", () => {
    const runExiftool = vi
      .fn<RunExiftool>()
      .mockImplementationOnce(() => {
        throw new Error("tag missing");
      })
      .mockReturnValueOnce(Buffer.from("preview"));

    expect(extractRawPreview("D:/照片.ARW", runExiftool)).toEqual(
      Buffer.from("preview")
    );
    expect(runExiftool.mock.calls[1][2].input.toString("utf8")).toBe(
      "-b\n-PreviewImage\nD:/照片.ARW\n"
    );
  });
});
