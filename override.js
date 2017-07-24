// @ts-check
/**
 * Overrides JSON values and files.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const merge = require('lodash/merge');
const copy = require('recursive-copy');

if (require.main === module) {
    // Launched as an executable.
    const program = require('commander');

    program
        .usage('--overrides <dir> --target <dir>')
        .option('-o --overrides <dir>', 'Directory with overrides')
        .option('-t --target <dir>', 'Target directory (with a copy of Peerio Desktop sources to merge into)')
        .parse(process.argv);

    if (!program.overrides || !program.target) {
        program.outputHelp();
        process.exit(1);
    }

    const SRC_DIR = program.overrides;
    const DST_DIR = program.target;

    override(SRC_DIR, DST_DIR)
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

function override(srcDir, dstDir) {
    // Merge json overrides.
    let jsonOverridesPath = path.join(srcDir, 'json-overrides.json');
    if (jsonOverridesPath[0] !== "/") {
        jsonOverridesPath = "./" + jsonOverridesPath;
    }
    const jsonOverrides = require(jsonOverridesPath);
    Object.keys(jsonOverrides).forEach(filename => {
        const filepath = path.join(dstDir, filename);
        const target = JSON.parse(fs.readFileSync(filepath, "utf8"));
        merge(target, jsonOverrides[filename]);
        fs.writeFileSync(filepath, JSON.stringify(target, null, "  "));
        console.log(`JSON merged: ${filename}`)
    });

    // Merge file trees.
    const fileOverridesPath = path.join(srcDir, 'file-overrides');
    return copy(fileOverridesPath, dstDir, {
        overwrite: true,
        dot: true
    }).then(results => {
        results.forEach(name => {
            console.log(`File copied: ${path.basename(name.dest)}`);
        });
    });
}

module.exports = {
    override
};
