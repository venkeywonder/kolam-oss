# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately instead:

- GitHub: **Security → Report a vulnerability** on this repository, or
- Email: **support@trykolam.com** with "Security" in the subject.

Include the steps to reproduce, what an attacker could do, and the version or commit you tested. You'll get a reply
within 3 working days. Once a fix is released we'll credit you in the release notes, unless you'd rather stay anonymous.

## Supported versions

Only the latest release and the `main` branch get security fixes.

## Scope

In scope: this repository's code (the PHP API, the realtime server, the browser app and the MCP/OAuth endpoints).
Out of scope: problems that need a misconfigured server (for example a web server that serves `.env` or `storage/`
despite the included rules), denial of service by volume, and reports from automated scanners without a working proof.
