#!/usr/bin/env node
// @ts-check
/**
 * Fetches project from GitHub, builds it, creates draft GitHub release and
 * uploads binaries there.
 *
 * Delegates signing to Windows running in Parallels, by putting the build
 * products to sign into a shared folder.
 *
 * Must be run on macOS.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const rimraf = require('rimraf');
const program = require('commander');
const semver = require('semver-extra');
const ManifestMaker = require('@peerio/update-maker');
const { makeTempDir, criticalError, execp, getFileNames, writeFile, readFile } = require('./helpers');
const { authenticate, downloadTagArchive, uploadReleaseAsset, getLatestTag } = require('./github');
const { override } = require('./override');

if (process.platform !== 'darwin') {
    console.error('Run this program on macOS (for macOS, Windows, Linux builder)');
    process.exit(1);
}

program
    .usage('--shared <dir> --repository <repo> [--tag [name]] [--publish | --destination <dir>] [--key [filename]]')
    .option('-s --shared <dir>', 'Shared directory between macOS and Windows')
    .option('-r --repository <repo>', 'Repository in ORGANIZATION/REPO format ')
    .option('-t --tag [name]', 'Source tag or branch name (latest tag by default)')
    .option('-p --publish', 'Publish release')
    .option('-P --platforms [list]', 'Comma-separated list of platforms (win,mac,linux)')
    .option('-a --prerelease', 'Mark as pre-release on GitHub')
    .option('-d --destination <dir>', 'Destination directory for build results (without --publish)')
    .option('-o --overrides <repo>', 'Repository with overrides (release will be published there)')
    .option('-n --nosign', 'Do not sign Windows release')
    .option('-k --key [filename]', 'Path to Peerio Updater secret key file')
    .parse(process.argv);

if ((!program.shared && !program.nosign) || !program.repository) {
    program.outputHelp();
    process.exit(1);
}

if ((!program.publish && !program.destination) ||
    (program.publish && program.destination)) {
    console.log('Error: either --publish or --dest flag required, but not both.')
    program.outputHelp();
    process.exit(1);
}

if (program.shared && program.nosign) {
    console.log('Error: either --shared or --nosign flag required, but not both.')
    program.outputHelp();
    process.exit(1);
}

// Get input and output directory.
const SHARED_DIR = program.shared;
const [GITHUB_OWNER, GITHUB_REPO] = program.repository.split('/');
let GITHUB_TAG = program.tag;

const GITHUB_AUTH_TOKEN = process.env.GH_TOKEN;
if (!GITHUB_AUTH_TOKEN) {
    console.error(
        'Please set GH_TOKEN environment variable to the correct GitHub ' +
        'authentication token that has access to the given project'
    );
    process.exit(2);
}

authenticate(GITHUB_AUTH_TOKEN);


// Check that in/out directories exist.
if (SHARED_DIR) {
    const INPUT_DIR = path.join(SHARED_DIR, 'in');
    const OUTPUT_DIR = path.join(SHARED_DIR, 'out');
    try {
        fs.accessSync(INPUT_DIR);
    } catch (ex) {
        console.error(`Cannot access input directory ${INPUT_DIR}`);
        process.exit(3);
    }

    try {
        fs.accessSync(OUTPUT_DIR);
    } catch (ex) {
        console.error(`Cannot access output directory ${OUTPUT_DIR}`);
        process.exit(4);
    }
}

if (program.destination) {
    try {
        fs.mkdirSync(program.destination);
    } catch (ex) {
        if (ex.code !== 'EEXIST') {
            console.error(`Cannot access destination directory ${program.destination}`);
            process.exit(4);
        }
    }
}

main();

async function main() {
    let sourceTempDir;
    let overridesDir;

    try {
        if (!GITHUB_TAG) {
            GITHUB_TAG = await getLatestTag(GITHUB_OWNER, GITHUB_REPO);
        }

        let manifestMaker;
        if (program.key) {
            manifestMaker = new ManifestMaker();
            console.log('Unlocking peerio-updater key file');
            await manifestMaker.unlockKeyFile(program.key);
        } else {
            console.warn('Warning: not making update manifest because no --key option specified');
        }

        // Create temporary directory for source and build files.
        sourceTempDir = await makeTempDir();

        console.log(`Downloading release ${GITHUB_TAG}...`);
        const projectDir = await downloadTagArchive(GITHUB_OWNER, GITHUB_REPO, GITHUB_TAG, sourceTempDir);

        const version = await readProjectVersion(projectDir);
        manifestMaker.setVersion(version, true);  // XXX: all updates are currently mandatory
        console.log(`Building version ${version}`);

        if (program.overrides) {
            // Apply overrides.
            overridesDir = await applyOverrides(program.overrides, projectDir, version);
        }

        console.log(`Building release in ${projectDir}`);
        await buildRelease(projectDir);

        if (manifestMaker) {
            // Get correct target repository where the update is published.
            const target = program.overrides
                ? splitRepoBranch(program.overrides)[0]
                : program.repository;

            const [targetOwner, targetRepo] = target.split('/');

            console.log(`Making update manifest`);
            const manifest = await makeUpdaterManifest(
                manifestMaker,
                projectDir,
                targetOwner,
                targetRepo
            );
            if (program.publish) {
                console.log('Uploading update manifest to GitHub release');
                await uploadReleaseAsset(manifest, targetOwner, targetRepo, version);
            }
        }
    } catch (ex) {
        criticalError(ex);
    } finally {
        if (overridesDir) rimraf.sync(overridesDir);
        if (program.publish) {
            if (sourceTempDir) rimraf.sync(sourceTempDir);
        } else {
            const newPath = path.join(program.destination, path.basename(sourceTempDir));
            fs.renameSync(sourceTempDir, newPath);
            console.log(`Build result is in ${newPath}`);
        }
    }
}

/**
 * Extracts version number from project's package.json.
 * Version is returned in "v1.0.0" format (with "v" prefix).
 *
 * @param {string} projectDir project directory (where package.json is)
 * @returns Promise<string>
 */
