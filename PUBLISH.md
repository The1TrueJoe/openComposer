# Publishing the extracted crates

**Nothing here has been run.** Every command below is outward and irreversible
(a public GitHub repo; a `cargo publish` can be yanked but never deleted). These
are staged for the owner's explicit OK. Do them in order, top to bottom.

Two crates are extracted from openComposer:

- `control4-sddp` — **done & wired** (`crates/control4-sddp`). SDDP discovery,
  ~160 lines, `cargo test --workspace` green. First Rust Control4-SDDP crate.
- `control4-soap` — **scaffold only** (`crates/control4-soap`, `publish = false`).
  Code moves after PRs #6/#7 merge; see its `DESIGN.md`. Do **not** publish it
  until the real extraction lands and `publish = false` is removed.

## 0. Decide the blockers first (both crates)

1. **License.** The repo has no `LICENSE` file and no `license` field anywhere.
   `cargo publish` fails without one. Pick a license (suggest `MIT OR
   Apache-2.0`), add the `LICENSE` file(s), and set `license = "..."` in each
   crate's `Cargo.toml` (the field is left commented in both, with a marker).
2. **Owner/account.** Confirm the crates.io account and the GitHub org/owner
   (`The1TrueJoe`) that will own the repos. The `repository = ...` URLs in the
   two Cargo.toml files assume `github.com/The1TrueJoe/<crate>`.
3. **USER_AGENT** (soap only) — resolve DESIGN.md §6.1 before publishing soap.

## 1. control4-sddp (ready now, pending §0)

Why crates.io at all: GitHub's "Used by" / dependents graph only resolves for
published crates, so the three consumers should depend by version, not path/git.

```bash
# From a clean checkout of the extracted crate (see §3 for how it leaves this repo).
cd control4-sddp
cargo publish --dry-run          # verify packaging; no upload
# — review the file list and metadata —
cargo publish                    # OUTWARD: uploads to crates.io, cannot be deleted
```

Pre-flight checklist:
- [ ] `license` set + `LICENSE` file present (§0.1).
- [ ] `cargo test -p control4-sddp` green.
- [ ] `cargo publish --dry-run` clean.
- [ ] README renders (it ships in the package).

## 2. control4-soap (GATED — not yet)

Do **not** attempt until:
- [ ] PRs #6 and #7 are merged.
- [ ] The extraction in `DESIGN.md §7` is executed and `cargo test --workspace`
      is green with `calls_match_composer` passing from its new home.
- [ ] `publish = false` removed from `crates/control4-soap/Cargo.toml` and
      `version` bumped `0.0.0` → `0.1.0`.
- [ ] §0 blockers resolved.

Then the same `cargo publish --dry-run` → `cargo publish` flow as §1.

## 3. New GitHub repos (outward)

The crates currently live as workspace members inside openComposer. To publish
them as standalone repos with history:

```bash
# Create the empty public repos (owner's OK required — this is outward):
gh repo create The1TrueJoe/control4-sddp --public --disable-wiki
gh repo create The1TrueJoe/control4-soap --public --disable-wiki   # when §2 is ready
```

Moving a crate out with its git history (it was created via `git mv`, so blame
is preserved) uses `git subtree split`:

```bash
# From the openComposer checkout:
git subtree split --prefix=crates/control4-sddp -b control4-sddp-export
cd /tmp && git clone <openComposer> control4-sddp && cd control4-sddp
git checkout control4-sddp-export
git remote set-url origin git@github.com:The1TrueJoe/control4-sddp.git
# fix paths: the crate's Cargo.toml becomes the repo root; drop workspace inheritance if any
git push -u origin control4-sddp-export:main
```

(`control4-sddp`'s `Cargo.toml` already uses literal `version`/`edition`, not
`*.workspace`, so it stands alone with no edits. `control4-soap` likewise.)

## 4. After publishing — switch openComposer off the path dep

Once `control4-sddp` is on crates.io, change `crates/c4/Cargo.toml`:

```diff
-control4-sddp = { path = "../control4-sddp" }
+control4-sddp = "0.1"
```

and remove `crates/control4-sddp` from this repo's workspace `members` (or keep
the path dep during a transition — your call). Same for `control4-soap` later.

## Reversibility note

- Everything done tonight is **local and reversible**: two new local workspace
  members, a path dep, a re-export shim. `git revert`/`git reset` undoes it.
- Everything in this file is **not** reversible once run (public repos, crates.io
  uploads). That is the line the owner approves in the morning.
