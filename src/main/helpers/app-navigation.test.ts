import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAppUrl, shouldBlockNavigation } from "./app-navigation.ts";

const APP = "file:///opt/hydra/out/renderer/index.html";
const DEV = "http://localhost:5173";
const PACKAGED = { documents: [APP], origins: [] };
const WITH_DEV = { documents: [APP], origins: [DEV] };

describe("isAppUrl", () => {
  it("accepts packaged pages and trusted origins only", () => {
    assert.equal(isAppUrl(`${APP}#/game/1`, PACKAGED), true);
    assert.equal(isAppUrl(`${DEV}/#/`, WITH_DEV), true);
    for (const url of [
      `${DEV}/#/`,
      "file:///home/user/Downloads/game/evil.html",
      "file:///opt/hydra/out/renderer/other.html",
      "app://./index.html",
      "https://evil.example/",
      "local:///etc/passwd",
      "data:text/html,<script>1</script>",
      "about:blank",
      "",
      "not a url",
    ]) {
      assert.equal(isAppUrl(url, PACKAGED), false, url);
    }
  });
});

describe("shouldBlockNavigation", () => {
  it("lets an app window reload or change route", () => {
    assert.equal(
      shouldBlockNavigation(`${APP}#/a`, `${APP}#/b`, PACKAGED),
      false
    );
    assert.equal(shouldBlockNavigation(`${APP}#/a`, APP, PACKAGED), false);
    assert.equal(
      shouldBlockNavigation(`${DEV}/#/a`, `${DEV}/#/b`, WITH_DEV),
      false
    );
  });

  it("stops an app window from leaving its document", () => {
    for (const target of [
      "https://evil.example/",
      "http://evil.example/#/a",
      "file:///home/user/Downloads/game/evil.html",
      "data:text/html,<script>1</script>",
      "javascript:alert(1)",
      "not a url",
      `${DEV}/other.html`,
    ]) {
      assert.equal(
        shouldBlockNavigation(`${APP}#/a`, target, WITH_DEV),
        true,
        target
      );
    }
    assert.equal(
      shouldBlockNavigation(`${DEV}/#/a`, `${DEV}/evil.html`, WITH_DEV),
      true
    );
  });

  it("leaves windows that show remote pages alone", () => {
    assert.equal(
      shouldBlockNavigation(
        "https://login.example/start",
        "https://login.example/done",
        PACKAGED
      ),
      false
    );
    assert.equal(
      shouldBlockNavigation("about:blank", "https://x.example/", PACKAGED),
      false
    );
  });
});