function readProjectVersion(projectDir) {
    const filename = path.join(projectDir, 'package.json');
    return readFile(filename)
        .then(JSON.parse)
        .then(json => semver.valid(json.version))
        .then(version => {
            if (!version) {
                throw new Error(`Invalid version in ${filename}`);
            }
            return 'v' + version;
        });
}

/**
 * Creates updater peerio-updater manifest for known dist files in the project
 * directory and returns promise resolving to manifest contents.
 *
 * @param {ManifestMaker} m manifest maker instance
 * @param {string} dir project directory
 * @param {string} owner project owner ("org" from github.com/org/repo)
 * @param {string} repo project repository ("repo" from github.com/org/repo)
 * @param {string} tag git tag
 * @returns Promise<string> manifest file path
 */
function makeUpdaterManifest(m, dir, owner, repo) {
    const distpath = path.join(dir, 'dist');
    // xxx: for now, sign zip files as mac updates, later we'll probably use dmg.
    return getFileNames(distpath, /\.(zip|exe|AppImage)$/i).then(names => {
        names.forEach(name => {
            let platform;
            if (/\.zip$/i.test(name)) {
                platform = 'mac';
            } else if (/\.exe$/i.test(name)) {
                platform = 'windows';
            } else if (/64\.AppImage$/i.test(name)) {
                platform = 'linux-x64';
            } else {
                return; // skip this file
            }
            m.addGitHubFile(platform, path.join(distpath, name), owner + '/' + repo);
        });
        return m.generate().then(data =>
            writeFile(path.join(distpath, 'manifest.txt'), data)
        );
    });
}

/**
 * Builds release in the project directory.
 * @param {string} dir project directory
 * @returns Promise<void>
 */
function buildRelease(dir) {
    return new Promise((fulfill, reject) => {
        const buildFlags = program.prerelease ? '--prerelease' : '';
        const publish = program.publish ? 'always' : 'never';
        const platforms = (program.platforms || 'windows,mac,linux').split(',').map(s => '--' + s.trim()).join(' ');
        const cmds = [
            'NODE_ENV=development npm install',
            'cd app && NODE_ENV=production npm install && cd ..',
            'NODE_ENV=production npm run dist',
            `NODE_ENV=production ./node_modules/.bin/build ${platforms} --publish ${publish} --draft ${buildFlags}`
        ];
        const env = Object.assign({}, process.env, { GH_TOKEN: GITHUB_AUTH_TOKEN });
        if (!program.nosign) {
            env.SHARED_DIR = SHARED_DIR;
            env.SIGNTOOL_TIMEOUT = '1200000'; // 20 minutes
            env.SIGNTOOL_PATH = path.join(__dirname, 'osslsigncode.js');
            env.WIN_CSC_LINK = 'ZmFrZWNlcnQ='; // any b64 string to trick builder into performing Windows codesigning
        }
        const builder = spawn('sh', ['-c', cmds.join(' && ')], { cwd: dir, env });
        builder.stdout.on('data', data => {
            console.log(data.toString());
        });
        builder.stderr.on('data', (data) => {
            console.error(data.toString());
        });
        builder.on('close', code => {
            if (code !== undefined && code !== 0) {
                reject(new Error(`Exited with code ${code}`));
            } else {
                fulfill();
            }
        });
    });
}

/**
 * Applies overrides from overridesRepo to targerDir.
 *
 * @param overridesRepo {string} github repository ORGANIZATION/REPO[#branch]
 * @param targetDir {string} target directory with Peerio desktop sources
 * @param version {string} version to tag (e.g. "v1.0.0")
 * @returns {Promise<void>} temporary directory with cloned overrides repository
 */
async function applyOverrides(overridesRepo, targetDir, version) {
    let tempDir;
    const [repo, branch] = splitRepoBranch(overridesRepo);
    try {
        tempDir = await makeTempDir();
        await execp(`git clone --depth=1 --branch=${branch} git@github.com:${repo}.git ${tempDir}`, tempDir);
        await override(tempDir, targetDir);
        if (program.publish) {
            // Tag a new release in overrides repo and push the tag.
            await execp(`git tag ${version}`, tempDir);
            await execp(`git push --tags`, tempDir);
        }
    } catch (ex) {
        if (tempDir) rimraf.sync(tempDir);
        criticalError(ex);
    }
}

/**
 * Extracts repo and branch name from repo url:
 *
 * bla/proj#branch -> ["github.com/bla/proj", "branch"]
 * bla/proj        -> ["github.com/bla/proj", "master"]
 *
 * @param {string} url
 */
function splitRepoBranch(url) {
    const i = url.lastIndexOf('#');
    if (i < 0) {
        return [url, "master"];
    }
    return [
        url.substring(0, i),
        url.substring(i + 1)
    ];
}
