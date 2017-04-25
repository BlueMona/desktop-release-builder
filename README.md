release-maker
=============

Makes releases of Peerio Desktop: downloads the ZIP of a tag of the specified repository from GitHub, Compiles the project and runs electron-builder to build and sign Windows, Mac and Linux binaries and installers, and publishes to a draft GitHub release.

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

### Windows (in Paralllels)

* Install git - https://git-scm.org
* Install node (latest, not LTS) - https://nodejs.org
* Install Windows SDK - https://developer.microsoft.com/en-us/windows/downloads/windows-10-sdk
* XXX: install whatever drivers are needed for USB token.


Dev notes
---------

In `project.json`:

* `build.win.publisherName` should be set (e.g. to "Peerio Technologies Inc.")


Creating a release
------------------

1. Launch Windows, open "Node.js command prompt".
2. Go to the builder directory, type:

	node index Y:\ "certificate name"

   (Assuming Y: is a disk mapping a shared folder from Mac to Windows,
   "certificate name" is the name of certificate to use -- either
   a file path or a name from certificate storage for USB token.)

   The service will be available until terminated with Ctrl+C,
   so it can sign as many releases as needed without starting it
   again.

3. On a Mac, in Terminal go to the builder directory, type:

	node index ~/Shared PeerioTechnologies/peerio-desktop v0.0.0


   Replace v0.0.0 with the actual tag for the version.
   If the tag is not given, releases tag with the greatest version
   (according to semver)

   (Assuming ~/Shared is a shared folder between Mac and Windows)

4. Wait for the project to build, check Windows for
   USB token password input. Enter password.

5. Wait for the project to create a draft release and upload files.

6. Edit the release draft on GitHub and publish it.