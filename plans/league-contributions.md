# League page contributions: friends add content through the page

Friends add trade searches, PoB builds and atlas trees to the League page through a form
on the page itself. Nothing goes live until the maintainer approves it. The rest of the page stays
static for now. New content types are added later by registering them, not by
rebuilding the form.

Status: plan, 2026-11-14. Builds after the Atlas planner's first version. Section 6 lists
the decisions to make before building.

## 1. What a friend does

1. On the League page, **Add** in Builds, Trade or Atlas trees (or one **Add** with a type
   picker) opens a form for that type.
2. They fill in the form: a title, their name, and the code or link. The form checks it
   as they type (the PoB code decodes, the link is a trade or atlas link) and shows a
   preview of the card.
3. **Send.** They see "Sent for review"; the card appears on the page once approved.

They never see a file, JSON or git.

## 2. Content types (a registry)

Each type is one entry in a registry: its fields, how to check and tidy them, and how to
draw its card. The form, the preview, the review check and the page all read the
registry, so a new type is a new entry plus its card.

| Type | Fields | Checks and tidying |
|---|---|---|
| Build | title, by, up to 3 notes, PoB code or pobb.in link | Decodes; account, character and realm removed; item Unique IDs removed (as `pob-publish.py` does); size cap |
| Trade search | title, build it's for, trade link | A `/trade/search/<league>/<state>` link is unpacked into its query (as done for the Covens links); league and Instant Buyout are applied by the page |
| Atlas tree | title, link | Our planner, poeatlasplanner.com or official link; point count read from it |

Later types (links, farm strats, …) are new registry entries.

## 3. Where content lives

- One file per card: `strats/content/<type>/<slug>.json` (hyphenated slug). One file per
  card means two submissions never clash.
- The Strats page workflow collects the folder into `strats/content/index.json`; the page
  draws the Builds, Trade and Atlas trees cards from it. The cheat-sheet parts (copied
  from the maintainer's artifact) stay as they are.
- Migration: today's Builds, Trade and Atlas trees cards become content files, and the
  page draws the same cards from them.

## 4. How a submission reaches the repo (decision needed)

The page is static, so sending needs one of these:

| Option | Friend needs | Maintainer runs | Notes |
|---|---|---|---|
| A. GitHub hand-off | A GitHub account | Nothing | **Send** opens GitHub's new-file page with the file already filled in; the friend clicks **Propose new file** → pull request. **Check:** GitHub's URL size limit vs a full PoB code; big builds may need a pobb.in link instead. |
| B. Small server + Discord sign-in | Discord, a role on our Discord server | A Cloudflare Worker (free tier) and a GitHub App | **Send** posts to the Worker; it checks the Discord role and opens the pull request itself. Friends need no GitHub. |
| C. Shared database | A sign-in | A hosted database (e.g. Supabase) | Content appears without commits; most to build and run. Best kept for shared atlas plans later. |

A and B write the same files, so starting with A and moving to B later costs only the
**Send** step.

## 5. Security

- **Only the maintainer publishes.** Anyone can open a pull request on a public repo; only the maintainer can
  merge. Option B also stops strangers at the Discord role check.
- **The review check reads files as data.** It runs on `pull_request` (read-only token, no
  secrets), never `pull_request_target`, and never runs code from a submission. The
  signing key never comes near it.
- **Plain text only.** Titles, names and notes are drawn as text, never HTML.
- **Allowed sites only:** pathofexile.com, poeatlasplanner.com, our atlas page, pobb.in,
  poe.ninja.
- **Size caps** per field; PoB codes are decoded and re-encoded, never stored as given.
- Later, optional: auto-merge for an allowlist of friends' accounts once the check passes;
  strangers still need the maintainer.

## 6. Decisions before building

1. Send method: A, B or A now and B later.
2. One **Add** per section, or one **Add** with a type picker.
3. Who can see pending submissions (only the maintainer on GitHub, or a "Pending" list on the page).
4. Whether a friend can edit or remove their own card later (needs B or C to know who
   they are).

## 7. Order of work

1. Content files + registry; migrate today's cards; the page draws them (no visible
   change).
2. The review check workflow on pull requests.
3. The **Add** form, preview and the chosen **Send** method.
4. Verification: a verifier subagent, a separate reviewer, the UI copy check, and a test
   submission end to end.
