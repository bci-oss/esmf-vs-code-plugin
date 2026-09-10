import { defineConfig } from '@vscode/test-cli';

const runId = process.env.VSCODE_TEST_RUN_ID ?? 'default';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	useInstallation: process.env.VSCODE_EXECUTABLE_PATH
		? { fromPath: process.env.VSCODE_EXECUTABLE_PATH }
		: undefined,
	launchArgs: [
		`--user-data-dir=/tmp/extension-vscode-test-user-data-${runId}`,
		`--extensions-dir=/tmp/extension-vscode-test-extensions-${runId}`
	],
});
