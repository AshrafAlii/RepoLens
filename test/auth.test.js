const test = require("node:test");
const assert = require("node:assert/strict");

// Configure the app before requiring it. dotenv never overrides variables that
// are already set, so these win over whatever is in .env.
process.env.APP_PASSWORD = "test-password";
process.env.SESSION_SECRET = "test-secret";
process.env.GITHUB_TOKEN = "ghp_test_token";
process.env.GITHUB_USERNAME = "test-owner";
process.env.GITHUB_REPO = "test-repo";
process.env.GITHUB_BRANCH = "main";

const app = require("../server");

let server;
let base;
let sessionCookie;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

function login(password) {
  return fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

test("unauthenticated API requests are rejected", async () => {
  const res = await fetch(`${base}/api/media`);
  assert.equal(res.status, 401);
});

test("the GitHub token is never served without a session", async () => {
  const res = await fetch(`${base}/api/config`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.token, undefined);
});

test("a wrong password is rejected", async () => {
  const res = await login("nope");
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("login issues an HttpOnly cookie that unlocks the API", async () => {
  const res = await login("test-password");
  assert.equal(res.status, 200);

  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /HttpOnly/);
  assert.match(cookies[0], /SameSite=Lax/);
  sessionCookie = cookies[0].split(";")[0];

  const session = await fetch(`${base}/api/session`, {
    headers: { cookie: sessionCookie },
  });
  assert.deepEqual(await session.json(), { authenticated: true, configured: true });

  const config = await fetch(`${base}/api/config`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(config.status, 200);
  const body = await config.json();
  assert.equal(body.owner, "test-owner");
  assert.equal(body.repo, "test-repo");
  assert.equal(body.branch, "main");
});

test("delete refuses paths outside media/", async () => {
  const res = await fetch(`${base}/api/media`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", cookie: sessionCookie },
    body: JSON.stringify({ path: "../.git/config", sha: "a".repeat(40) }),
  });
  assert.equal(res.status, 400);
});

test("delete refuses an invalid sha", async () => {
  const res = await fetch(`${base}/api/media`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", cookie: sessionCookie },
    body: JSON.stringify({ path: "media/a.jpg", sha: "not-a-sha" }),
  });
  assert.equal(res.status, 400);
});

test("thumb delete refuses paths outside thumbs/", async () => {
  const res = await fetch(`${base}/api/thumb`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", cookie: sessionCookie },
    body: JSON.stringify({ path: "media/a.jpg" }),
  });
  assert.equal(res.status, 400);
});

test("logout clears the session cookie", async () => {
  const res = await fetch(`${base}/api/logout`, {
    method: "POST",
    headers: { cookie: sessionCookie },
  });
  assert.equal(res.status, 200);
  const cookies = res.headers.getSetCookie();
  assert.match(cookies[0], /Max-Age=0/);
});
