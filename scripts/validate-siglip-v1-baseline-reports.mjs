/** Validates generated SigLIP v1 raw, aggregate, index, and summary JSON. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const definitionsRoot = path.join(import.meta.dirname, "siglip-v1-baseline");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function formatErrors(errors) {
  return (errors ?? [])
    .map(
      (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
    )
    .join("; ");
}

function validateFile(validate, runDirectory, fileName) {
  const filePath = path.join(runDirectory, fileName);
  const value = readJson(filePath);
  if (!validate(value)) {
    throw new Error(`${fileName}: ${formatErrors(validate.errors)}`);
  }
  return fileName;
}

export function validateRunArtifacts(runDirectory) {
  const resolvedRunDirectory = path.resolve(runDirectory);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  const validateReport = ajv.compile(
    readJson(path.join(definitionsRoot, "report.schema.json"))
  );
  const validateIndex = ajv.compile(
    readJson(path.join(definitionsRoot, "run-index.schema.json"))
  );
  const validateSummary = ajv.compile(
    readJson(path.join(definitionsRoot, "summary.schema.json"))
  );

  const index = readJson(path.join(resolvedRunDirectory, "run-index.json"));
  const validated = [];
  for (const entry of index.rawTrials) {
    validated.push(
      validateFile(validateReport, resolvedRunDirectory, entry.fileName)
    );
  }
  for (const fileName of index.reports) {
    validated.push(
      validateFile(validateReport, resolvedRunDirectory, fileName)
    );
  }
  validated.push(
    validateFile(validateIndex, resolvedRunDirectory, "run-index.json")
  );
  validated.push(
    validateFile(validateSummary, resolvedRunDirectory, "summary.json")
  );
  return { runDirectory: resolvedRunDirectory, validated };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const runDirectory = process.argv[2];
  if (!runDirectory) {
    throw new Error(
      "Usage: node scripts/validate-siglip-v1-baseline-reports.mjs <reports/run-directory>"
    );
  }
  console.log(JSON.stringify(validateRunArtifacts(runDirectory), null, 2));
}
