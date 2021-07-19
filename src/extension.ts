import * as vscode from 'vscode';
import { spawn } from 'child_process';
import os = require('os');
import path = require('path');
import fs = require('fs');

const fsp = fs.promises;


function output() {
	const self = <(() => vscode.OutputChannel) & { channel?: vscode.OutputChannel }>output;
	if (self.channel) return self.channel;
	return self.channel = vscode.window.createOutputChannel('Yaegi');
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('yaegi', new YaegiDebugConfigurationProvider()));
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('yaegi', new YaegiDebugAdapterDescriptorFactory()));
}

export function deactivate() {
	deleteTempDir();
}

interface LaunchConfiguration extends vscode.DebugConfiguration {
	type: 'yaegi';
	request: 'launch';

	program: string;
	cwd?: string;
	args?: string[];
	env?: { [key: string]: string };

	showProtocolLog?: boolean;
}

class YaegiDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
		if (config.program)
			return config;

		if (Object.keys(config).length > 0 && !config.program)
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return null;
			});

		// launch without configuration
		if (vscode.window.activeTextEditor?.document.languageId != 'go')
			return vscode.window.showInformationMessage("Select a Go file to debug").then(_ => {
				return null;
			});

		return {
			type: 'yaegi',
			name: 'Launch current file',
			request: 'launch',
			program: '${file}',
		};
	}
}

class YaegiDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
	async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor|undefined> {
		const config = session.configuration as LaunchConfiguration;
		const args = [config.program, '--', ...(config.args || [])];
		if (config.showProtocolLog) args.unshift('--log', '-');
		args.unshift('--gopath', '/home/firelizzard/go');

		const exec = '/home/firelizzard/go/bin/yaegi-dbg';
		const socket = await getTempFilePath(`debug-${randomName(10)}.socket`);
		args.unshift('--mode', 'net', '--addr', `unix://${socket}`);

		output().appendLine(`$ ${exec} ${args.join(' ')}`);

		const proc = spawn(exec, args, {
			cwd: config.cwd,
			env: config.env,
			stdio: 'pipe',
		});

		proc.stderr.on('data', b => output().append(b.toString()));

		let stop: () => void;
		const didStop = Symbol('stopped');
		const stopped = new Promise<Symbol>(r => stop = () => r(didStop));

		stopped.then(() => fsp.unlink(socket));

		proc.on('exit', async code => {
			stop();
			vscode.debug.stopDebugging(session);
			output().appendLine(`Exited with code ${code}`);
			if (code) output().show();
		});

		proc.on('error', async (err: any) => {
			stop();
			vscode.debug.stopDebugging(session);
			output().appendLine(`Exited with error ${err}`);
			output().show();
		});

		for (;;) {
			const r = await Promise.race([exists(socket), stopped]);
			if (r == true || r == didStop) break;
			await new Promise(r => setTimeout(r, 10));
		}

		return new vscode.DebugAdapterNamedPipeServer(socket);
	}
}

async function exists(file: string): Promise<boolean> {
    try {
        await fsp.stat(file);
        return true;
    } catch (error) {
        if (error.code && error.code == 'ENOENT')
            return false;
        throw error;
    }
}

let tmpDir: string | undefined;
export async function getTempFilePath(name: string): Promise<string> {
	if (!tmpDir)
		tmpDir = await fsp.mkdtemp(os.tmpdir() + path.sep + 'vscode-yaegi');

	if (!await exists(tmpDir))
		await fsp.mkdir(tmpDir);

	return path.normalize(path.join(tmpDir!, name));
}

export async function deleteTempDir() {
    if (!tmpDir) return;
    if (!await exists(tmpDir)) return;

    await rm(tmpDir);

    async function rm(dir: string) {
        const files = await fsp.readdir(dir);
        await Promise.all(files.map(async (name: string) => {
            const p = path.join(dir, name);
            const stat = await fsp.lstat(p);
            if (stat.isDirectory())
                await rm(p);
            else
                await fsp.unlink(p);
        }));
    }
}

export function randomName(l: number): string {
    let s = '';
    for (let i = 0; i < l; i++)
        s += String.fromCharCode(97 + Math.random() * 26);
    return s;
}
