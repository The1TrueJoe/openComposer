# control4-soap

The **c4soap** wire protocol — Control4 Director's cert-pinned XML-over-TLS
(port 5021) — and a connected-Director client, as a crate three tools can share:
`control4-navigator-sink-lib`, `control4-fake-navigator`, and
[openComposer](https://github.com/The1TrueJoe/openComposer).

> **Scaffold.** No protocol code lives here yet. See [`DESIGN.md`](DESIGN.md) for
> the public API and migration plan. Extraction from openComposer's `c4::soap` is
> gated on PRs #6/#7; the typed, byte-exact `Call` encoder is kept as-is, never
> rewritten onto a generic serializer.
