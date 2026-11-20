# Publishing the extracted crates

**Nothing here has been run.** Every command below is outward and irreversible
(a public GitHub repo; a `cargo publish` can be yanked but never deleted). These
are staged for the owner's explicit OK. Do them in order, top to bottom.

One crate is being extracted from openComposer:

- `control4-soap` — **scaffold only** (`crates/control4-soap`, `publish = false`).
  Code moves after PRs #6/#7 merge; see its `DESIGN.md`. Do **not** publish it
  until the real extraction lands and `publish = false` is removed.

SDDP is **not** extracted into a new crate: openComposer now depends on the
owner's existing shared `sddp` crate (`github.com/The1TrueJoe/sddp`, pinned by
rev in `crates/c4/Cargo.toml`). Nothing to publish there — it already covers
discovery and openComposer keeps only a thin projection in `c4::sddp`.

## 0. Decide the blockers first (both crates)

1. **License.** The repo has no `LICENSE` file and no `license` field anywhere.
   `cargo publish` fails without one. Pick a license (suggest `MIT OR
   Apache-2.0`), add the `LICENSE` file(s), and set `license = "..."` in each
   crate's `Cargo.toml` (the field is left commented in both, with a marker).
2. **Owner/account.** Confirm the crates.io account and the GitHub org/owner
   (`The1TrueJoe`) that will own the repo. The `repository = ...` URL in the
   soap `Cargo.toml` assumes `github.com/The1TrueJoe/control4-soap`.
3. **USER_AGENT** (soap only) — resolve DESIGN.md §6.1 before publishing soap.

Why crates.io at all: GitHub's "Used by" / dependents graph only resolves for
published crates, so the three consumers should depend by version, not path/git.
(The `sddp` crate is a git dep today and that is fine for openComposer; the
owner can publish it separately if they want the dependents graph for it too.)

## 1. control4-soap (GATED — not yet)

Do **not** attempt until:
- [ ] PRs #6 and #7 are merged.
- [ ] The extraction in `DESIGN.md §7` is executed and `cargo test --workspace`
      is green with `calls_match_composer` passing from its new home.
- [ ] `publish = false` removed from `crates/control4-soap/Cargo.toml` and
      `version` bumped `0.0.0` → `0.1.0`.
- [ ] §0 blockers resolved.

Then the same `cargo publish --dry-run` → `cargo publish` flow.

```bash
cd control4-soap               # once it leaves this repo, see §2
cargo publish --dry-run        # verify packaging; no upload
cargo publish                  # OUTWARD: uploads to crates.io, cannot be deleted
```

## 2. New GitHub repo for control4-soap (outward)

`control4-soap` lives as a workspace member inside openComposer. To publish it
as a standalone repo with history:

```bash
# Create the empty public repo (owner's OK required — this is outward):
gh repo create The1TrueJoe/control4-soap --public --disable-wiki
```

Moving the crate out with its git history uses `git subtree split`:

```bash
# From the openComposer checkout:
git subtree split --prefix=crates/control4-soap -b control4-soap-export
cd /tmp && git clone <openComposer> control4-soap && cd control4-soap
git checkout control4-soap-export
git remote set-url origin git@github.com:The1TrueJoe/control4-soap.git
# fix paths: the crate's Cargo.toml becomes the repo root; drop workspace inheritance if any
git push -u origin control4-soap-export:main
```

(`control4-soap`'s `Cargo.toml` uses literal `version`/`edition`, not
`*.workspace`, so it stands alone with no edits.)

## 3. After publishing — switch openComposer off the path dep

Once `control4-soap` is on crates.io, change openComposer's manifest from the
path dep to the published version, and drop `crates/control4-soap` from the
workspace `members` (or keep the path dep during a transition — your call).

## Reversibility note

- Everything done tonight is **local and reversible**: the `sddp` git dep is a
  one-line manifest change, and `control4-soap` is an empty scaffold.
  `git revert`/`git reset` undoes it.
- Everything in this file is **not** reversible once run (public repo, crates.io
  uploads). That is the line the owner approves in the morning.
