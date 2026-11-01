import fs from "node:fs";
import path from "node:path";

export const heifFixturePath = path.resolve(
  "src/tests/fixtures/heif/example.heic"
);

/** Add a property to the known, immutable two-image upstream fixture. */
export function withHeifProperty(type: string, data: Buffer): Buffer {
  const source = fs.readFileSync(heifFixturePath);
  const property = Buffer.alloc(8 + data.length);
  property.writeUInt32BE(property.length);
  property.write(type, 4);
  data.copy(property, 8);
  const association = Buffer.concat([
    source.subarray(913, 934),
    Buffer.from([0x87]),
    source.subarray(934, 949),
  ]);
  association.writeUInt32BE(association.length);
  association[18]++;
  const delta = property.length + 1;
  const result = Buffer.concat([
    source.subarray(0, 913),
    property,
    association,
    source.subarray(949),
  ]);
  for (const offset of [28, 355]) {
    result.writeUInt32BE(source.readUInt32BE(offset) + delta, offset);
  }
  result.writeUInt32BE(source.readUInt32BE(363) + property.length, 363);
  // iloc v0 has four items, each with a 32-bit base offset and one extent.
  for (let item = 0; item < 4; item++) {
    const offset = 107 + item * 18;
    result.writeUInt32BE(source.readUInt32BE(offset) + delta, offset);
  }
  return result;
}
