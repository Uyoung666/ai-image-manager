import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const PLACEHOLDERS =
  /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\{\s*([A-Za-z0-9_.-]+)\s*\}/g;
export const textHash = (text) =>
  createHash("sha256").update(text).digest("hex");

export function catalogNodes(value, prefix = "", result = new Map()) {
  if (typeof value === "string") {
    result.set(prefix, { type: "string", text: value });
  } else if (value && typeof value === "object") {
    result.set(prefix, {
      type: Array.isArray(value) ? `array:${value.length}` : "object",
    });
    for (const [key, child] of Object.entries(value)) {
      catalogNodes(child, prefix ? `${prefix}.${key}` : key, result);
    }
  } else {
    result.set(prefix, { type: "invalid" });
  }
  return result;
}

export function catalogHash(catalog) {
  return textHash(
    JSON.stringify(
      [...catalogNodes(catalog)].sort(([a], [b]) => a.localeCompare(b, "en"))
    )
  );
}

function checkTranslationLeaf(
  key,
  node,
  target,
  oldSource,
  oldTranslation,
  review,
  errors
) {
  const reviewed =
    review?.sourceSha256 === textHash(node.text) &&
    typeof review.reason === "string" &&
    Boolean(review.reason.trim());
  if (!target.text.trim()) {
    errors.push(`${key}: empty translation`);
  }
  const names = (text) =>
    [...text.matchAll(PLACEHOLDERS)].map((m) => m[1] ?? m[2]).sort();
  if (JSON.stringify(names(node.text)) !== JSON.stringify(names(target.text))) {
    errors.push(`${key}: interpolation mismatch`);
  }
  if (target.text === node.text && !reviewed) {
    errors.push(`${key}: unchanged English requires a source-hash review`);
  }
  const changed = oldSource.has(key) && oldSource.get(key).text !== node.text;
  if (changed && oldTranslation.get(key)?.text === target.text && !reviewed) {
    errors.push(
      `${key}: changed English requires updated Japanese or a source-hash review`
    );
  }
  return changed;
}

export function checkLocaleContract({
  source,
  translation,
  previousSource,
  previousTranslation,
  reviews = {},
}) {
  const expected = catalogNodes(source);
  const actual = catalogNodes(translation);
  const oldSource = previousSource ? catalogNodes(previousSource) : new Map();
  const oldTranslation = previousTranslation
    ? catalogNodes(previousTranslation)
    : new Map();
  const errors = [];
  let total = 0;
  let changed = 0;
  for (const [key, node] of expected) {
    const target = actual.get(key);
    if (!target || target.type !== node.type) {
      errors.push(`${key}: missing or mismatched structure`);
      continue;
    }
    if (node.type !== "string") {
      continue;
    }
    total += 1;
    changed += Number(
      checkTranslationLeaf(
        key,
        node,
        target,
        oldSource,
        oldTranslation,
        reviews[key],
        errors
      )
    );
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) {
      errors.push(`${key}: extra translation`);
    }
  }
  return { errors, total, changed, sourceCatalogSha256: catalogHash(source) };
}

function property(node, name) {
  if (!(node && ts.isObjectLiteralExpression(node))) {
    throw new Error(`Cannot locate historical catalog property ${name}`);
  }
  return node.properties.find(
    (item) => ts.isPropertyAssignment(item) && item.name.text === name
  )?.initializer;
}

function literal(node) {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(literal);
  }
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.map((item) => [item.name.text, literal(item.initializer)])
    );
  }
  throw new Error("Historical catalog must contain only literal data");
}

export function readCatalogs(root, ref) {
  const read = (file) =>
    ref
      ? execFileSync("git", ["show", `${ref}:${file}`], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : fs.readFileSync(path.join(root, file), "utf8");
  let source;
  const hasJson =
    !ref ||
    execFileSync(
      "git",
      ["ls-tree", "--name-only", ref, "src/localization/english-renderer.json"],
      { cwd: root, encoding: "utf8", windowsHide: true }
    ).trim();
  if (hasJson) {
    source = {
      renderer: JSON.parse(read("src/localization/english-renderer.json")),
      main: JSON.parse(read("src/localization/english-main.json")),
    };
  } else {
    const rendererAst = ts.createSourceFile(
      "i18n.ts",
      read("src/localization/i18n.ts"),
      ts.ScriptTarget.Latest,
      true
    );
    let resources;
    const visit = (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(rendererAst) === "resources"
      ) {
        resources = node.initializer;
      }
      ts.forEachChild(node, visit);
    };
    visit(rendererAst);
    const mainAst = ts.createSourceFile(
      "catalog.ts",
      read("src/localization/catalog.ts"),
      ts.ScriptTarget.Latest,
      true
    );
    let main;
    const findMain = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(mainAst) === "BUILTIN_MAIN_CATALOGS"
      ) {
        main = property(node.initializer, "en");
      }
      ts.forEachChild(node, findMain);
    };
    findMain(mainAst);
    source = {
      renderer: literal(property(property(resources, "en"), "translation")),
      main: literal(main),
    };
  }
  const translation = {
    renderer: JSON.parse(
      read("external-plugins/japanese-locale/locales/ja-JP/renderer.json")
    ),
    main: JSON.parse(
      read("external-plugins/japanese-locale/locales/ja-JP/main.json")
    ),
  };
  return { source, translation };
}
