const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const merge = require('lodash/merge');
const { ncp } = require('ncp');

if (require.main === module) {
    // Launched as an executable.

    // Check command-line arguments.
    if (process.argv.length < 3) {
        console.error('Usage: node override OVERRIDES_DIR DEST_DIR');
        process.exit(1);
    }

    const SRC_DIR = process.argv[2];
    const DST_DIR = process.argv[3];

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
    return new Promise((fulfill, reject) =>
        ncp(fileOverridesPath, dstDir, {
            clobber: true,
            stopOnErr: true,
            filter: filepath => {
                const name = path.relative(fileOverridesPath, filepath);
                if (name) {
                    // XXX: will also print directory names
                    console.log(`File copied: ${name}`);
                }
                return true;
            }
        }, err => {
            if (err) return reject(err);
            fulfill();
        })
    );
}

module.exports = override;
