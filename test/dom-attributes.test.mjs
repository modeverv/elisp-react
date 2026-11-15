import assert from "node:assert/strict";
import test from "node:test";
import { isSafeAttribute } from "../js/elisp-react.js";

test("ordinary attributes cannot install inline code or an HTML document", () => {
  for (const name of ["onclick", "OnError", "ONLOAD", "srcdoc", "sRcDoC"]) {
    assert.equal(isSafeAttribute(name, ""), false, name);
  }
});

test("URL attributes reject script schemes using browser normalization", () => {
  const payloads = [
    "javascript:alert(1)", "JAVASCRIPT:alert(1)", " \tJaVa\nScRiPt:alert(1)",
    "\u0000\u001f javascript:alert(1)", "java\tsc\rrip\nt:alert(1)", "vbscript:msgbox(1)",
  ];
  for (const name of ["href", "HREF", "src", "action", "formaction", "data", "xlink:href", "codebase"]) {
    for (const value of payloads) assert.equal(isSafeAttribute(name, value), false, `${name} ${JSON.stringify(value)}`);
  }
});

test("ordinary URLs, data images and literal attribute text remain usable", () => {
  for (const value of ["", "#section", "/a?q=javascript:example", "../page", "https://example.test/", "//example.test/", "mailto:person@example.test", "tel:123", "blob:https://example.test/id", "data:image/png;base64,iVBORw0KGgo=", "javascript%3Aalert(1)", "java&#x73;cript:alert(1)"]) {
    assert.equal(isSafeAttribute("href", value), true, value);
  }
  assert.equal(isSafeAttribute("data-description", "javascript:example"), true);
  assert.equal(isSafeAttribute("title", "<script>text</script>"), true);
});
