import { defineConfig } from '@vscode/test-cli';

const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;

export default defineConfig({
	files: 'out/test/**/*.test.js',
	...(vscodeExecutablePath ? { useInstallation: { fromPath: vscodeExecutablePath } } : {}),
	launchArgs: [
		'--user-data-dir=/tmp/extension-vscode-test-user-data',
		'--extensions-dir=/tmp/extension-vscode-test-extensions'
	],
});
