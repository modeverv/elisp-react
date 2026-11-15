// Put the policy from ?csp= into a <meta> before anything else runs, and
// count what it blocks.
const policy = new URLSearchParams(location.search).get("csp");
const meta = document.createElement("meta");
meta.httpEquiv = "Content-Security-Policy";
meta.content = policy;
document.head.prepend(meta);
window.violations = [];
document.addEventListener("securitypolicyviolation", (event) => window.violations.push(`${event.violatedDirective} ${event.blockedURI}`));
