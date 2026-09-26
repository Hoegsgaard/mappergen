# Maintainer release guide

This guide describes how the maintainer previews, publishes and recovers official
MapperGen releases.

## Local checks

Run `npm ci` and `npm run verify`. This checks formatting, types, runtime/compiler
behavior, Vite integration, an installed npm tarball, and the basic example.
CI repeats these checks on the minimum and latest version of each supported Node
line on Linux, and on Node 24 on Windows and macOS.

## Start from GitHub

Open **Actions → Release → Run workflow**, select the default branch (normally
`main`), and choose **patch**, **minor** or **major**. Leave **publish unchecked**
for a preview. No manual version edit, commit, tag or GitHub Release is needed.

Both modes run the CI matrix, increment package.json and package-lock.json inside
the runner, verify the versioned package, build a tarball, dry-run npm publication
and upload the tarball as an artifact. A preview does not push or publish anything.

With **publish checked**, the workflow also creates a version commit and annotated
`v<version>` tag, pushes both atomically, publishes the tarball built from that commit,
and creates a GitHub Release with generated release notes and the tarball attached.
The workflow stops if the branch moved since dispatch; start again from its latest
commit. Releases run one at a time and are not cancelled midway by a later run.

## Publishing a version

Start Release from the default branch, choose the version increment and enable
**publish**.
The workflow updates the version and lockfile automatically; do not create a tag
or GitHub Release beforehand. Verify the published quickstart after publication.

The workflow only supports stable patch/minor/major releases. It does not publish
on ordinary pushes or merges. GITHUB_TOKEN pushes do not trigger another push CI
run, so the workflow verifies the versioned package itself before pushing it.

## If a release fails

Git and npm cannot be updated as one transaction. The workflow pushes the commit
and tag before npm publication so a published version always has a source tag.
An atomic Git push prevents only one of the branch/tag updates being accepted.

- Before the push: no remote release changes exist. Fix the problem and start again.
- After the push but before publication: keep the tag and inspect npm and the saved
  tarball before recovery. Do not blindly rerun the version bump or move the tag.
  Complete publication of the existing version through the approved release identity.
- After npm publication but before GitHub Release creation: create the missing
  GitHub Release for the existing tag; do not republish or increment the version.

A full rerun from the old dispatch commit is intentionally rejected once the branch
has advanced. Recovery of a partial release is manual; npm versions cannot be overwritten.
