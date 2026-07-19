# ekklesia-backend

## 0.9.2

### Patch Changes

- 0c82be5: Update dependencies: Mongoose to 9.3.0, Day.js to 1.11.20, and the Mesh SDK core and common packages to 1.9.0-beta.101. Declare a Node 20 floor in package.json.

## 0.9.1

### Patch Changes

- f78d055: Publish a versioned source tarball with each GitHub Release, containing just the files needed to run the server in production. Pushes to staging also publish a rolling preprod build so the testnet can track the release candidate.
- 9d9cde5: Bring Dependabot to the shared standard: weekly npm/github-actions/docker updates, a 3/7/14-day patch/minor/major cooldown, and development as the target branch.
