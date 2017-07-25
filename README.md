Desktop release builder
=======================

Makes releases of Peerio Desktop: downloads a ZIP of the given tag of the specified repository from GitHub, compiles the project, runs electron-builder to build and sign Windows, Mac, and Linux binaries and installers, and uploads them into a draft GitHub release.

Building is performed on macOS. Signing of Windows executables is delegated to a service running in a Windows VM in Parallels via a shared folder.


Installation
------------

### Mac

* Install Homebrew - https://brew.sh/
* In Terminal:

      brew install wine --without-x11
      brew install mono
      brew install gnu-tar graphicsmagick xz

* Install Parallels with Windows 10.
* In Parallels, create a shared folder between Mac and Windows, for example,
  ~/Shared/ (and probably disable all other shared folders for security).
  VM Options > Sharing > Custom folders.
* Open Terminal and type: `npm install -g ssh://git@github.com:PeerioTechnologies/desktop-release-builder.git`.


### Windows (in Parallels)

* Install git - https://git-scm.org
* Install node (latest, not LTS) - https://nodejs.org
* Install Windows SDK - https://developer.microsoft.com/en-us/windows/downloads/windows-10-sdk
* XXX: install whatever drivers are needed for USB token.
* "Node.js command prompt" and type `npm install -g ssh://git@github.com:PeerioTechnologies/desktop-release-builder.git`
(Alternatively, transfer download this repository, transfer files to Windows,
and type `npm install -g` inside the directory)


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

   Replace v0.0.0 with the actual tag for the version.
   If the tag is not given, fetches the greatest version (according to semver).

   `--key` parameter specifies path to
   [peerio-update-maker](https://github.com/PeerioTechnologies/peerio-update-maker)
   secret key corresponding to the public key that is used by peerio-updater to
   verify update manifest for this project. Close to the end of publishing,
   you'll be asked to enter your password for this key.

   (Assuming `~/Shared` is a shared folder between Mac and Windows)

   (For testing, instead of `--publish`, you can pass `--destination DIR`,
    in which case the build result won't be published, but will be moved
    to the specified directory.)

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
`package.json`, so make sure overrides do override it.**

Overrides repository name (`--overrides`) can contain a branch name after '#',
for example: `PeerioTechnologies/whitelabel#branch`.


If something goes wrong
-----------------------

If publishing fails to complete (e.g. when connection is interrupted during
upload), go to GitHub releases for the project, and delete the draft release.
Then repeat the release process.
