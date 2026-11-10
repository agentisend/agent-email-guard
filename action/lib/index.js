/**
 * GitHub Action entry. Node 20 runs lib/index.js. Inputs arrive as INPUT_* env vars.
 * Annotations are workflow commands. The process exits 1 only when fail is true and a send is unguarded.
 * Nothing in this file opens a socket.
 */
import { existsSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepo } from './scan.js';
const MAX_ANNOTATIONS = 200;
export function run(env, stdout, stderr) {
    const fail = /^(1|true|yes)$/i.test(readInput(env, 'fail', 'false'));
    const scopeRaw = readInput(env, 'scope', 'agent');
    if (scopeRaw !== 'agent' && scopeRaw !== 'all') {
        stderr(`scope must be "agent" or "all", got ${scopeRaw}\n`);
        return 1;
    }
    const scope = scopeRaw;
    const workspace = env['GITHUB_WORKSPACE'] !== undefined && env['GITHUB_WORKSPACE'].trim() !== ''
        ? resolve(env['GITHUB_WORKSPACE'])
        : process.cwd();
    const root = resolve(workspace, readInput(env, 'path', '.'));
    if (!existsSync(root) || !statSync(root).isDirectory()) {
        stderr(`path must be a directory: ${root}\n`);
        return 1;
    }
    const findings = scanRepo(root, { scope });
    const level = fail ? 'error' : 'warning';
    const shown = findings.slice(0, MAX_ANNOTATIONS);
    for (const finding of shown) {
        const rel = toPosix(relative(workspace, resolve(root, finding.file)));
        stdout(`::${level} file=${escapeProp(rel)},line=${finding.line},col=${finding.column},title=agent-email-guard::${escapeMessage(finding.message)}\n`);
    }
    if (findings.length === 0) {
        stdout('agent-email-guard: no unguarded email send.\n');
        return 0;
    }
    const extra = findings.length > shown.length ? ` Showing ${shown.length} annotations.` : '';
    const mode = fail ? 'The check fails.' : 'Annotations are warnings. Set fail to true to exit 1.';
    const noun = findings.length === 1 ? 'send' : 'sends';
    stdout(`agent-email-guard: ${findings.length} unguarded email ${noun}.${extra} ${mode}\n`);
    return fail ? 1 : 0;
}
function readInput(env, name, fallback) {
    const value = env[`INPUT_${name.toUpperCase()}`];
    if (value === undefined || value.trim() === '')
        return fallback;
    return value.trim();
}
function escapeMessage(value) {
    return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProp(value) {
    return escapeMessage(value).replace(/,/g, '%2C').replace(/:/g, '%3A');
}
function toPosix(path) {
    return sep === '/' ? path : path.split(sep).join('/');
}
const entry = process.argv[1] !== undefined ? resolve(process.argv[1]) : '';
if (entry !== '' && fileURLToPath(import.meta.url) === entry) {
    process.exit(run(process.env, (chunk) => process.stdout.write(chunk), (chunk) => process.stderr.write(chunk)));
}
