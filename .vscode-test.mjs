import {defineConfig} from '@vscode/test-cli';

const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
const runSuffix = process.env.VSCODE_TEST_RUN_ID?.replace(/[^a-zA-Z0-9_-]/g, '-');
const testDirectorySuffix = runSuffix ? `-${runSuffix}` : '';

export default defineConfig({
    files: 'out/test/**/*.test.js',
    ...(vscodeExecutablePath ? {useInstallation: {fromPath: vscodeExecutablePath}} : {}),
    launchArgs: [
        `--user-data-dir=/tmp/extension-vscode-test-user-data${testDirectorySuffix}`,
        `--extensions-dir=/tmp/extension-vscode-test-extensions${testDirectorySuffix}`,
    ],
});
