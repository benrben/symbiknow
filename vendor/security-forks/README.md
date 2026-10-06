# Local dependency security forks

These tarballs are built from the adjacent source directories and pinned by `package-lock.json`. They are direct dependencies so npm can use them to satisfy the compatible transitive ranges without a parent-relative `file:` override.

- `braces-3.0.4.tgz` starts from braces 3.0.3. Its parser treats inputs exceeding 128 nested brace groups as literals before recursive AST walkers run. This addresses [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
- `sprintf-js-1.1.4.tgz` starts from sprintf-js 1.1.3. It bounds numeric precision to the ECMAScript range before calling `toExponential`, `toFixed`, or `toPrecision`. This addresses [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
- `argparse-1.0.11.tgz` starts from argparse 1.0.10. Only its package metadata changes: it depends on the patched sprintf-js 1.1 line. This keeps gray-matter's js-yaml 3 dependency on argparse 1.x intact.

These versions are local fork identifiers, not upstream releases. The lockfile's `file:` resolution records their provenance. To rebuild a tarball after changing source, run `npm pack ./<directory> --pack-destination .` from this directory and update the lockfile. Run `npx vitest run vendor/security-forks/security-forks.test.js` and `npm ci` in a clean checkout before shipping.
