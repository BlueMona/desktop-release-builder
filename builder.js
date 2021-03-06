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
const {
    makeTempDir, criticalError, execp,
    getFileNames, writeFile, readFile
} = require('./helpers');
const {
    authenticate, downloadTagArchive, uploadReleaseAsset,
    deleteReleaseAssets, getLatestTag, getCommitSHA
} = require('./github');
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
    .option('-a --prerelease', 'Mark as pre-release on GitHub (if not set, marked as draft)')
    .option('-d --destination <dir>', 'Destination directory for build results (without --publish)')
    .option('-o --overrides <repolist>', 'Repositories with overrides (comma-separated, release will be published in the last one)', s => s.split(','))
    .option('-n --nosign', 'Do not sign Windows release')
    .option('-k --key [filename]', 'Path to Peerio Updater secret key file')
    .option('-V --versioning [suffix]', 'Versioning based on override tag + 0.0.1 (optional suffix: "staging", "nightly")')
    .parse(process.argv);

if ((!program.shared && !program.nosign) || !program.repository) {
    program.outputHelp();
    process.exit(1);
}

if ((!program.publish && !program.destination) ||
    (program.publish && program.destination)) {
    console.error('Error: either --publish or --destination flag required, but not both.')
    program.outputHelp();
    process.exit(1);
}

if (program.shared && program.nosign) {
    console.error('Error: either --shared or --nosign flag required, but not both.')
    program.outputHelp();
    process.exit(1);
}

if (program.versioning && (!program.overrides || program.overrides.length === 0)) {
    console.error('Error: --versioning requires --overrides.')
    program.outputHelp();
    process.exit(1);
}

const RELEASE_OVERRIDES_DIR = 'release';

/* RegExp for files to delete from release after uploading */
const FILES_TO_DELETE = /^(latest(.*)\.(yml|json))|((.*)\.blockmap)$/;

// Get input and output directory.
const SHARED_DIR = program.shared;
const [GITHUB_OWNER, GITHUB_REPO] = program.repository.split('/');
let GITHUB_TAG = program.tag;

const GITHUB_AUTH_TOKEN = process.env.GH_TOKEN;
if (!GITHUB_AUTH_TOKEN && program.publish) {
    console.error(
        'Please set GH_TOKEN environment variable to the correct GitHub ' +
        'authentication token that has access to the given project'
    );
    process.exit(2);
}

