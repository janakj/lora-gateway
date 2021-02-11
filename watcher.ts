import { watchFile, promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import _ from 'lodash';
import { Lock } from './utils';

const POLL_INTERVAL = 60 * 1000;

const lock = new Lock();


const locked = fn =>
    async (...args) => {
        await lock.acquire()
        try {
            return await fn(...args);
        } finally {
            lock.release()
        }
    }


export default function watch(filenames: string[] | string, send: Function) {
    const f = typeof filenames === 'string' ? [filenames] : _.uniq(filenames);

    for (const filename of f) {
        watchFile(filename, { interval: POLL_INTERVAL }, locked(async stat => {
            try {
                const data = stat.nlink ? (await fs.readFile(filename)).toString('base64') : null;
                try {
                    await send({ filename, data })
                } catch (e) {
                    process.exit();
                }
            } catch (error) {
                process.stderr.write(`Error while reloading '${filename}': ${error.message}\n`);
            }
        }))
    }
}

// This function will be invoked when this module is started as the main module.
// Use the IPC channel established by the parent to communicate. The filenames
// to watch will be given to us on the command line.

function main() {
    if (!process.send)
        throw new Error('Bug: Parent process did not establish an IPC channel');

    process.once('disconnect', () => { process.exit() });
    watch(process.argv.slice(2), promisify(process.send.bind(process)));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
    main();
