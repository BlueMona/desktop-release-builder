Desktop release builder
=======================

Makes releases of Peerio Desktop: downloads a ZIP of the given tag of the specified repository from GitHub, compiles the project, runs electron-builder to build and sign Windows, Mac, and Linux binaries and installers, and uploads them into a draft GitHub release.

Building is performed on macOS. Signing of Windows executables is delegated to a service running in a Windows VM in Parallels via a shared folder.


Installation
------------

### Mac

* Install Parallels with Windows 10.
* In Parallels, create a shared folder between Mac and Windows, for example,
  ~/Shared/ (and probably disable all other shared folders for security).
  VM Options > Sharing > Custom folders.
* Open Terminal and type: `npm install -g @peerio/desktop-release-builder`.


### Windows (in Parallels)

* Install git - https://git-scm.org
* Install node (latest, not LTS) - https://nodejs.org
* Install Windows SDK - https://developer.microsoft.com/en-us/windows/downloads/windows-10-sdk
* XXX: install whatever drivers are needed for USB token.
* "Node.js command prompt" and type `npm install -g @peerio/desktop-release-builder`


Dev notes
---------

In `project.json`:

* `build.win.publisherName` should be set (e.g. to "Technologies Peerio Inc.")


Creating a release
------------------

First of all, tag a new release.


1. Launch Windows, open "Node.js command prompt".
2. Type:

	   peerio-desktop-signer --shared Y:\ --certificate "certificate name"

   (Assuming Y: is a disk mapping a shared folder from Mac to Windows,
   "certificate name" is the name of certificate to use -- either
   a file path or a name from certificate storage for USB token.)

   The service will be available until terminated with Ctrl+C,
   so it can sign as many releases as needed without starting it
   again.

3. On a Mac, open Terminal and type:

       export GH_TOKEN=0000000000000000000000000000000000000000
       peerio-desktop-release --key /path/to/secretkey \
                              --shared ~/Shared \
                              --repository PeerioTechnologies/peerio-desktop \
                              --tag v0.0.0 \
                              --publish

   `GH_TOKEN` is a GitHub access token (https://github.com/settings/tokens).

   Replace v0.0.0 with the actual tag or branch for the version.
   If the tag is not given, fetches the greatest version (according to semver).

   `--key` parameter specifies path to
   [peerio-update-maker](https://github.com/PeerioTechnologies/peerio-update-maker)
   secret key corresponding to the public key that is used by peerio-updater to
   verify update manifest for this project. Close to the end of publishing,
   you'll be asked to enter your password for this key.

   (Assuming `~/Shared` is a shared folder between Mac and Windows)

   (For testing, instead of `--publish`, you can pass `--destination DIR`,
    in which case the build result won't be published, but will be moved
    to the specified directory. You can also specify platforms to build
    using `--platforms mac,win,linux` format. )

4. Wait for the project to build, check Windows for
   USB token password input. Enter password.

5. Wait for the project to create a draft release and upload files.

6. Edit the release draft on GitHub and publish it.


Creating a pre-release
----------------------

Same steps as release, but add `--prerelease` flag. In this case,
the release will be marked as "Pre-release" on GitHub.


Applying overrides from other repositories
------------------------------------------

Pass `--overrides` option to builder with repository containing overrides:

    export GH_TOKEN=0000000000000000000000000000000000000000
    peerio-desktop-release  --key /path/to/secretkey \
                            --shared ~/Shared \
                            --repository PeerioTechnologies/peerio-desktop \
                            --overrides PeerioTechnologies/whitelabel \
                            --tag v0.0.0 \
                            --publish

If `--publish` is passed, the overrides repository will be tagged with the
new release. **Release will be published to the repository specified in
`package.json`, so make sure it's overridden in `json-overrides`.**

Overrides repository name (`--overrides`) can contain a branch name after '#',
for example: `PeerioTechnologies/whitelabel#branch`.

To specify version suffix, add `--versioning` argument, for example, to turn
version `v3.0.0` from `package.json` into `v3.0.0-staging`,
specify `--versioning staging`.

Overrides repository must contain two items:

* `json-overrides.json` lists overrides that will be merged into the specified
   JSON files, for example:

```
"package.json": {
    "name": "peerio-staging",
    "productName": "Peerio Staging",
    "description": "Peerio Staging"
    "repository": {
        "type": "git",
        "url": "git+https://github.com/PeerioTechnologies/peerio-desktop-staging.git"
    },
},
"some/other/file.json": {
    "key": "value"
}
```

JSON overrides are applied recursively with [lodash.merge](https://lodash.com/docs#merge):

> This method is like _.assign except that it recursively merges own and inherited enumerable
> string keyed properties of source objects into the destination object. Source properties
> that resolve to undefined are skipped if a destination value exists. Array and plain object
> properties are merged recursively. Other objects and value types are overridden by assignment.
> Source objects are applied from left to right. Subsequent sources overwrite property assignments
> of previous sources.

As mentioned above, it's important to override `package.json`'s `repository` so that the
release will be published there.

* `file-overrides` is a directory containing files that will be added or that will replace
the once in the release starting from the root folder. For example,
`file-overrides/src/static/img/icon.png` will replace `src/static/img/icon.png` of the original
project (or add it, if the project doesn't have it.)


Releasing mandatory updates
---------------------------

In `package.json` the key `lastMandatoryUpdateVersion` specifies the last
release version that was a mandatory update, that is, if the version the user
has is less than or equal to it, the updater will consider it "mandatory",
otherwise the update is "optional" (this is specified in the update manifest).
To release a new mandatory update, the value of this key should be set to the
version that is being released.


If something goes wrong
-----------------------

If publishing fails to complete (e.g. when connection is interrupted during
upload), go to GitHub releases for the project, and delete the draft release.
Then repeat the release process.