if (GITHUB_AUTH_TOKEN) {
    authenticate(GITHUB_AUTH_TOKEN);
}


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

        let version = await readProjectVersion(projectDir);
        console.log(`Building from version ${version}`);

        // Apply release overrides.
        console.log(`Applying overrides from ${RELEASE_OVERRIDES_DIR}`)
        await override(projectDir, projectDir, {
            jsonOverridesFile: path.join(RELEASE_OVERRIDES_DIR, 'json-overrides.json'),
        });

        if (program.overrides && program.overrides.length > 0) {
            // Apply overrides from a "whitelabel" repo.
            for (let i = 0; i < program.overrides.length; i++) {
                console.log(`Applying overrides from repository ${program.overrides[i]}`);
                const isLast = (i === program.overrides.length - 1);
                version = await applyOverrides(program.overrides[i], projectDir, version, isLast);
                if (isLast) {
                    console.log(`Release will be published at ${program.overrides[i]}`)
                }
            }
        }

        console.log(`Building release in ${projectDir}`);
        await buildRelease(projectDir);

        const lastOverride = program.overrides
            ? program.overrides[program.overrides.length - 1]
            : undefined;

        const target = lastOverride
            ? splitRepoBranch(lastOverride)[0]
            : program.repository;

        const [targetOwner, targetRepo] = target.split('/');

        if (manifestMaker) {
            manifestMaker.setVersion(version);
            const lastMandatoryUpdateVersion = await readLastMandatoryUpdateVersion(projectDir);
            if (lastMandatoryUpdateVersion &&
                semver.neq(
                    semver.valid(version).replace(/-.*$/, ''),
                    semver.valid(lastMandatoryUpdateVersion).replace(/-.*$/, '')
                ))
            {
                manifestMaker.setOptionalSince(lastMandatoryUpdateVersion);
            }
            // Get correct target repository where the update is published.
            console.log(`Making update manifest`);
            const manifest = await makeUpdaterManifest(
                manifestMaker,
                projectDir,
                targetOwner,
                targetRepo
            );
            if (program.publish) {
                console.log('Uploading update manifest to GitHub release');
                await uploadReleaseAsset(manifest, 'text/plain', targetOwner, targetRepo, version);
            }
        }

        if (program.publish) {
            console.log('Deleting unnecessary files from release');
            await deleteReleaseAssets(FILES_TO_DELETE, targetOwner, targetRepo, version);
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
 * Extracts last mandatory update version from project's package.json.
 * Returns version in "1.0.0" format or null if it's not specified.
 *
 * @param {string} projectDir
 */
function readLastMandatoryUpdateVersion(projectDir) {
    const filename = path.join(projectDir, 'package.json');
    return readFile(filename)
        .then(JSON.parse)
        .then(json => semver.valid(json.lastMandatoryUpdateVersion));
}

/**
 * Creates updater peerio-updater manifest for known dist files in the project
 * directory and returns promise resolving to manifest contents.
 *
 * @param {ManifestMaker} m manifest maker instance
 * @param {string} dir project directory
 * @param {string} owner project owner ("org" from github.com/org/repo)
 * @param {string} repo project repository ("repo" from github.com/org/repo)
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
            } else if (/armv7l\.AppImage$/i.test(name)) {
                platform = 'linux-armv7l';
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
        const buildFlagsEnv = program.prerelease ? 'EP_PRELEASE=true' : 'EP_DRAFT=true';
        const publish = program.publish ? 'always' : 'never';
        const platforms = (program.platforms || 'windows,mac,linux').split(',').map(s => '--' + s.trim()).join(' ');
        const cmds = [
            'NODE_ENV=development npm install',
            'NODE_ENV=production npm run dist',
            `NODE_ENV=production ${buildFlagsEnv} ./node_modules/.bin/build ${platforms} --publish ${publish}`
        ];
        const env = Object.assign({}, process.env, { GH_TOKEN: GITHUB_AUTH_TOKEN });
        if (!program.nosign) {
            env.SHARED_DIR = SHARED_DIR;
            env.SIGNTOOL_TIMEOUT = '432000000'; // 2000 minutes
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
 * @param isLast {boolean} if true, the override is last in the list and versioning will be applied
 * @returns {Promise<string>} version (may change from the given)
 */
async function applyOverrides(overridesRepo, targetDir, version, isLast) {
    let tempDir;
    const [repo, branch] = splitRepoBranch(overridesRepo);
    try {
        tempDir = await makeTempDir();
        await execp(`git clone --depth=1 --branch=${branch} git@github.com:${repo}.git ${tempDir}`, tempDir);
        await override(tempDir, targetDir, {
            jsonOverridesFile: 'json-overrides.json',
            fileOverridesDir: 'file-overrides'
        });
        if (isLast) {
            if (program.versioning) {
                version = await applyCustomVersioning(overridesRepo, targetDir, version);
                console.log(`Custom version: ${version}`)
            }
            if (program.publish) {
                // Tag a new release in overrides repo and push the tag.
                await execp(`git tag ${version}`, tempDir);
                await execp(`git push --tags`, tempDir);
            }
        }
        return version;
    } catch (ex) {
        if (tempDir) rimraf.sync(tempDir);
        criticalError(ex);
    }
}

async function applyCustomVersioning(overridesRepo, targetDir, originalVersion) {
    // Get commit SHA corresponding to branch/tag in the original repo
    const sha = await getCommitSHA(GITHUB_OWNER, GITHUB_REPO, GITHUB_TAG);

    // Get lastest version (tag) of the overrides repo.
    const [overOwner, overRepo] = overridesRepo.split('/');
    let latestOverridesVersion;
    try {
        latestOverridesVersion = await getLatestTag(overOwner, overRepo);
        // Strip everything any extra info, we need just numbers
        // v1.2.3-whatever+yyy -> 1.2.3
        latestOverridesVersion = semver.valid(latestOverridesVersion).replace(/-.*$/, '');
    } catch (e) {
        // TODO: distinguish between no tags and network failure.
        // For now, assume we have no tags in the repo.
        latestOverridesVersion = '0.0.0';
    }

    // If original version is greater than latest overrides version,
    // use original version, otherwise use overrides version with
    // incremented patch number.
    //
    //  Examples:
    //
    //   original : 1.0.0
    //   overrides: 1.0.0
    //    --> new : 1.0.1
    //
    //   or
    //
    //   original : 1.2.0
    //   overrides: 1.0.0
    //     --> new: 1.2.0
    //
    let version;
    if (semver.gt(originalVersion, latestOverridesVersion)) {
        version = semver.valid(originalVersion).replace(/-.*$/, ''); // removing extra info just in case
    } else {
        version = semver.inc(latestOverridesVersion, 'patch');
    }
    if (typeof program.versioning === 'string') {
        // Add custom suffix to version
        version += `-${program.versioning}`;
    }

    // Set this version in package.json in the target dir.
    const packageJSON = path.join(targetDir, 'package.json');
    // Update package.json
    return readFile(packageJSON)
        .then(JSON.parse)
        .then(json => {
            json.version = version;
            json.peerio.commit = sha;
            return json;
        })
        .then(json => JSON.stringify(json, undefined, 2))
        .then(s => writeFile(packageJSON, s))
        // Return version in vX.Y.Z... format
        .then(() => 'v' + version);
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
