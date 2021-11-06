import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import _ from 'lodash';
import { parseNumber } from '@janakj/lib/parse';
import * as defaults from './defaults';


export default function watch(filenames: string[] | string, send: (msg: any) => Promise<void>) {
    const interval = parseNumber(process.env.CERTIFICATE_CHECK_INTERVAL
        || defaults.CERTIFICATE_CHECK_INTERVAL, 1);
    const f = typeof filenames === 'string' ? [filenames] : _.uniq(filenames);

    const current: Record<string, string> = {};
    for(const filename of f)
        current[filename] = readFileSync(filename, 'hex');

    setInterval(function() {
        void (async function() {
            for(const filename of f) {
                try {
                    const data = readFileSync(filename, 'hex');
                    if (data !== current[filename]) {
                        try {
                            await send({ filename, data });
                        } catch(e) {
                            process.exit();
                        }
                        current[filename] = data;
                    }
                } catch(error: any) {
                    process.stderr.write(`Error while reading ${filename}: ${error.message}`);
                }
            }
        })();
    }, interval);
}

// This function will be invoked when this module is started as the main module.
// Use the IPC channel established by the parent to communicate. The filenames
// to watch will be given on the command line.

function main() {
    if (!process.send)
        throw new Error('Bug: Parent process did not establish an IPC channel');

    process.once('disconnect', () => { process.exit(); });

    try {
        watch(process.argv.slice(2), promisify(process.send.bind(process)));
    } catch(error: any) {
        process.stderr.write(`Error in watcher: ${error.message}`);
        process.exit();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
    main();
