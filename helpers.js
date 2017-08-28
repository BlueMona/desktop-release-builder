// @ts-check
// Helper functions and classes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const mkdirp = require('mkdirp');
const { exec } = require('child_process');

// Enqueues a function returning a promise to be run after the currently
// enqueued item finishes.
//
// Optionally keeps a list of already queued names and doesn't enqueue the
// function if the name was already enqueued. (XXX: this keeps filling the list
// for the duration of the process, but it shouldn't eat too much memory for
// our purposes)
class Queue {
    constructor() {
        this.names = {};
        this.tail = null;
    }

    /**
     * Adds item to queue to run it after the current item finishes.
     *
     * Optional unique name can be provided to make sure the same item
     * is not added to the queue more than once.
     *
     * @param fn function
     * @param name (optional) unique name
     */
    add(fn, name) {
        if (name) {
            if (this.names[name]) return; // already queued
        }
        this.tail = this.tail ? this.tail.then(fn) : fn();
    }
}

/**
 * Logs error and terminate the process.
 * @param err error
 */
function criticalError(err) {
    console.error(err);
    process.exit(666);
}

/**
 * Moves file to the destination directory,
 * returning a promise with the new file path.
 *
 * @param filepath source filename
 * @param destDir destination directory
 */
function moveFileToDir(filepath, destDir) {
    return new Promise((fulfill, reject) => {
        const newpath = path.join(destDir, path.basename(filepath));
        fs.rename(filepath, newpath, err => {
            if (err) return reject(err);
            fulfill(newpath);
        });
    });
}

/**
 * Creates a temporary directory and
 * returns a promise with its path.
 */
function makeTempDir() {
    return new Promise((fulfill, reject) => {
        fs.mkdtemp(path.join(os.tmpdir(), 'peerio-builder-'), (err, folder) => {
            if (err) return reject(err);
            fulfill(folder);
        });
    });
}

/**
 * Polls directory for new files.
 *
 * This miserable polling thing is used on Windows because in Parallels shared
 * folders fs.watch() doesn't work and it doesn't seem like they're working on
 * fixing it, judging by this thread from 2014:
 *
 * https://forum.parallels.com/threads/readdirectorychangesw-and-hidden-message-prl_fs-buggy-apps-exceed-buffers.317877/
 *
 * @param path directory path to watch
 * @param fireInitially fire callback for each file initially present in the directory
 * @param cb callback (filename: string)
 * @returns function that disposes of the watcher when called
 */
function watchDir(dir, fireInitially, cb) {
    let prevFiles = fireInitially ? {} : null;
    let cancelled = false;

    function checkForChanges() {
        fs.readdir(dir, (err, files) => {
            if (err) throw err;
            const curFiles = {};
            const promises = files.map(filename => new Promise((fulfill, reject) => {
                fs.stat(path.join(dir, filename), (err, stats) => {
                    if (err) {
                        // file probably disappeared, ignore it.
                        fulfill();
                    }
                    if (stats.isFile()) {
                        // Add file
                        curFiles[filename] = true;
                    }
                    fulfill();
                });
            }));
            Promise.all(promises).then(() => {
                if (prevFiles) {
                    // Compare cur to prev.
                    Object.keys(curFiles).forEach(filename => {
                        if (!prevFiles[filename]) {
                            // New file appeared, notify.
                            setImmediate(() => { cb(filename); });
                            return;
                        }
                    });
                }
                // Switch prev to cur
                prevFiles = curFiles;
                // Schedule next check.
                if (!cancelled) setTimeout(checkForChanges, 1000);
            })
                .catch(err => {
                    console.log(`Error watching directory: ${err}`);
                });
        });
    }

    checkForChanges();
    return () => {
        cancelled = true;
    };
}

/**
 * Executes command, returns a promise resolving to stdout string,
 * or rejects with error.
 *
 * @param {string} command
 * @param {string} cwd working directory
 * @param {boolean} log log output and errors (true by default)
 */
function execp(command, cwd, log = true) {
    return new Promise((fulfill, reject) => {
        exec(command, { cwd, env: process.env }, (err, stdout, stderr) => {
            if (err) {
                if (log) console.log(stderr);
                reject(err);
            } else {
                if (log) console.log(stdout);
                fulfill(stdout);
            }
        })
    })
}

/**
 * Returns a promise resolving to filenames in dir matching
 * the given regex (if no regex given, returns all filenames)
 *
 * @param {string} dir path
 * @param {RegExp} [rx] optional regexp
 * @returns Promise<Array<string>>
 */
function getFileNames(dir, rx) {
    return new Promise((fulfill, reject) => {
        const out = [];
        fs.readdir(dir, (err, names) => {
            if (err) return reject(err);
            if (!rx) return fulfill(names);
            fulfill(names.filter(n => rx.test(n)));
        });
    });
}

/**
 * Writes data to file.
 * Creates parent directories for file if they don't exist.
 *
 * @param {string} filename
 * @param {any} data
 * @returns {Promise<string>} filename
 */
function writeFile(filename, data) {
    return new Promise((fulfill, reject) => {
        mkdirp(path.dirname(filename), err => {
            if (err) return reject(err);
            fs.writeFile(filename, data, err => {
                if (err) return reject(err);
                fulfill(filename);
            });
        });
    });
}

/**
 * Reads the contents of file.
 *
 * @param {string} filename
 * @param {string} [encoding]
 * @returns Promise<string | Buffer>
 */
function readFile(filename, encoding) {
    return new Promise((fulfill, reject) => {
        fs.readFile(filename, encoding, (err, data) => {
            if (err) return reject(err);
            fulfill(data);
        });
    });
}

module.exports = {
    Queue,
    criticalError,
    moveFileToDir,
    makeTempDir,
    watchDir,
    execp,
    getFileNames,
    writeFile,
    readFile
};
