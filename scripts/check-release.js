// Runs before publishing. A tag pushed on the wrong commit (e.g. v2.0.0 on a commit
// whose package.json still says 1.2.1) builds and publishes the wrong version, and
// installed apps never see a usable update. Stop early with a clear message instead.
const { version } = require('../package.json');

const tag = process.env.GITHUB_REF_NAME || '';
if (/^v\d/.test(tag) && tag !== `v${version}`) {
  console.error(`Release tag ${tag} does not match package.json version ${version}.`);
  console.error(`Merge the release changes first, run "git pull", then tag that commit as v${version}.`);
  process.exit(1);
}
console.log(`Release check passed for version ${version}${tag ? ` (tag ${tag})` : ''}.`);
