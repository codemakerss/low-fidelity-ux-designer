import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const siteRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(path, "http://localhost/"), {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("redirects the site root to the neutral example board", async () => {
  const response = await render();

  assert.equal(response.status, 307);
  assert.equal(
    new URL(response.headers.get("location"), "http://localhost/").pathname,
    "/example-review-board.html",
  );
});

test("ships self-contained neutral review-board examples", async () => {
  const [board, review] = await Promise.all([
    readFile(new URL("public/example-review-board.html", siteRoot), "utf8"),
    readFile(new URL("public/review-v1.html", siteRoot), "utf8"),
  ]);

  assert.match(board, /sandbox="allow-scripts"/);
  assert.match(board, /referrerpolicy="no-referrer"/);
  assert.match(board, /Project Atlas/);
  assert.match(board, /sample-project-review/);
  assert.match(review, /Sample Project Review/);
  assert.match(review, /Knowledge Base/);

  const forbiddenMarkers = [
    ["code", "makerss"].join(""),
    ["Je", "ff"].join(""),
    ["app", "gprj_"].join(""),
    ["/Us", "ers/"].join(""),
  ];
  for (const marker of forbiddenMarkers) {
    assert.equal(board.includes(marker), false);
    assert.equal(review.includes(marker), false);
  }

  await assert.rejects(
    access(new URL(".openai/hosting.json", siteRoot)),
  );
});
