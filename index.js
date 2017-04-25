// Lauch the correct script depending on current platform.
switch (process.platform) {
case 'win32':
    require('./winsigner');
    break;
case 'darwin':
    require('./builder');
    break;
default:
    console.error('Run this program on macOS (for macOS, Windows, Linux builder)' +
                  ' or Windows (for Windows signer)');
    process.exit(1);
}
