# Invoice Collector

Invoice Collector is an open-source desktop app (Windows/macOS) that automates collecting invoices
from cloud services and email, and archiving them to a destination like a shared folder — built
around a plugin architecture so new sources and destinations can be added without changing the core
app at all.

**Status: early development.** This repo currently contains the project's monorepo scaffold and
core design decisions — not yet a working application. See [Development](#development) for what
actually runs today, and [Packages](#packages) for what each piece is meant to become.

## Why a plugin architecture

Cloud invoice APIs are a fragmented, constantly-shifting landscape — most vendors have no proper
self-serve billing API at all, and the ones that do change endpoints without notice. Rather than
one monolithic app trying to keep up with every provider itself, Invoice Collector separates:

- a small, stable **core app** with no integrations built in at all,
- a **plugin SDK** any developer can build against, and
- **plugins** — independently developed and released — that actually talk to a given source
  (a cloud service, a mailbox) or destination (a shared drive, a storage backend).

This repo and everything in it is open source (MIT). Some source/destination integrations —
generally ones with real, ongoing maintenance cost (reverse-engineered APIs, providers that change
frequently) — are developed and distributed separately as commercial plugins, using the exact same
public plugin interface as any open-source one. The core app treats every plugin identically
regardless of who wrote it or whether it's free.

## Packages

This is an npm-workspaces monorepo.

- **[`packages/ic-core`](packages/ic-core)** — the Electron desktop app shell. Owns configuration,
  credential/session storage, the job runner that drives a Collect run, plugin installation and
  trust verification, and the UI that renders any plugin's declarative wizard/settings screens. Has
  no source or destination integrations of its own.
- **[`packages/invoice-collector-plugin-sdk`](packages/invoice-collector-plugin-sdk)** — the plugin
  interface: types for building a source or destination plugin, the shared Session concept
  (connections plugins can establish and, in some cases, reuse across each other), and one built-in
  session implementation (OAuth2 delegated device-code) plugin authors can depend on instead of
  writing their own. Published to npm so any plugin — open source or commercial — can build against
  it.
- **[`packages/ic-email-to-downloads`](packages/ic-email-to-downloads)** — the reference plugin:
  scans a mailbox for invoice attachments and saves them to a local folder. Ships bundled with the
  packaged app, and doubles as a real, complete example for anyone writing their own plugin.

## Development

```bash
npm install
npm run typecheck   # across all three packages
npm run build        # across all three packages
npm test              # across all three packages
npm run lint
```

There's no functional app to run yet — each package is currently a placeholder proving the
workspace/typecheck/build/test/lint pipeline works end to end. Real functionality lands
incrementally; this section will grow real run/dev instructions as it does.

## License

MIT — see [LICENSE](LICENSE). Applies to everything in this repo: the core app, the plugin SDK, and
the reference plugin.

## Contributing

Not yet open for outside contributions while the initial architecture is still being built out —
this will be updated once there's a stable enough foundation (and a contribution process) to make
that worthwhile.
