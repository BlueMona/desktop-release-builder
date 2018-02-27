// @ts-check
const path = require('path');
const semver = require('semver-extra');
const GitHubAPI = require('github');
const download = require('download');

const github = new GitHubAPI({
    protocol: "https",
    host: "api.github.com",
    headers: {
        "user-agent": "peerio-release-builder"
    }
});

let authToken = '';

function authenticate(token) {
    authToken = token;
    github.authenticate({
        type: "token",
        token
    });
}

// A helper to fetch all data from multi-page GitHub API responses.
function getAllResults(res) {
    if (!github.hasNextPage(res)) {
        return res.data;
    }
    return github.getNextPage(res).then(getAllResults).then(r => res.data.concat(r));
}

/**
 * Downloads a ZIP of a tag from GitHub repository
 * and extracts it to the destination folder.
 *
 * @param owner organization name, e.g. PeerioTechnologies
 * @param repo project name, e.g. peerio-desktop
 * @param tag repo tag, e.g. v2.4.0
 * @param dest destination folder
 * @returns Promise<string> extracted directory name
 */
function downloadTagArchive(owner, repo, tag, dest) {
    const url = `https://github.com/${owner}/${repo}/archive/${tag}.zip`;
    return download(url, dest, {
        extract: true,
        auth: `${owner}:${authToken}`
    }).then(files => {
        // First file is supposed to be directory name.
        return path.join(dest, files[0].path);
    });
}


/**
 * Upload an asset to release.
 *
 * @param {string} filePath asset file path
 * @param {string} owner project owner ("org" from github.com/org/repo)
 * @param {string} repo project repository ("repo" from github.com/org/repo)
 * @param {string} tag git tag
 * @returns Promise<void>
 */
async function uploadReleaseAsset(filePath, owner, repo, tag) {
    // Can't get release by tag name, because draft releases are
    // not assigned to any tag. Thus we fetch one page of releases,
    // hoping that the one we publish is in there, and lookup release id
    // by tag_name.
    const name = path.basename(filePath); // TODO: sanitize for GitHub
    const releases = await github.repos.getReleases({ owner, repo }).then(getAllResults);
    for (let i = 0; i < releases.length; i++) {
        // I think there can be multiple draft releases assigned to
        // the same tag (until they are published), so we want to
        // upload this asset to all of them, since we don't know which
        // one was created by the current run of electron-builder.
        const { tag_name, id } = releases[i];
        if (tag_name === tag) {
            console.log(`Uploading ${name} to release (tag=${tag_name}, id = ${id})`);
            await github.repos.uploadAsset({ owner, repo, id, filePath, name });
        }
    }
}

/**
 * Deletes assets (files) matching the given RegExp from the release.
 *
 * @param {RegExp} nameRegexp regex to match asset name for deletion
 * @param {string} owner
 * @param {string} owner project owner ("org" from github.com/org/repo)
 * @param {string} repo project repository ("repo" from github.com/org/repo)
 * @param {string} tag git tag
 * @returns Promise<void>
 */
async function deleteReleaseAssets(nameRegexp, owner, repo, tag) {
    const releases = await github.repos.getReleases({ owner, repo }).then(getAllResults);
    for (let i = 0; i < releases.length; i++) {
        // I think there can be multiple draft releases assigned to
        // the same tag (until they are published), so we want to
        // delete this asset from all of them, since we don't know which
        // one was created by the current run of electron-builder.
        const { tag_name, id, assets } = releases[i];
        if (tag_name !== tag) {
            continue;
        }
        for (let j = 0; j < assets.length; j++) {
            const file = assets[j];
            if (nameRegexp.test(file.name)) {
                console.log(`Deleting ${file.name} from release (tag=${tag_name}, id = ${id})`);
                await github.repos.deleteAsset({ owner, repo, id: file.id });
            }
        }
    }
}

/**
 * Returns a list of tags.
 *
 * @param owner
 * @param repo
 */
function fetchTags(owner, repo) {
    return github.gitdata.getTags({ owner, repo })
        .then(getAllResults)
        .then(tags => tags.map(info => info.ref.replace('refs/tags/', '')));
}

/**
 * Return latest tag for project (according to semver)
 * @param owner
 * @param repo
 */
function getLatestTag(owner, repo) {
    return fetchTags(owner, repo)
        .then(versions => versions.filter(v => semver.valid(v)))
        .then(versions => 'v' + semver.valid(semver.max(versions)));
}

/**
 * Returns commit SHA corresponding to the given tag or branch.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} tagOrBranch
 */
function getCommitSHA(owner, repo, tagOrBranch) {
    // GitHub requires different requests depending on whether we want
    // info on tag or branch. We first try branch, then if it fails, try tag.
    return github.gitdata.getReference({ owner, repo, ref: `heads/${tagOrBranch}` })
        .catch(() => github.gitdata.getReference({ owner, repo, ref: `tags/${tagOrBranch}` }))
        .then(res => {
            const sha = res.data.object.sha;
            if (!sha) throw new Error('SHA for ref not found');
            return sha;
        });
}



module.exports = {
    authenticate,
    downloadTagArchive,
    uploadReleaseAsset,
    deleteReleaseAssets,
    getLatestTag,
    getCommitSHA
};
