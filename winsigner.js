#!/usr/bin/env node

/**
 * Windows signer service.
 *
 * Waits for a file to sign to appear in the shared folder, then signs this
 * file, and moves it into the output folder.
 *
 * If the given certificate name ends with .pfx, it's considered a certificate
 * file, if not, it's a name of certificate from certs store.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Queue, moveFileToDir, watchDir, criticalError } = require('./helpers');
const program = require('commander');

if (process.platform !== 'win32') {
    console.error('Run this program on Windows');
    process.exit(1);
}

program
    .usage('--shared <dir> [--certificate <name>]')
    .option('-s --shared <dir>', 'Shared directory between macOS and Windows')
    .option('-c --certificate [name]', 'Certificate name (or file name ending with .pfx)')
    .parse(process.argv);

if (!program.shared) {
    program.outputHelp();
    process.exit(1);
}

console.log('Windows signing service started.')

// Get input and output directory.
const SHARED_DIR = program.shared;
const INPUT_DIR = path.join(SHARED_DIR, 'in');
const OUTPUT_DIR = path.join(SHARED_DIR, 'out');
const CERT_NAME = program.certificate;

// Find sign tool.
const signTool = findSignToolBinary();

// Create directories if they don't exist.
try {
    fs.mkdirSync(INPUT_DIR);
} catch (ex) {
    if (ex.code !== 'EEXIST') criticalError(ex);
}
try {
    fs.mkdirSync(OUTPUT_DIR);
} catch (ex) {
    if (ex.code !== 'EEXIST') criticalError(ex);
}

const fileQueue = new Queue();

// Watch input directory for changes and proceed
// with signing if .exe file is detected.
watchDir(INPUT_DIR, true, basename => {
    console.log(`DEBUG: File appeared: ${basename}`);
    if (path.extname(basename) === '.exe') {
        // Make sure the file exists, since 'rename' event also fires for removals.
        const filepath = path.join(INPUT_DIR, basename);
        // TODO: maybe need to move this file into a temporary directory for signing.
        fs.access(filepath, fs.constants.R_OK, err => {
            if (!err) fileQueue.add(() => handleFile(filepath), filepath);
        });
    }
});

console.log(`Watching ${INPUT_DIR} for changes...`);

/**
 * Signs the given file and moves the result to output directory.
 * @param filepath executable file path
 */
function handleFile(filepath) {
    console.log(`Signing ${filepath}...`);
    return signFile(filepath)
        .then(() => moveFileToDir(filepath, OUTPUT_DIR))
        .then(outpath => console.log(`Done ${outpath}.`))
        .catch(err => console.error(`ERROR ${filepath}: ${err}`));
}

/**
 * Signs file with signtool.
 *
 * @param filepath executable file path
 * @returns Promise<string> signed file path
 */
function signFile(filepath) {
    return new Promise((fulfill, reject) => {
        const args = [
            'sign',
            '/tr', 'http://timestamp.digicert.com',
            '/td', 'sha256',
            '/fd', 'sha256'
        ];
        if (CERT_NAME) {
            if (path.extname(CERT_NAME) === '.pfx') {
                // Certificate file
                args.push('/f');
            } else {
                // Certificate name
                args.push('/n');
            }
            args.push(CERT_NAME)
        } else {
            args.push('/a');
        }
        args.push(filepath);
        execFile(signTool, args, (err, stdout, stderr) => {
            if (err) return reject(err);
            console.log(stdout);
            console.error(stderr);
            fulfill(filepath);
        });
    });
}

/**
 * Returns path to signtool.exe.
 * Exits the process with error if it's not found.
 *
 * @returns string
 */
function findSignToolBinary() {
    const candidates = [
        "c:\\Program Files (x86)\\Windows Kits\\10\\bin\\x64\\signtool.exe",
        "c:\\Program Files (x86)\\Windows Kits\\10\\bin\\x86\\signtool.exe",
		"c:\\Program Files (x86)\\Windows Kits\\10\\App Certification Kit\\signtool.exe"
    ];
    for (let i = 0; i < candidates.length; i++) {
        try {
            fs.accessSync(candidates[i]);
            return candidates[i]; // found!
        } catch(ex) {
            continue;
        }
    }
    criticalError('ERROR: signtool.exe not found, please install Windows 10 SDK.');
}
