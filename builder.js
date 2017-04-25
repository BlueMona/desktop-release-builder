/**
 * Fetches project from GitHub, builds it, creates draft GitHub release and
 * uploads binaries there.
 *
 * Delegates signing to Windows running in Parallels, by putting the build
 * products to sign into a shared folder.
 *
 * Must be run on macOS.
 *
 * Usage:
 *
 *  export GH_TOKEN=<...github auth token...>
 *  node builder.js SHARED_DIR ORG/REPO [TAG]
 *
 * If not tag is given, the greatest one (according to semver) is built.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const semver = require('semver-extra');
const rimraf = require('rimraf');
const download = require('download');

const { makeTempDir, criticalError } = require('./helpers');

// Check command-line arguments.
if (process.argv.length < 4) {
    console.error('Usage: node builder.js SHARED_DIR ORG/REPO [TAG]');
    process.exit(1);
}

// Get input and output directory.
const SHARED_DIR = process.argv[2];
const INPUT_DIR = path.join(SHARED_DIR, 'in');
const OUTPUT_DIR = path.join(SHARED_DIR, 'out');
const [GITHUB_OWNER, GITHUB_REPO] = process.argv[3].split('/');
let GITHUB_TAG = process.argv[4];

const GITHUB_AUTH_NAME = GITHUB_OWNER;
const GITHUB_AUTH_TOKEN = process.env.GH_TOKEN;

if (!GITHUB_AUTH_TOKEN) {
    console.error(
        'Please set GH_TOKEN environment variable to the correct GitHub ' +
        'authentication token that has access to the given project'
    );
    process.exit(2);
}

// Check that directories exist.
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

main();

async function main() {
    let sourceTempDir;

    try {
        if (!GITHUB_TAG) {
            GITHUB_TAG = await getLatestGithubTag(GITHUB_OWNER, GITHUB_REPO);
        }

        // Create temporary directory for source and build files.
        sourceTempDir = await makeTempDir();

        console.log(`Downloading release ${GITHUB_TAG}...`);
        const projectDir = await downloadGitHubTag(GITHUB_OWNER, GITHUB_REPO, GITHUB_TAG, sourceTempDir);

        console.log(`Building release in ${projectDir}`);
        await buildRelease(projectDir, GITHUB_TAG);

    } catch (ex) {
        criticalError(ex);
    } finally {
        if (sourceTempDir) rimraf.sync(sourceTempDir);
    }
}

/**
 * Downloads a ZIP of a tag from GitHub repository
 * and extracts it to the destination folder.
 *
 * @param organization organization name, e.g. PeerioTechnologies
 * @param project project name, e.g. peerio-desktop
 * @param tag repo tag, e.g. v2.4.0
 * @param dest destination folder
 * @returns Promise<string> extracted directory name
 */
function downloadGitHubTag(organization, project, tag, dest) {
    const url = `https://github.com/${organization}/${project}/archive/${tag}.zip`;
    return download(url, dest, {
        extract: true,
        auth: `${GITHUB_AUTH_NAME}:${GITHUB_AUTH_TOKEN}`
    }).then(files => {
        // First file is supposed to be directory name.
        return path.join(dest, files[0].path);
    });
}

/**
 * Writes data to file, returning a promise.
 */
function writeFile(file, data) {
    return new Promise((fulfill, reject) => {
        fs.writeFile(file, data, err => {
            if (err) return reject(err);
            fulfill(file);
        });
    });
}

/**
 * Builds release in the project directory.
 * @param dir project directory
 * @returns Promise<void>
 */
function buildRelease(dir, tag) {
    return new Promise((fulfill, reject) => {
        const buildFlags = tag.includes('-') ? '--prerelease' : '';
        let cmds = [
            'NODE_ENV=development npm install',
            'NODE_ENV=production npm run compile',
            `NODE_ENV=production ./node_modules/.bin/build --windows --x64 --mac --linux --publish always --draft ${buildFlags}`
        ];
        const builder = spawn('sh', ['-c', cmds.join(' && ')], {
            cwd: dir,
            env: Object.assign({}, process.env, {
                SHARED_DIR: SHARED_DIR,
                SIGNTOOL_PATH: path.join(__dirname, 'osslsigncode.js'),
                WIN_CSC_LINK: 'ignore', // any string is needed to trick builder into performing Windows codesigning
                GH_TOKEN: GITHUB_AUTH_TOKEN
            })
        });
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
 * Returns a list of tags from github project.
 *
 * @param organization
 * @param project
 */
function fetchGithubTags(organization, project) {
    return new Promise((fulfill, reject) => {
        https.get({
            protocol: 'https:',
            hostname: 'api.github.com',
            path: `/repos/${organization}/${project}/git/refs/tags`,
            headers: {
                'User-Agent': 'peerio-builder'
            },
            auth: `${GITHUB_AUTH_NAME}:${GITHUB_AUTH_TOKEN}`
        }, res => {
            let rawData = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { rawData += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Failed to fetch tags: ${res.statusCode}: ${res.statusMessage}\n${rawData}`));
                    return;
                }
                const data = JSON.parse(rawData);
                fulfill(data.map(info => info.ref.replace('refs/tags/', '')));
            });
        }).on('error', err => {
            reject(err);
        });
    });
}

/**
 * Return latest tag for project (according to semver)
 * @param organization
 * @param project
 */
function getLatestGithubTag(organization, project) {
    return fetchGithubTags(organization, project)
        .then(tags => tags.map(t => t.substring(1)))
        .then(versions => 'v' + semver.max(versions));
}