import assert from "node:assert/strict";

// Run against an already started page, through Emacs's real reconciler.
export async function checkDomSecurity(js, pause, until) {
  const lisp = (value) => value == null ? "nil" : `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
  const run = (source) => js(`window.elispReact.run(${JSON.stringify(source)}).then(() => true)`);
  let revision = 0;
  const render = async (changes = {}) => {
    const props = { href: "#security-safe", onclick: null, srcdoc: null, src: "about:blank", action: "#security-safe", formaction: "#security-safe", ...changes };
    revision++;
    await run(`(react-mount
      (list 'div nil
        (list 'a (list :id "security-link" :href ${lisp(props.href)}) "Open")
        (list 'button (list :id "security-button" :onclick ${lisp(props.onclick)}
          :on-click (lambda (_event) (setq security-click-count (1+ security-click-count)))) "Click")
        (list 'iframe (list :id "security-frame" :src ${lisp(props.src)} :srcdoc ${lisp(props.srcdoc)}))
        (list 'form (list :id "security-form" :action ${lisp(props.action)})
          (list 'button (list :id "security-submit" :formaction ${lisp(props.formaction)}) "Submit"))
        (list 'span (list :id "security-text") "<script>window.__securityExecuted++</script>")
        (list 'span (list :id "security-sibling") ${lisp(String(revision))})
        (list 'img (list :id "security-image" :src "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")))
      "#app")`);
    assert.equal(await js("document.querySelector('#security-sibling').textContent"), String(revision), "later siblings must still render");
  };
  await js("window.__securityExecuted = 0; true");
  await run("(defvar security-click-count 0)");
  await render();

  for (const href of [
    "javascript:window.__securityExecuted++; void(0)",
    " \tJaVa\nScRiPt:window.__securityExecuted++; void(0)",
  ]) {
    await render({ href });
    assert.equal(await js("document.querySelector('#security-link').getAttribute('href')"), null);
    await js("document.querySelector('#security-link').click(); true");
    await pause(30);
    assert.equal(await js("window.__securityExecuted"), 0);
    await render();
    assert.equal(await js("document.querySelector('#security-link').getAttribute('href')"), "#security-safe", "a valid later update recovers");
  }

  await render({ onclick: "window.__securityExecuted++" });
  assert.equal(await js("document.querySelector('#security-button').getAttribute('onclick')"), null);
  await js("document.querySelector('#security-button').click(); true");
  await until("window.elispReact.emacs.eval('security-click-count').then((count) => count === 1)", "the Lisp callback survives a blocked inline handler");
  assert.equal(await js("window.__securityExecuted"), 0);

  for (const [property, selector, payload] of [
    ["srcdoc", "#security-frame", "<script>parent.__securityExecuted++</script>"],
    ["src", "#security-frame", "javascript:parent.__securityExecuted++; void(0)"],
    ["action", "#security-form", "javascript:parent.__securityExecuted++; void(0)"],
    ["formaction", "#security-submit", "javascript:parent.__securityExecuted++; void(0)"],
  ]) {
    await render({ [property]: payload });
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).getAttribute(${JSON.stringify(property)})`), null);
    await pause(30);
    assert.equal(await js("window.__securityExecuted"), 0);
  }

  // A raw mixed-case attribute operation meets the same host boundary.
  await js(`(() => {
    const id = document.querySelector('#security-button').__elispReactId;
    window.elispReact.dom.apply([['attr', id, 'OnClick', 'window.__securityExecuted++']]);
    document.querySelector('#security-button').click();
    return true;
  })()`);
  await until("window.elispReact.emacs.eval('security-click-count').then((count) => count === 2)", "the listener still works after a mixed-case blocked attribute");
  assert.equal(await js("document.querySelector('#security-button').getAttribute('onclick')"), null);

  await render();
  await until("document.querySelector('#security-image').complete && document.querySelector('#security-image').naturalWidth === 1", "data image URLs still load");
  assert.equal(await js("document.querySelector('#security-text').textContent"), "<script>window.__securityExecuted++</script>");
  assert.equal(await js("document.querySelector('#security-text script')"), null);
  await js("document.querySelector('#security-link').click(); true");
  assert.equal(await js("location.hash"), "#security-safe", "normal links still navigate");
  assert.equal(await js("window.__securityExecuted"), 0);
}
