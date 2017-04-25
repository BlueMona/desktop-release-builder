#!/usr/bin/env node

/**
 * osslsigncode replacement that delegates work to
 * Windows signer, making electron- builder think that
 * it called osslsigncode.
 *
 * NOTE: it doesn't pass any of the options, Windows
 * signer knows better what options to use.
 */

/** Parallels shared directory between Mac and Windows */
// TODO(dchest): make it an environment var?
const SHARED_DIR = process.env.SHARED_DIR;

const fs = require('fs');
const path = require('path');
const { moveFileToDir, criticalError, watchDir } = require('./helpers');

const INPUT_DIR = path.join(SHARED_DIR, 'in');
const OUTPUT_DIR = path.join(SHARED_DIR, 'out');

let IN_FILE;
let OUT_FILE;

// Parse options, extracting -in and -out.
const argv = process.argv;
for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
        case '-in':
            IN_FILE = argv[++i];
            break;
        case '-out':
            OUT_FILE = argv[++i];
            break;
        default:
        // ignore other flags
    }
}

signWindowsExecutable(IN_FILE)
    .then(signedFile => {
        fs.renameSync(signedFile, OUT_FILE);
        console.log('Done');
    })
    .catch(criticalError);


function signWindowsExecutable(filepath) {
    const origname = path.basename(filepath);
    return new Promise((fulfill, reject) => {
        // Watch output directory for changes and resolve as soon as signed
        // .exe file appears there.
        const dispose = watchDir(OUTPUT_DIR, false, (basename) => {
            if (basename === origname) {
                dispose();
                fulfill(path.join(OUTPUT_DIR, basename));
            }
        });

        console.log(`Sending file for signing on Windows ${filepath}`);
        // no need to await here, we don't care what happens next
        moveFileToDir(filepath, INPUT_DIR).catch(criticalError);
    });
}