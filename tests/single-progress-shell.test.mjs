import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the application exposes exactly one visible progress element", async () => {
  const [html, controller, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../js/ui-controller.js", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8")
  ]);

  assert.equal((html.match(/<progress\b/g) || []).length, 1);
  assert.match(html, /id="analysisProgressBar"/);
  assert.doesNotMatch(html, /songUploadProgress/);
  assert.doesNotMatch(controller, /songUploadProgress/);
  assert.doesNotMatch(styles, /\.upload-progress\b/);
});

